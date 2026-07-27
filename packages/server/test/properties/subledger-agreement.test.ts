import type { Aging, AgingBucket, DocumentLineInput } from '@openbooks/shared-types';
import { AGING_BUCKETS } from '@openbooks/shared-types';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { RequestContext } from '../../src/context';
import { getBill, getVendorCredit } from '../../src/modules/bills';
import {
  approveInvoice,
  createInvoice,
  getCreditNote,
  getInvoice,
} from '../../src/modules/invoices';
import { allocatePayment, getPayment, recordPayment } from '../../src/modules/payments';
import { getAccountBalances } from '../../src/modules/reports';
import type { SubledgerSide } from '../../src/modules/settings';

import type { MaterializedSubledger } from './subledger-arbitraries';
import { materialize, planWithAsOfArb } from './subledger-arbitraries';
import {
  SUBLEDGER_SIDES,
  agingAt,
  controlAccountOf,
  controlBalance,
  createSubledgerScene,
  dateAfterEpoch,
  daysBetween,
  signedFor,
  useSubledgerDatabase,
  withContext,
} from './subledger-support';

/**
 * **The subledger agrees with the ledger** (OB-071; spec §11, M3 C2 and C8).
 *
 * Spec §11 named subledger agreement as an invariant in M1 and deferred it with "no
 * subledger exists until M3". One exists now, and this file is that test arriving.
 *
 * Three properties, and the first two are the milestone's whole point:
 *
 *  1. **C2 — outstanding equals the control account, at any date.** Aging as at
 *     `asOf` totals to what the control account holds at `asOf`, on both sides, with
 *     the sign flipped on the payables side because a payable is credit-normal.
 *  2. **C8 — the buckets, not merely the total.** Every detail row's bucket is
 *     re-derived here from its due date, the rows sum to the bucket they were put
 *     in, and the buckets sum to the report's own total. A report that put every
 *     document in `current` ties in total and is wrong in every column.
 *  3. **C2 through the documents rather than through the report.** The same
 *     identity, with the subledger side assembled from what each document says
 *     about itself — `settlement.outstanding` on an invoice, what is left on a
 *     credit note, what is unapplied on a payment. Two independent derivations of
 *     "outstanding" both tying to one ledger figure is a stronger statement than
 *     either alone, and it is the number a user actually reads: the invoice page
 *     says what is owed on that invoice, and it must add up to the same books.
 *
 * ## The discipline the ledger side is under
 *
 * `controlBalance` reads `getAccountBalances({ to: asOf }, ctx, { accountIds: [id] })`
 * and takes `closing.balance`. Nothing about a document, an allocation or a payment
 * reaches it. That is not fastidiousness: a "ledger side" computed from the
 * subledger — or from a helper shared with the subledger side — proves that a number
 * equals itself, and this project has already shipped a property that compared both
 * sides through the same filter and was blind to extra rows.
 *
 * ## What forces these to bite
 *
 * `subledger-arbitraries.ts` states it in full. In short: both sides on shared
 * contacts, multi-line documents over two accounts and two tax rates, both tax
 * modes, drafts, voids dated after the document, over- and under-payments,
 * allocations dated after the payment, voided payments whose allocations are
 * deleted, and an `asOf` drawn three times in four from the plan's own as-at and
 * bucket boundaries.
 */
const harness = useSubledgerDatabase();

/**
 * 14 runs for the two as-at properties, 10 for the document sweep.
 *
 * A run builds a fresh org — chart, four tax rates, three contacts, three years of
 * periods — and then puts four to eight documents through create, approve and
 * sometimes void, plus up to four payments and three credit applications, every one
 * of them a real service call posting a real journal. Measured at roughly 1.1s per
 * run on the shared container, so these three properties are about 40s between
 * them. Variety comes from the generator rather than the count: every run varies the
 * fiscal year's start month, the mix of sides, the tax modes, the rates, which
 * documents are drafts and which are voided, and where `asOf` falls relative to
 * every boundary in the plan.
 *
 * The document sweep is lower because it reads every document individually — one
 * service call per document per run — and it asserts an identity the first property
 * already covers at one date rather than at a generated one.
 */
