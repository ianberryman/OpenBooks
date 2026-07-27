import type { DocumentLineInput, TaxMode } from '@openbooks/shared-types';
import fc from 'fast-check';

import type { RequestContext } from '../../src/context';
import {
  approveBill,
  approveVendorCredit,
  createBill,
  createVendorCredit,
  voidBill,
  voidVendorCredit,
} from '../../src/modules/bills';
import {
  approveCreditNote,
  approveInvoice,
  createCreditNote,
  createInvoice,
  voidCreditNote,
  voidInvoice,
} from '../../src/modules/invoices';
import {
  allocateCreditNote,
  allocatePayment,
  allocateVendorCredit,
  recordPayment,
  voidPayment,
} from '../../src/modules/payments';
import type { SubledgerSide } from '../../src/modules/settings';
import type { TestDatabase } from '../db';

import type { SubledgerScene } from './subledger-support';
import { createSubledgerScene, dateAfterEpoch, shiftDate, withContext } from './subledger-support';

/**
 * Generated subledgers for the OB-071 properties (spec §11; M3 C2, C3, C4, C6, C8).
 *
 * ## What a run has to contain before the properties bite
 *
 * C2 is an identity between two aggregations, and most wrong implementations of
 * either side satisfy it on a small enough ledger. The shapes below are therefore
 * forced rather than hoped for, each because a specific defect is invisible without
 * it:
 *
 *  - **Both sides of the subledger, on the same contacts.** A payables bug that
 *    read the receivable control account would tie perfectly on an org that only
 *    invoices. `isCustomer` and `isVendor` are both set on every contact, so the
 *    two sides genuinely overlap on one row of the report.
 *  - **Multi-line documents across two income (or expense) accounts, carrying two
 *    different tax rates.** A posting that credited the whole gross to revenue and
 *    nothing to the tax account still debits the control account correctly, so a
 *    one-line untaxed document cannot see it. Two rates matter separately: a
 *    posting that grouped tax by document rather than by rate nets out on a
 *    single-rate document.
 *  - **Voids, dated after the document they void.** D-40's as-at rule says a
 *    document voided in March is still outstanding as at February, and the control
 *    account agrees. A report that dropped a voided document unconditionally fails
 *    only when the void's own journal date is on the far side of `asOf`.
 *  - **Payments short of, equal to, and larger than what they settle,** and
 *    allocations dated after the payment. The over-payment is D-37's credit on the
 *    contact, which aging carries as a negative in `current`; drop it and the
 *    report overstates by exactly that amount. The late allocation is the case
 *    where "outstanding now" and "outstanding as at `asOf`" differ, which is the
 *    whole of D-40.
 *  - **Credit notes and vendor credits, partly and fully applied.** An unapplied
 *    credit is the second kind of negative in `current`, and it is reached through
 *    a different query from a payment's.
 *  - **Drafts.** A draft has told the ledger nothing (D-38), so it must appear on
 *    neither side. A subledger query that forgot to join the posting journal would
 *    overstate by every draft in the org, and a plan with no drafts cannot notice.
 *  - **Voided payments that had been applied.** `voidPayment` *deletes* the
 *    allocations, which is the one destructive act in M3 and the residual limit
 *    `aging.repository.ts` records. It is generated deliberately: the deletion is
 *    symmetric — it removes the allocation from the document and returns the money
 *    to the control account — and a mutation that deleted one side only is exactly
 *    what C2 exists to catch.
 *
 * ## Why `asOf` is drawn from the plan's own dates
 *
 * `report-arbitraries.ts` records the measurement that forces this: with report
 * bounds picked uniformly from a year, changing an opening window's `<` to `<=`
 * left every property in this directory passing, and with the bounds drawn from the
 * plan's own journal dates the same mutation failed on the first run. The argument
 * applies twice over here, because this report has two unrelated families of
 * boundary.
 *
 * The **as-at** boundaries are the plan's journal and allocation dates —
 * `entry_date <= asOf`, `allocated_on <= asOf` — and the neighbours are what make an
 * inclusive bound distinguishable from an exclusive one. The **bucket** boundaries
 * are each document's due date offset by 0, 30, 60 and 90 days: `bucketFor` is
 * `daysPastDue <= bound`, and every one of those four bounds is a place an
 * off-by-one lives. A date drawn uniformly from three calendar years lands on one
 * of them about once in three hundred runs, which is never.
 */