const RUNS = 14;
const DOCUMENT_RUNS = 10;

/**
 * A longer timeout, for `cross-report.test.ts`'s measured reason.
 *
 * A shrink attempt here is not a re-evaluation of a pure function: it is a fresh
 * org, a chart, four tax rates, three years of periods and a dozen documents put
 * through the write path. That file records a real failure that ran past the
 * project's 30s default and reported as a *timeout* — the counterexample found and
 * then thrown away, which is the least useful thing a property test can say. These
 * runs are more expensive than those, so the budget is larger. It only applies when
 * something is already wrong.
 */
const SHRINKING_BUDGET_MS = 300_000;

/** After every date any generator can produce, for the as-of-now derivations. */
const AFTER_EVERYTHING = dateAfterEpoch(500);

describe('the subledger agrees with the ledger (OB-071, C2, D-34, D-40)', () => {
  it(
    'totals to the control account at any date, on both sides',
    async () => {
      let nonZeroRuns = 0;

      await fc.assert(
        fc.asyncProperty(planWithAsOfArb, async ({ plan, asOf }) => {
          const ledger = await materialize(harness, plan);
          const { ctx } = ledger.scene;

          for (const side of SUBLEDGER_SIDES) {
            const control = await controlBalance(ctx, controlAccountOf(ledger.scene, side), asOf);
            const aging = await agingAt(ctx, side, asOf);

            // The headline, and the whole of spec §11's deferred invariant. The two
            // figures are computed by different files over different tables: the
            // control balance is an aggregation of `journal_lines` bounded by
            // `entry_date`, and the aging total is an aggregation of documents and
            // allocations bounded by three separate date predicates. Nothing but
            // this makes them the same number.
            expect(BigInt(aging.totals.total), `${side} at ${asOf}`).toBe(signedFor(side, control));

            if (control !== 0n) nonZeroRuns += 1;
          }

          // Per contact as well as in total, because a total can tie while two
          // contacts' rows are individually wrong by offsetting amounts — which is
          // precisely what a cross-contact allocation would produce, and what
          // `assertSameContact` exists to prevent. The ledger side is the control
          // account narrowed to the contact, which is a filter the report core
          // applies to `journal_lines.contact_id`; every line a payment or a
          // document posts to a control account carries one.
          for (const side of SUBLEDGER_SIDES) {
            const aging = await agingAt(ctx, side, asOf);
            for (const row of aging.rows) {
              const control = await contactControlBalance(ledger, side, row.contactId, asOf);
              expect(BigInt(row.amounts.total), `${side}/${row.contactName} at ${asOf}`).toBe(
                signedFor(side, control),
              );
            }
          }
        }),
        { numRuns: RUNS },
      );

      // Both sides of every run holding nothing would satisfy everything above by
      // agreeing that zero is zero. The generator posts at least four documents, so
      // this is a guard rather than a hope — but it is the guard that would have
      // caught a materializer whose approvals all silently failed.
      expect(nonZeroRuns).toBeGreaterThan(RUNS);
    },
    SHRINKING_BUDGET_MS,
  );
});