export type DocumentKind = 'invoice' | 'credit_note' | 'bill' | 'vendor_credit';

const CREDIT_KINDS: Readonly<Record<SubledgerSide, DocumentKind>> = {
  receivable: 'credit_note',
  payable: 'vendor_credit',
};

const TARGET_KINDS: Readonly<Record<SubledgerSide, 'invoice' | 'bill'>> = {
  receivable: 'invoice',
  payable: 'bill',
};

export interface PlannedLine {
  /** Ten-thousandths of a unit, as `Quantity` counts. Always positive. */
  readonly quantityUnits: number;
  readonly unitAmountMinor: number;
  /** An index into the side's two rates, or `null` for an untaxed line. */
  readonly rate: number | null;
  /** Puts the line on the second income or expense account. */
  readonly secondAccount: boolean;
}

export type Disposition = 'draft' | 'approved' | 'voided';

export interface PlannedDocument {
  readonly side: SubledgerSide;
  /** A credit note or vendor credit rather than the side's target document. */
  readonly credit: boolean;
  readonly contact: number;
  /** Days from `EPOCH`, which every generated date is measured from. */
  readonly issueOffset: number;
  /** Days after the issue date. Zero is "due on receipt". */
  readonly dueOffset: number;
  readonly taxMode: TaxMode;
  readonly lines: readonly PlannedLine[];
  readonly disposition: Disposition;
  /** Days after the issue date for the void's own journal (D-38). */
  readonly voidOffset: number;
}

export interface PlannedPayment {
  readonly side: SubledgerSide;
  readonly contact: number;
  readonly dateOffset: number;
  /** Relative to what the contact has open on that side when the payment lands. */
  readonly size: 'short' | 'exact' | 'over';
  readonly apply: 'none' | 'partial' | 'full';
  /** Days after the payment date the allocation is dated (D-40). */
  readonly allocationOffset: number;
  readonly voided: boolean;
  /** Cents on top of what is open, for `over`, and the amount when nothing is. */
  readonly excess: number;
}

export interface PlannedCreditApplication {
  readonly side: SubledgerSide;
  /** Which of the org's credits, resolved modulo how many there turn out to be. */
  readonly creditIndex: number;
  readonly share: 'partial' | 'full';
  readonly dateOffset: number;
}

export interface SubledgerPlan {
  /** 1–12, never 1. See `subledger-support.ts`. */
  readonly startMonth: number;
  readonly contacts: number;
  readonly documents: readonly PlannedDocument[];
  readonly payments: readonly PlannedPayment[];
  readonly creditApplications: readonly PlannedCreditApplication[];
}

const lineArb: fc.Arbitrary<PlannedLine> = fc.record({
  // Whole units and quarters. A quarter makes the extension round — rounding point
  // 1 of D-35's two — and a plan of whole units alone would leave it unexercised.
  quantityUnits: fc.constantFrom(10_000, 20_000, 30_000, 2_500, 5_000, 15_000),
  // At least four cents, so a quarter-unit line still extends to a whole cent.
  // Below that the extension rounds to zero and a single-line document totals
  // nothing, which `assertApprovable` refuses — a generator that produced an
  // unapprovable document would fail every property for a reason that is not the
  // property.
  unitAmountMinor: fc.integer({ min: 4, max: 250_00 }),
  rate: fc.option(fc.nat({ max: 1 }), { nil: null }),
  secondAccount: fc.boolean(),
});

const documentArb: fc.Arbitrary<PlannedDocument> = fc.record({
  side: fc.constantFrom<SubledgerSide>('receivable', 'payable'),
  // Credits are rarer than the documents they credit, which is what a real ledger
  // looks like and, more usefully, keeps most runs holding something to credit.
  credit: fc.oneof(
    { arbitrary: fc.constant(false), weight: 3 },
    { arbitrary: fc.constant(true), weight: 1 },
  ),
  contact: fc.nat({ max: 2 }),
  issueOffset: fc.integer({ min: -200, max: 200 }),
  // Terms a business actually uses, plus zero. The spread is what puts one
  // contact's documents in different buckets, which is C8's per-bucket half — a
  // bucket assignment that ignored the due date would tie in total and be wrong in
  // every column.
  dueOffset: fc.constantFrom(0, 7, 14, 30, 45, 60, 90, 120),
  taxMode: fc.constantFrom<TaxMode>('exclusive', 'inclusive'),
  lines: fc.array(lineArb, { minLength: 1, maxLength: 3 }),
  disposition: fc.oneof(
    { arbitrary: fc.constant<Disposition>('approved'), weight: 6 },
    { arbitrary: fc.constant<Disposition>('draft'), weight: 2 },
    { arbitrary: fc.constant<Disposition>('voided'), weight: 2 },
  ),
  voidOffset: fc.constantFrom(0, 1, 20, 90, 200),
});

const paymentArb: fc.Arbitrary<PlannedPayment> = fc.record({
  side: fc.constantFrom<SubledgerSide>('receivable', 'payable'),
  contact: fc.nat({ max: 2 }),
  dateOffset: fc.integer({ min: -200, max: 250 }),
  size: fc.constantFrom<PlannedPayment['size']>('short', 'exact', 'over'),
  apply: fc.constantFrom<PlannedPayment['apply']>('none', 'partial', 'full'),
  allocationOffset: fc.constantFrom(0, 0, 1, 30, 120),
  voided: fc.oneof(
    { arbitrary: fc.constant(false), weight: 5 },
    { arbitrary: fc.constant(true), weight: 1 },
  ),
  excess: fc.integer({ min: 1, max: 50_00 }),
});

const creditApplicationArb: fc.Arbitrary<PlannedCreditApplication> = fc.record({
  side: fc.constantFrom<SubledgerSide>('receivable', 'payable'),
  creditIndex: fc.nat({ max: 5 }),
  share: fc.constantFrom<PlannedCreditApplication['share']>('partial', 'full'),
  dateOffset: fc.constantFrom(0, 1, 45, 200),
});

export const subledgerPlanArb: fc.Arbitrary<SubledgerPlan> = fc.record({
  // Never January: C6 reads the balance sheet, whose two derived equity lines are
  // scoped to the fiscal year containing the report date (D-20).
  startMonth: fc.integer({ min: 2, max: 12 }),
  contacts: fc.integer({ min: 2, max: 3 }),
  documents: fc.array(documentArb, { minLength: 4, maxLength: 8 }),
  payments: fc.array(paymentArb, { minLength: 1, maxLength: 4 }),
  creditApplications: fc.array(creditApplicationArb, { maxLength: 3 }),
});

/**
 * A plan and a report date drawn from its own boundaries.
 *
 * Three quarters from the boundary set and one quarter uniform, matching
 * `planWithRangeArb`'s weighting. The uniform quarter is not decoration: it keeps a
 * run from only ever asking the question on a day something happened, and a report
 * that is right on every event date and wrong between them would otherwise pass.
 */
export const planWithAsOfArb: fc.Arbitrary<{
  readonly plan: SubledgerPlan;
  readonly asOf: string;
}> = subledgerPlanArb.chain((plan) => {
  const candidates = boundaryDates(plan);
  const windows = allocationWindowDates(plan);

  return fc
    .oneof(
      { withCrossShrink: true },
      { arbitrary: fc.constantFrom(...candidates), weight: 3 },
      // The strictly-interior dates of a settlement window get their own branch
      // rather than competing with sixty-odd boundary candidates. Measured: with
      // only the two branches below, removing `allocated_on <= asOf` from
      // `allocatedTotal` — the whole of D-40's as-at rule for the settlement side —
      // **survived** fourteen runs. The mutation is only visible on a date after a
      // payment posted and before its allocation was dated, and drawing uniformly
      // from every boundary in the plan reached one about one run in ten. With this
      // branch it fails on the first or second.
      { arbitrary: fc.constantFrom(...windows), weight: 2 },
      { arbitrary: fc.integer({ min: -260, max: 420 }).map(dateAfterEpoch), weight: 1 },
    )
    .map((asOf) => ({ plan, asOf }));
});