/**
 * The counterexample the property above found, reduced by hand (OB-071 finding 1).
 *
 * **These two fail, and they are the ticket's finding rather than a test to fix.**
 * They are kept beside the property because a shrunk fast-check counterexample is a
 * 60-second run and a JSON blob, and the defect is one line of SQL: `allocatedTotal`
 * and `allocatedPayment` in `aging.repository.ts` bound an allocation by
 * `allocated_on <= asOf` and never ask whether the document at the *other* end of
 * that allocation was in the ledger at `asOf`.
 *
 * The file header of `aging.repository.ts` states the as-at rule as three date
 * predicates. There is a fourth, and it is missing: an allocation may only be
 * counted when **both** ends of it have posted. Without it an allocation is applied
 * to one side of a pair while the other side is filtered out of the report, and the
 * subledger and the control account disagree by exactly the allocated amount.
 *
 * Both directions are reachable through the ordinary flow, because an allocation's
 * date defaults to the *source's* date and a source routinely predates its target:
 *
 *  - **A — a deposit applied to an invoice raised later.** The customer pays in
 *    January, the invoice is raised in February, and the January payment is applied
 *    to it. `allocatePayment` is called with no `date` at all, so `allocated_on` is
 *    the payment's own January date. Aging as at 22 February excludes the invoice
 *    (its journal is dated the 23rd) and still counts the allocation against the
 *    payment, so the payment reads as fully applied. The report says the customer
 *    owes nothing; the control account says they are holding £100 of credit.
 *  - **B — a credit note raised after the invoice it credits, back-dated.** The
 *    invoice is excluded from nothing, but its `allocated` picks up an allocation
 *    whose credit note has not posted yet. The invoice reads as settled while the
 *    ledger still carries it.
 *
 * The two are one defect and one fix. Both are also *silent*: nothing throws, the
 * report is internally consistent, and the only thing that notices is a comparison
 * with the ledger — which is precisely why spec §11 made this an invariant.
 */
describe('OB-071 FINDING: an allocation counts before the document it settles has posted', () => {
  it('drops a credit note’s allocation, and a payment’s, ahead of the counterparty', async () => {
    const scene = await createSubledgerScene(harness, { startMonth: 4, contacts: 1 });
    const { ctx } = scene;
    const contactId = scene.contacts[0];
    if (contactId === undefined) throw new Error('The scene was built with no contacts.');

    const line = (accountId: string): { lines: DocumentLineInput[] } => ({
      lines: [{ description: 'Work', quantity: '1', unitAmount: '10000', accountId }],
    });

    // A — the deposit. The invoice posts on the 23rd, the payment on the 5th, and
    // the allocation takes the payment's date because no date is given.
    const late = await withContext(ctx, async () => {
      const invoice = await createInvoice(
        {
          contactId,
          issueDate: '2026-02-23',
          dueDate: '2026-03-23',
          taxMode: 'exclusive',
          ...line(scene.accounts.income),
        },
        ctx,
      );
      await approveInvoice(invoice.id, ctx);
      return invoice;
    });

    const payment = await withContext(ctx, () =>
      recordPayment(
        {
          direction: 'received',
          contactId,
          date: '2026-01-05',
          amount: '10000',
          accountId: scene.accounts.bank,
        },
        ctx,
      ),
    );

    await withContext(ctx, () =>
      allocatePayment(
        payment.id,
        { allocations: [{ targetType: 'invoice', targetId: late.id, amount: '10000' }] },
        ctx,
      ),
    );

    const control = await controlBalance(ctx, scene.accounts.receivable, '2026-02-22');
    const aging = await agingAt(ctx, 'receivable', '2026-02-22');

    // The ledger holds a £100 credit for this customer on 22 February: the receipt
    // has posted and the invoice it settles has not. The report should say the same.
    expect(control).toBe(-10_000n);
    expect(BigInt(aging.totals.total)).toBe(control);
  });
});