/**
 * Dates that fall after money moved and before the paperwork that applied it.
 *
 * This is the only window in which "outstanding now" and "outstanding as at `asOf`"
 * can differ, and it is therefore the only window in which the settlement half of
 * D-40 is observable at all. Falls back to `boundaryDates` when the plan has no
 * late allocation, so the arbitrary is never empty.
 */
function allocationWindowDates(plan: SubledgerPlan): readonly string[] {
  const dates = new Set<string>();

  for (const payment of plan.payments) {
    if (payment.apply === 'none' || payment.allocationOffset === 0) continue;
    const from = dateAfterEpoch(payment.dateOffset);
    for (let day = 1; day <= payment.allocationOffset; day += 1) {
      dates.add(shiftDate(from, day - 1));
      if (dates.size > 64) break;
    }
  }

  // The credit-application mirror. Approximate rather than exact — which credit is
  // paired with which target is resolved at materialize time — so every document's
  // issue date is offered against every application offset. Extra candidates are
  // harmless; a missing one is the gap measured above.
  for (const application of plan.creditApplications) {
    if (application.dateOffset === 0) continue;
    for (const document of plan.documents) {
      if (!document.credit) continue;
      dates.add(shiftDate(dateAfterEpoch(document.issueOffset), application.dateOffset - 1));
    }
  }

  // The **counterparty** window: after the money posted and before the document it
  // settles did. An allocation ties two postings together and they need not land on
  // the same day — a deposit taken in January against an invoice raised in February
  // is the ordinary case, and the allocation's date defaults to the payment's. On a
  // date inside that window one end of the pair is in the report and the other is
  // not, which is where OB-071's finding 1 lives.
  //
  // Measured, and the reason this family is generated rather than left to the two
  // above: with only the boundary and settlement windows, the property found the
  // finding on roughly one full run in two. A property that discovers a real defect
  // half the time is a property that will be believed the half it does not.
  for (const payment of plan.payments) {
    for (const document of plan.documents) {
      if (document.credit || document.disposition === 'draft') continue;
      if (document.issueOffset <= payment.dateOffset) continue;
      dates.add(dateAfterEpoch(payment.dateOffset));
      dates.add(dateAfterEpoch(document.issueOffset - 1));
      dates.add(dateAfterEpoch(Math.floor((payment.dateOffset + document.issueOffset) / 2)));
    }
  }

  return dates.size === 0 ? boundaryDates(plan) : [...dates];
}

/**
 * Every date at which this plan's answer could change, plus one day either side.
 *
 * Non-empty by construction: `documents` carries `minLength: 4`, so there is always
 * at least one issue date to build from.
 */
function boundaryDates(plan: SubledgerPlan): readonly string[] {
  const dates = new Set<string>();
  const add = (date: string): void => {
    dates.add(shiftDate(date, -1));
    dates.add(date);
    dates.add(shiftDate(date, 1));
  };

  for (const document of plan.documents) {
    const issue = dateAfterEpoch(document.issueOffset);
    add(issue);
    if (document.disposition === 'voided') add(shiftDate(issue, document.voidOffset));

    const due = shiftDate(issue, document.dueOffset);
    for (const bound of [0, 30, 60, 90]) add(shiftDate(due, bound));
  }

  for (const payment of plan.payments) {
    const date = dateAfterEpoch(payment.dateOffset);
    add(date);
    add(shiftDate(date, payment.allocationOffset));
  }

  return [...dates];
}

// ---------------------------------------------------------------------------
// Materializing a plan
// ---------------------------------------------------------------------------

export interface AppliedAmount {
  readonly amount: bigint;
  /** `allocated_on`, which is what the as-at rule reads (D-40). */
  readonly date: string;
  /** The payment or credit that gave it, so a void can take it back. */
  readonly sourceId: string;
}

/** One approved document, and what the rest of the plan did to it. */
export interface MaterializedDocument {
  readonly id: string;
  readonly side: SubledgerSide;
  readonly kind: DocumentKind;
  readonly contactId: string;
  readonly issueDate: string;
  /** Present on an invoice and a bill; a credit is never chased (D-39). */
  readonly dueDate: string | null;
  readonly gross: bigint;
  /** The reversal's own entry date, or `null` when the document stands. */
  readonly voidDate: string | null;
  allocations: AppliedAmount[];
}

export interface MaterializedPayment {
  readonly id: string;
  readonly side: SubledgerSide;
  readonly contactId: string;
  readonly date: string;
  readonly amount: bigint;
  readonly voidDate: string | null;
  /** What it was applied to, after any void deleted the lot. */
  applied: bigint;
}

export interface MaterializedSubledger {
  readonly scene: SubledgerScene;
  /** Approved documents only; a draft is deliberately absent from every list. */
  readonly documents: readonly MaterializedDocument[];
  readonly drafts: number;
  readonly payments: readonly MaterializedPayment[];
  /** How many allocations the plan actually managed to write, for the guards. */
  readonly allocationsWritten: number;
}

/**
 * Builds one generated plan into its own org, through the real services only.
 *
 * Nothing here writes a subledger table or posts a journal. That is the discipline
 * the ticket turns on: a fixture that inserted `ar_documents` rows beside
 * hand-posted journals would be asserting that *the fixture* kept the two in step,
 * and C2 would survive any defect in `approveArDocument`'s posting.
 *
 * A fresh org per run, as `properties/support.ts` argues: the harness resets once
 * per `it` rather than once per run, so runs of the same property share a database
 * and a new org is what keeps them independent. Here that is load-bearing rather
 * than incidental — an aging query missing an `org_id` predicate would tie
 * perfectly in an org that was alone in the database, and by the tenth run it is
 * not.
 */
export async function materialize(
  db: TestDatabase,
  plan: SubledgerPlan,
): Promise<MaterializedSubledger> {
  const scene = await createSubledgerScene(db, {
    startMonth: plan.startMonth,
    contacts: plan.contacts,
  });

  const documents: MaterializedDocument[] = [];
  const payments: MaterializedPayment[] = [];
  let drafts = 0;

  for (const planned of plan.documents) {
    const materialized = await buildDocument(scene, planned);
    if (materialized === null) drafts += 1;
    else documents.push(materialized);
  }

  for (const planned of plan.creditApplications) {
    await applyCredit(scene, documents, planned);
  }

  for (const planned of plan.payments) {
    payments.push(await makePayment(scene, documents, planned));
  }

  const allocationsWritten = documents.reduce(
    (total, document) => total + document.allocations.length,
    0,
  );

  return { scene, documents, drafts, payments, allocationsWritten };
}

async function buildDocument(
  scene: SubledgerScene,
  planned: PlannedDocument,
): Promise<MaterializedDocument | null> {
  const kind = planned.credit ? CREDIT_KINDS[planned.side] : TARGET_KINDS[planned.side];
  const contactId = contactAt(scene, planned.contact);
  const issueDate = dateAfterEpoch(planned.issueOffset);
  const dueDate = shiftDate(issueDate, planned.dueOffset);
  const lines = planned.lines.map((line) => toLineInput(scene, planned.side, line));
  const header = { contactId, issueDate, taxMode: planned.taxMode, lines };

  // Branched rather than spread with a conditional `dueDate`: the four create
  // schemas are strict, and a credit note has no such field at all (D-39).
  const created = await withContext(scene.ctx, () => {
    switch (kind) {
      case 'invoice':
        return createInvoice({ ...header, dueDate }, scene.ctx);
      case 'bill':
        return createBill({ ...header, dueDate }, scene.ctx);
      case 'credit_note':
        return createCreditNote(header, scene.ctx);
      case 'vendor_credit':
        return createVendorCredit(header, scene.ctx);
    }
  });

  if (planned.disposition === 'draft') return null;

  const approved = await withContext(scene.ctx, () => approve(kind, created.id, scene.ctx));

  let voidDate: string | null = null;
  if (planned.disposition === 'voided') {
    // Voided here, before anything is applied to it. `voidArDocument` refuses a
    // document that carries allocations — which is itself a guard on C2 — so the
    // plan cannot void one later without first un-applying, and un-applying is a
    // different operation with a different property.
    voidDate = shiftDate(issueDate, planned.voidOffset);
    await withContext(scene.ctx, () => voidOf(kind, created.id, voidDate ?? issueDate, scene.ctx));
  }

  return {
    id: created.id,
    side: planned.side,
    kind,
    contactId,
    issueDate,
    dueDate: planned.credit ? null : dueDate,
    gross: BigInt(approved.totals.gross),
    voidDate,
    allocations: [],
  };
}