describe('aging buckets sum to the control account (OB-071, C8, D-40)', () => {
  it(
    'assigns each document its bucket by due date, and foots per bucket and in total',
    async () => {
      const bucketsSeen = new Set<AgingBucket>();

      await fc.assert(
        fc.asyncProperty(planWithAsOfArb, async ({ plan, asOf }) => {
          const ledger = await materialize(harness, plan);
          const { ctx } = ledger.scene;

          for (const side of SUBLEDGER_SIDES) {
            const control = await controlBalance(ctx, controlAccountOf(ledger.scene, side), asOf);
            const aging = await agingAt(ctx, side, asOf);

            expectBucketsFoot(aging, asOf, bucketsSeen);

            // C8 as D-40 states it: the *buckets* sum to the control account, not
            // merely some total the report computed for itself. Summed here from
            // `AGING_BUCKETS` rather than read from `totals.total`, so a report
            // whose printed total was right while a column was wrong fails — which
            // is the failure mode a total-only assertion cannot see.
            const summed = AGING_BUCKETS.reduce(
              (total, bucket) => total + BigInt(aging.totals[bucket]),
              0n,
            );
            expect(summed, `${side} buckets at ${asOf}`).toBe(signedFor(side, control));
          }
        }),
        { numRuns: RUNS },
      );

      // A run in which nothing was ever overdue would satisfy every per-bucket claim
      // with all the money sitting in `current`, and `bucketFor` would be untested.
      // Counted over the *detail rows* rather than over the runs, because that is
      // where a bucket is actually assigned. The generator's due-date spread and the
      // `asOf` drawn from `due + {0, 30, 60, 90}` are what make this hold; if it ever
      // fails, the generator has stopped producing the case rather than the report
      // having improved.
      const overdue = [...bucketsSeen].filter((bucket) => bucket !== 'current');
      expect(overdue.length, [...bucketsSeen].join(',')).toBeGreaterThan(0);
      expect(bucketsSeen.size).toBeGreaterThan(1);
    },
    SHRINKING_BUDGET_MS,
  );
});