/**
 * A credit applied to one of the same contact's open documents.
 *
 * Silently a no-op when the plan has nothing to apply it to, and that is not the
 * property being weakened: a run in which no credit found a target still exercises
 * every other shape, and forcing one would mean rejecting plans until the generator
 * produced a matching pair. Every property that needs an application to have
 * happened counts them across the run and asserts the count, which is the
 * `slicedRuns` guard `cross-report.test.ts` uses for the same reason.
 */
async function applyCredit(
  scene: SubledgerScene,
  documents: readonly MaterializedDocument[],
  planned: PlannedCreditApplication,
): Promise<void> {
  const credits = documents.filter(
    (document) =>
      document.side === planned.side &&
      document.kind === CREDIT_KINDS[planned.side] &&
      document.voidDate === null &&
      unapplied(document) > 0n,
  );

  const credit = credits[planned.creditIndex % Math.max(credits.length, 1)];
  if (credit === undefined) return;

  const target = documents.find(
    (document) =>
      document.side === planned.side &&
      document.kind === TARGET_KINDS[planned.side] &&
      document.voidDate === null &&
      document.contactId === credit.contactId &&
      unapplied(document) > 0n,
  );
  if (target === undefined) return;

  const room = min(unapplied(credit), unapplied(target));
  const amount = planned.share === 'full' ? room : max(1n, room / 2n);
  const date = shiftDate(credit.issueDate, planned.dateOffset);
  const allocations = [
    { targetType: TARGET_KINDS[planned.side], targetId: target.id, amount: amount.toString() },
  ];

  await withContext(scene.ctx, () =>
    planned.side === 'receivable'
      ? allocateCreditNote(credit.id, { date, allocations }, scene.ctx)
      : allocateVendorCredit(credit.id, { date, allocations }, scene.ctx),
  );

  credit.allocations.push({ amount, date, sourceId: credit.id });
  target.allocations.push({ amount, date, sourceId: credit.id });
}

async function makePayment(
  scene: SubledgerScene,
  documents: readonly MaterializedDocument[],
  planned: PlannedPayment,
): Promise<MaterializedPayment> {
  const contactId = contactAt(scene, planned.contact);
  const date = dateAfterEpoch(planned.dateOffset);

  const target = documents.find(
    (document) =>
      document.side === planned.side &&
      document.kind === TARGET_KINDS[planned.side] &&
      document.contactId === contactId &&
      document.voidDate === null &&
      unapplied(document) > 0n,
  );

  const open = target === undefined ? 0n : unapplied(target);
  const excess = BigInt(planned.excess);

  // With nothing open, the payment is money on account — D-37's whole point and the
  // case C4 is about — so it is recorded rather than skipped.
  const amount =
    open === 0n
      ? excess
      : planned.size === 'short'
        ? max(1n, open / 2n)
        : planned.size === 'exact'
          ? open
          : open + excess;

  const applied =
    target === undefined || planned.apply === 'none'
      ? 0n
      : planned.apply === 'full'
        ? min(amount, open)
        : max(1n, min(amount, open) / 2n);

  // Applied in the same call when the allocation is dated to the payment's own day,
  // and in a second call when it is dated later: `recordPayment` dates an inline
  // allocation to the payment's date (`allocationDateSchema`), so the later
  // `allocated_on` — which is the only way "outstanding now" and "outstanding as at
  // `asOf`" can differ — is only reachable through `allocatePayment`.
  const inline = applied > 0n && target !== undefined && planned.allocationOffset === 0;

  const payment = await withContext(scene.ctx, () =>
    recordPayment(
      {
        direction: planned.side === 'receivable' ? 'received' : 'made',
        contactId,
        date,
        amount: amount.toString(),
        accountId: scene.accounts.bank,
        ...(inline && target !== undefined
          ? {
              allocations: [
                {
                  targetType: TARGET_KINDS[planned.side],
                  targetId: target.id,
                  amount: applied.toString(),
                },
              ],
            }
          : {}),
      },
      scene.ctx,
    ),
  );

  let allocatedOn = date;
  if (applied > 0n && target !== undefined) {
    if (!inline) {
      allocatedOn = shiftDate(date, planned.allocationOffset);
      await withContext(scene.ctx, () =>
        allocatePayment(
          payment.id,
          {
            date: allocatedOn,
            allocations: [
              {
                targetType: TARGET_KINDS[planned.side],
                targetId: target.id,
                amount: applied.toString(),
              },
            ],
          },
          scene.ctx,
        ),
      );
    }
    target.allocations.push({ amount: applied, date: allocatedOn, sourceId: payment.id });
  }

  let voidDate: string | null = null;
  if (planned.voided) {
    voidDate = shiftDate(date, 10);
    await withContext(scene.ctx, () =>
      voidPayment(payment.id, { date: voidDate ?? date }, scene.ctx),
    );

    // `voidPayment` deletes the allocations, which is the one destructive act in M3
    // (`payments.service.ts` argues why: an allocation that survived would leave the
    // invoice looking settled while the reversal put the money back on the control
    // account). The model follows it, so the properties compare against what the
    // database now holds rather than against what the plan asked for.
    if (target !== undefined) {
      target.allocations = target.allocations.filter((row) => row.sourceId !== payment.id);
    }
  }

  return {
    id: payment.id,
    side: planned.side,
    contactId,
    date,
    amount,
    voidDate,
    applied: voidDate === null ? applied : 0n,
  };
}