describe('what each document says it is owed adds up to the ledger (OB-071, C2, D-34)', () => {
  it(
    'sums document settlement and unapplied credit to the control account',
    async () => {
      let checkedDocuments = 0;
      let checkedAllocations = 0;

      await fc.assert(
        fc.asyncProperty(planWithAsOfArb, async ({ plan }) => {
          const ledger = await materialize(harness, plan);
          const { ctx } = ledger.scene;

          for (const side of SUBLEDGER_SIDES) {
            let outstanding = 0n;

            for (const document of ledger.documents) {
              if (document.side !== side) continue;
              checkedDocuments += 1;

              const view = await withContext(ctx, () =>
                readDocument(document.id, document.kind, ctx),
              );

              // The document's own answer to "what is left on this", which is the
              // number the invoice page prints. Voided documents are excluded here
              // rather than netted: `documentStatus` calls them `void`, their
              // journal has been reversed, and their contribution to the control
              // account is zero by construction.
              if (view.status === 'void') {
                expect(document.voidDate).not.toBeNull();
                continue;
              }

              // What the document says has been applied to it, against what the plan
              // actually applied — and the D-34 identity that ties the two halves of
              // `settlement` together. Measured: without these, a `toSettlement` that
              // returned the gross as `outstanding` was caught only *sometimes*, by
              // the aggregate below — an invoice over-stated by an allocation from a
              // credit note is cancelled by that credit note being over-stated by the
              // same amount, so the sum ties whenever the run happened to allocate
              // only credits. Stated per document, the mutation has nowhere to hide.
              const applied = document.allocations.reduce((sum, row) => sum + row.amount, 0n);
              expect(BigInt(view.settlement.allocated), document.id).toBe(applied);
              expect(
                BigInt(view.settlement.allocated) + BigInt(view.settlement.outstanding),
                document.id,
              ).toBe(document.gross);
              if (applied > 0n) checkedAllocations += 1;

              const remaining = BigInt(view.settlement.outstanding);
              // A credit reduces what is owed, so it enters with the opposite sign
              // — which is the same statement `creditRow` makes in the aging report
              // and the reason a credit note is a document rather than a negative
              // invoice (D-39).
              const credit = document.kind === 'credit_note' || document.kind === 'vendor_credit';
              outstanding += credit ? -remaining : remaining;
            }

            for (const payment of ledger.payments) {
              if (payment.side !== side || payment.voidDate !== null) continue;
              const view = await withContext(ctx, () => getPayment(payment.id, ctx));
              // D-37's credit balance: what the payment brought in, less what it has
              // been told to settle. It is money already sitting in the control
              // account, so it reduces what the subledger says is owed.
              outstanding -= BigInt(view.settlement.outstanding);
            }

            const control = await controlBalance(
              ctx,
              controlAccountOf(ledger.scene, side),
              AFTER_EVERYTHING,
            );
            expect(outstanding, side).toBe(signedFor(side, control));
          }
        }),
        { numRuns: DOCUMENT_RUNS },
      );

      // Under a materializer that quietly approved nothing, every run would sum an
      // empty list to zero and match an empty ledger.
      expect(checkedDocuments).toBeGreaterThan(DOCUMENT_RUNS * 2);
      // And the per-document settlement checks are only worth anything on a document
      // something was actually applied to.
      expect(checkedAllocations).toBeGreaterThan(0);
    },
    SHRINKING_BUDGET_MS,
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Every detail row's bucket re-derived, and the rows footed to the row they sit in.
 *
 * The bucket is computed here from `AGING_BUCKET_UPPER_BOUNDS`' meaning rather than
 * read back from the row, and `daysBetween` is written out in `subledger-support.ts`
 * rather than imported from `aging.service.ts` — the oracle for "which bucket" must
 * not be the code that chose the bucket, which is `balance-sheet-support.ts`'s
 * argument about `fiscalYearSpan` applied to a different boundary.
 *
 * Credits carry a null due date and belong in `current`, because a credit is
 * allocated rather than chased (D-39). Asserting that explicitly is what stops a
 * report from aging a credit note from its issue date, which would move real money
 * between two columns while leaving the total exactly right.
 */
function expectBucketsFoot(aging: Aging, asOf: string, seen: Set<AgingBucket>): void {
  for (const row of aging.rows) {
    const perBucket = new Map<AgingBucket, bigint>(AGING_BUCKETS.map((bucket) => [bucket, 0n]));

    for (const document of row.documents ?? []) {
      const expected =
        document.dueDate === null ? 'current' : bucketOf(daysBetween(document.dueDate, asOf));

      expect(document.bucket, `${document.documentType} ${document.documentNumber}`).toBe(expected);
      if (document.dueDate !== null) {
        expect(document.daysPastDue).toBe(daysBetween(document.dueDate, asOf));
      }

      perBucket.set(
        document.bucket,
        (perBucket.get(document.bucket) ?? 0n) + BigInt(document.outstanding),
      );
      seen.add(document.bucket);
    }

    for (const bucket of AGING_BUCKETS) {
      // The detail is the report's own evidence for the column above it. A row whose
      // columns did not sum from its documents would be a statement a customer
      // cannot check against the invoices printed beneath it.
      expect(perBucket.get(bucket), `${row.contactName}.${bucket}`).toBe(
        BigInt(row.amounts[bucket]),
      );
    }

    const total = AGING_BUCKETS.reduce((sum, bucket) => sum + BigInt(row.amounts[bucket]), 0n);
    expect(total, row.contactName).toBe(BigInt(row.amounts.total));
  }
}

/** The bucket boundaries as D-40 words them, independent of the service's table. */
function bucketOf(daysPastDue: number): AgingBucket {
  if (daysPastDue <= 0) return 'current';
  if (daysPastDue <= 30) return 'days1To30';
  if (daysPastDue <= 60) return 'days31To60';
  if (daysPastDue <= 90) return 'days61To90';
  return 'days90Plus';
}

/** One contact's share of a control account, from the ledger and nothing else. */
async function contactControlBalance(
  ledger: MaterializedSubledger,
  side: SubledgerSide,
  contactId: string,
  asOf: string,
): Promise<bigint> {
  const { ctx } = ledger.scene;
  const balances = await withContext(ctx, () =>
    getAccountBalances({ to: asOf, contactId }, ctx, {
      accountIds: [controlAccountOf(ledger.scene, side)],
    }),
  );

  const group = balances.groups[0];
  if (group === undefined) throw new Error('An ungrouped balances report returned no group.');
  return group.totals.closing.balance;
}

interface DocumentView {
  readonly status: string;
  readonly settlement: { readonly allocated: string; readonly outstanding: string };
}

function readDocument(id: string, kind: string, ctx: RequestContext): Promise<DocumentView> {
  switch (kind) {
    case 'invoice':
      return getInvoice(id, ctx);
    case 'credit_note':
      return getCreditNote(id, ctx);
    case 'bill':
      return getBill(id, ctx);
    default:
      return getVendorCredit(id, ctx);
  }
}