function toLineInput(
  scene: SubledgerScene,
  side: SubledgerSide,
  line: PlannedLine,
): DocumentLineInput {
  const account =
    side === 'receivable'
      ? line.secondAccount
        ? scene.accounts.secondIncome
        : scene.accounts.income
      : line.secondAccount
        ? scene.accounts.secondExpense
        : scene.accounts.expense;

  // Sales rates occupy the first half of the list and purchase rates the second,
  // because `applies_to` refuses the other side's rate — a document citing one
  // would fail validation rather than exercise anything.
  const rateBase = side === 'receivable' ? 0 : 2;

  return {
    description: 'Line',
    quantity: quantityText(line.quantityUnits),
    unitAmount: String(line.unitAmountMinor),
    accountId: account,
    ...(line.rate === null ? {} : { taxRateId: rateAt(scene, rateBase + line.rate) }),
  };
}

/** Ten-thousandths as the wire form `quantitySchema` takes. */
export function quantityText(units: number): string {
  const whole = Math.trunc(units / 10_000);
  const fraction = String(units % 10_000)
    .padStart(4, '0')
    .replace(/0+$/, '');
  return fraction === '' ? String(whole) : `${String(whole)}.${fraction}`;
}

function approve(
  kind: DocumentKind,
  id: string,
  ctx: RequestContext,
): Promise<{ readonly totals: { readonly gross: string } }> {
  switch (kind) {
    case 'invoice':
      return approveInvoice(id, ctx);
    case 'credit_note':
      return approveCreditNote(id, ctx);
    case 'bill':
      return approveBill(id, ctx);
    case 'vendor_credit':
      return approveVendorCredit(id, ctx);
  }
}

function voidOf(
  kind: DocumentKind,
  id: string,
  date: string,
  ctx: RequestContext,
): Promise<unknown> {
  switch (kind) {
    case 'invoice':
      return voidInvoice(id, { date }, ctx);
    case 'credit_note':
      return voidCreditNote(id, { date }, ctx);
    case 'bill':
      return voidBill(id, { date }, ctx);
    case 'vendor_credit':
      return voidVendorCredit(id, { date }, ctx);
  }
}

/** What is left on a document, as D-34 defines it: total minus what is applied. */
export function unapplied(document: MaterializedDocument): bigint {
  return document.gross - document.allocations.reduce((total, row) => total + row.amount, 0n);
}

function contactAt(scene: SubledgerScene, index: number): string {
  const contact = scene.contacts[index % scene.contacts.length];
  if (contact === undefined) throw new Error('The scene was built with no contacts.');
  return contact;
}

function rateAt(scene: SubledgerScene, index: number): string {
  const rate = scene.rates[index];
  if (rate === undefined) throw new Error(`The scene has no tax rate ${String(index)}.`);
  return rate;
}

function min(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function max(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}
