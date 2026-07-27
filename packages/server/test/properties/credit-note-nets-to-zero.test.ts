import type { DocumentLineInput, TaxMode } from '@openbooks/shared-types';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { RequestContext } from '../../src/context';
import {
  approveBill,
  approveVendorCredit,
  createBill,
  createVendorCredit,
  getBill,
  getVendorCredit,
} from '../../src/modules/bills';
import {
  approveCreditNote,
  approveInvoice,
  createCreditNote,
  createInvoice,
  getCreditNote,
  getInvoice,
} from '../../src/modules/invoices';
import { getTrialBalance } from '../../src/modules/ledger';
import { allocateCreditNote, allocateVendorCredit } from '../../src/modules/payments';
import { getBalanceSheet, getProfitAndLoss } from '../../src/modules/reports';
import type { SubledgerSide } from '../../src/modules/settings';

import {
  agingAt,
  controlAccountOf,
  controlBalance,
  createSubledgerScene,
  dateAfterEpoch,
  useSubledgerDatabase,
  withContext,
  type SubledgerScene,
} from './subledger-support';

/**
 * **A credit note nets its invoice to zero on every report and in the subledger**
 * (OB-071; M3 C6, ROADMAP D-39).
 *
 * D-39 chose a document over a negative invoice, and the cost of that choice is that
 * the netting is no longer arithmetic — it is three separate things agreeing: a
 * second journal that is the mirror of the first, an allocation that ties the two
 * documents together, and a report that adds them up. Modelling it as a negative
 * invoice would have made C6 true by construction and the books worse; this property
 * is what the harder choice has to buy.
 *
 * "Every report" is taken literally, and it is where the property earns its keep. A
 * credit note that posted the *gross* to the income account and nothing to the tax
 * account nets the receivable control account to zero perfectly — the customer owes
 * nothing, the aging report is empty, the invoice reads `paid` — and leaves the tax
 * liability account holding tax on a sale that was cancelled, which is a figure that
 * ends up on a return. Only reading the other accounts catches it. So the run is
 * compared before and after on:
 *
 *  - the control account, and the aging report built from it;
 *  - the income (or expense) account **and the tax account**, separately;
 *  - the whole trial balance, row by row;
 *  - the balance sheet's totals, including the two equity lines D-20 derives — which
 *    is why the fiscal year never starts in January (`subledger-support.ts`);
 *  - the P&L's net income over that fiscal year.
 *
 * ## The baseline is not an empty org
 *
 * Every figure is compared against a snapshot taken after an *unrelated* document
 * has already been approved for a second contact. Against a fresh org every "nets to
 * zero" assertion would be `'0' === '0'`, which a report that returned zero for
 * everything would satisfy.
 *
 * ## Why the dates are ordered
 *
 * The credit note is issued on or after the invoice and the allocation on or after
 * the credit note. That is not a convenience: OB-071's finding 1
 * (`subledger-agreement.test.ts`) is that an allocation dated before its
 * counterparty has posted makes aging disagree with the control account, and a C6
 * run that tripped over it would be reporting that defect a second time instead of
 * reporting whether a credit note nets its invoice to zero.
 */
const harness = useSubledgerDatabase();

const RUNS = 12;
const SHRINKING_BUDGET_MS = 180_000;

interface CreditCase {
  readonly side: SubledgerSide;
  readonly startMonth: number;
  readonly taxMode: TaxMode;
  readonly lines: readonly {
    readonly quantity: number;
    readonly unit: number;
    readonly rate: number | null;
    readonly second: boolean;
  }[];
  readonly creditOffset: number;
  readonly allocationOffset: number;
}

const creditCaseArb: fc.Arbitrary<CreditCase> = fc.record({
  side: fc.constantFrom<SubledgerSide>('receivable', 'payable'),
  startMonth: fc.integer({ min: 2, max: 12 }),
  taxMode: fc.constantFrom<TaxMode>('exclusive', 'inclusive'),
  lines: fc.array(
    fc.record({
      quantity: fc.constantFrom(10_000, 25_000, 5_000, 30_000),
      // At least four cents: below that a quarter-unit line extends to zero and
      // `assertApprovable` refuses a document that totals nothing.
      unit: fc.integer({ min: 4, max: 200_00 }),
      // Untaxed lines among taxed ones, so a credit note that posted a tax line for
      // every document line rather than for every *rate* is distinguishable.
      rate: fc.option(fc.nat({ max: 1 }), { nil: null }),
      second: fc.boolean(),
    }),
    { minLength: 1, maxLength: 3 },
  ),
  creditOffset: fc.constantFrom(0, 1, 40),
  allocationOffset: fc.constantFrom(0, 1, 20),
});

describe('a credit note nets its invoice to zero (OB-071, C6, D-39)', () => {
  it(
    'restores the control account, the income and tax accounts, and every report',
    async () => {
      await fc.assert(
        fc.asyncProperty(creditCaseArb, async (input) => {
          const scene = await createSubledgerScene(harness, {
            startMonth: input.startMonth,
            contacts: 2,
          });
          const { ctx } = scene;
          const [subject, bystander] = contactPair(scene);

          const issueDate = dateAfterEpoch(0);
          const creditDate = dateAfterEpoch(input.creditOffset);
          const allocationDate = dateAfterEpoch(input.creditOffset + input.allocationOffset);
          const asOf = dateAfterEpoch(300);
          const lines = toLines(scene, input);

          // Unrelated activity first, so nothing below is compared against zero.
          await approveDocument(scene, input.side, false, {
            contactId: bystander,
            issueDate,
            taxMode: input.taxMode,
            lines,
          });

          const before = await snapshot(scene, input.side, asOf);
          // The two derived equity lines individually, which `snapshot` compares only
          // as a sum. Captured here so the split can be asserted as its own claim.
          const beforeSheet = await withContext(ctx, () => getBalanceSheet({ asOf }, ctx));

          const document = await approveDocument(scene, input.side, false, {
            contactId: subject,
            issueDate,
            taxMode: input.taxMode,
            lines,
          });
          const credit = await approveDocument(scene, input.side, true, {
            contactId: subject,
            issueDate: creditDate,
            taxMode: input.taxMode,
            lines,
          });

          // The same lines in the same mode, so the credit's gross is the document's
          // gross exactly — including both of D-35's roundings, which is what makes
          // "nets to zero" reachable at all rather than off by a cent per line.
          expect(credit.gross).toBe(document.gross);
          expect(document.gross).toBeGreaterThan(0n);

          await withContext(ctx, () =>
            input.side === 'receivable'
              ? allocateCreditNote(
                  credit.id,
                  {
                    date: allocationDate,
                    allocations: [
                      {
                        targetType: 'invoice',
                        targetId: document.id,
                        amount: document.gross.toString(),
                      },
                    ],
                  },
                  ctx,
                )
              : allocateVendorCredit(
                  credit.id,
                  {
                    date: allocationDate,
                    allocations: [
                      {
                        targetType: 'bill',
                        targetId: document.id,
                        amount: document.gross.toString(),
                      },
                    ],
                  },
                  ctx,
                ),
          );

          // In the subledger: both documents settled, by the derived status and the
          // derived settlement — neither of which is a stored column (D-34, D-38).
          const settled = await readDocument(ctx, input.side, false, document.id);
          expect(settled.settlement.outstanding).toBe('0');
          expect(settled.status).toBe('paid');

          const spent = await readDocument(ctx, input.side, true, credit.id);
          expect(spent.settlement.outstanding).toBe('0');
          expect(spent.status).toBe('paid');

          // And on every report.
          const after = await snapshot(scene, input.side, asOf);
          expect(after).toEqual(before);

          // The split `snapshot` deliberately does not pin, stated as its own claim
          // rather than left as a gap. A credit note issued in a **later fiscal year**
          // than the document it credits moves exactly its own gross out of
          // current-year earnings; one issued in the same fiscal year moves nothing.
          // Both cases are generated, because a 40-day `creditOffset` crosses the
          // boundary for some start months and not others. A derivation that scoped
          // the credit to the *document's* fiscal year rather than to its own would
          // restore both lines exactly and fail here — and it would be wrong, because
          // it would restate a year that has already been reported on.
          const afterSheet = await withContext(ctx, () => getBalanceSheet({ asOf }, ctx));
          const crossesYear =
            fiscalYearOf(creditDate, input.startMonth) !==
            fiscalYearOf(issueDate, input.startMonth);
          // The **net**, not the gross. A document's tax posts to the rate's own
          // liability or asset account and never touches income (D-35), so the
          // earnings line moves by what reached revenue or expense. Getting this
          // wrong is off by the tax, which on an untaxed run is off by nothing —
          // which is why the generator puts taxed and untaxed lines on one document.
          const incomeEffect = input.side === 'receivable' ? -document.net : document.net;
          expect(BigInt(afterSheet.totals.currentYearEarnings)).toBe(
            BigInt(beforeSheet.totals.currentYearEarnings) + (crossesYear ? incomeEffect : 0n),
          );

          // The contact's own row, stated separately from the totals above: a pair
          // that netted to zero across two *different* contacts would leave both
          // totals right and both rows wrong, which is the failure a total cannot
          // see. `includeZero` is what keeps the row present to be checked.
          const aging = await agingAt(ctx, input.side, asOf);
          const row = aging.rows.find((candidate) => candidate.contactId === subject);
          expect(row?.amounts.total ?? '0').toBe('0');
          expect(row?.amounts.current ?? '0').toBe('0');
        }),
        { numRuns: RUNS },
      );
    },
    SHRINKING_BUDGET_MS,
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Everything a credit note must leave exactly where it found it.
 *
 * Flattened to one record keyed by what it describes rather than compared as five
 * report objects, for `readEveryReport`'s reason in `cross-report.test.ts`: a
 * `toEqual` over nested report trees reports "objects differ", and over this it
 * reports the account code or the total that moved.
 */
async function snapshot(
  scene: SubledgerScene,
  side: SubledgerSide,
  asOf: string,
): Promise<Record<string, string>> {
  const { ctx } = scene;
  const figures: Record<string, string> = {};

  figures['control'] = (await controlBalance(ctx, controlAccountOf(scene, side), asOf)).toString();

  const aging = await agingAt(ctx, side, asOf);
  figures['aging#total'] = aging.totals.total;
  // Keyed over the scene's contacts rather than over the rows the report returned,
  // and absent rows read as `'0'`. Aging only lists contacts that have something in
  // the subledger, so a contact acquires a row the moment a document is raised for
  // it and keeps one at zero afterwards — the before and after records would
  // otherwise have different shapes and differ for a reason that is not the
  // property. This is `readEveryReport`'s handling of absent buckets, arriving in a
  // different report.
  const byContact = new Map(aging.rows.map((row) => [row.contactName, row.amounts.total]));
  for (const index of scene.contacts.keys()) {
    // `createSubledgerScene` names them `Party 0`, `Party 1`, …
    const name = `Party ${String(index)}`;
    figures[`aging/${name}`] = byContact.get(name) ?? '0';
  }

  // Every account, so the tax account is covered without naming it — a credit note
  // that posted the gross to income and nothing to tax nets the control account
  // perfectly and moves two rows here.
  const trialBalance = await withContext(ctx, () => getTrialBalance({ asOf }, ctx));
  for (const row of trialBalance.rows) figures[`tb/${row.code}`] = row.balance;
  figures['tb#difference'] = trialBalance.difference;

  const sheet = await withContext(ctx, () => getBalanceSheet({ asOf }, ctx));
  for (const field of [
    'assets',
    'liabilities',
    'equity',
    'liabilitiesAndEquity',
    'difference',
  ] as const) {
    figures[`bs#${field}`] = sheet.totals[field];
  }

  // The two derived equity lines are compared as their **sum**, and the split is
  // asserted separately below. Not a softening — the opposite. A credit note issued
  // after the fiscal year turns genuinely restates the *new* year's income and not
  // the closed year's: the sale happened last year and the credit happened this one,
  // so retained earnings keeps the sale and this year's income carries the credit.
  // D-20 derives both lines from the fiscal year containing the report date, so
  // demanding that each be restored individually would demand that the report get
  // this wrong. What must hold is that their sum comes back, because that sum is
  // equity and equity is what the sheet foots on.
  figures['bs#earnings'] = (
    BigInt(sheet.totals.priorYearEarnings) + BigInt(sheet.totals.currentYearEarnings)
  ).toString();

  const statement = await withContext(ctx, () => getProfitAndLoss({ to: asOf }, ctx));
  figures['pnl#netIncome'] = statement.totals.netIncome;

  return figures;
}

interface ApprovedDocument {
  readonly id: string;
  readonly gross: bigint;
  /** Gross less tax. Net income moves by this; the tax moves the liability account. */
  readonly net: bigint;
}

interface DocumentBody {
  readonly contactId: string;
  readonly issueDate: string;
  readonly taxMode: TaxMode;
  readonly lines: readonly DocumentLineInput[];
}

async function approveDocument(
  scene: SubledgerScene,
  side: SubledgerSide,
  credit: boolean,
  body: DocumentBody,
): Promise<ApprovedDocument> {
  const { ctx } = scene;

  // `lines` is copied into a mutable array because the four create schemas infer
  // `z.array(...)` as mutable; the fixture holds it readonly so a caller cannot
  // mutate the shared line list between the document and the credit that mirrors it.
  const payload = { ...body, lines: [...body.lines] };

  const created = await withContext(ctx, () => {
    if (side === 'receivable') {
      return credit
        ? createCreditNote(payload, ctx)
        : createInvoice({ ...payload, dueDate: body.issueDate }, ctx);
    }
    return credit
      ? createVendorCredit(payload, ctx)
      : createBill({ ...payload, dueDate: body.issueDate }, ctx);
  });

  const approved = await withContext(ctx, () => {
    if (side === 'receivable') {
      return credit ? approveCreditNote(created.id, ctx) : approveInvoice(created.id, ctx);
    }
    return credit ? approveVendorCredit(created.id, ctx) : approveBill(created.id, ctx);
  });

  return {
    id: created.id,
    gross: BigInt(approved.totals.gross),
    net: BigInt(approved.totals.net),
  };
}

function readDocument(
  ctx: RequestContext,
  side: SubledgerSide,
  credit: boolean,
  id: string,
): Promise<{ readonly status: string; readonly settlement: { readonly outstanding: string } }> {
  return withContext(ctx, () => {
    if (side === 'receivable') return credit ? getCreditNote(id, ctx) : getInvoice(id, ctx);
    return credit ? getVendorCredit(id, ctx) : getBill(id, ctx);
  });
}

function toLines(scene: SubledgerScene, input: CreditCase): readonly DocumentLineInput[] {
  const rateBase = input.side === 'receivable' ? 0 : 2;

  return input.lines.map((line) => ({
    description: 'Work',
    quantity: quantityText(line.quantity),
    unitAmount: String(line.unit),
    accountId:
      input.side === 'receivable'
        ? line.second
          ? scene.accounts.secondIncome
          : scene.accounts.income
        : line.second
          ? scene.accounts.secondExpense
          : scene.accounts.expense,
    ...(line.rate === null ? {} : { taxRateId: rateAt(scene, rateBase + line.rate) }),
  }));
}

function quantityText(units: number): string {
  const whole = Math.trunc(units / 10_000);
  const fraction = String(units % 10_000)
    .padStart(4, '0')
    .replace(/0+$/, '');
  return fraction === '' ? String(whole) : `${String(whole)}.${fraction}`;
}

function rateAt(scene: SubledgerScene, index: number): string {
  const rate = scene.rates[index];
  if (rate === undefined) throw new Error(`The scene has no tax rate ${String(index)}.`);
  return rate;
}

function contactPair(scene: SubledgerScene): readonly [string, string] {
  const [first, second] = scene.contacts;
  if (first === undefined || second === undefined) {
    throw new Error('This scene needs two contacts.');
  }
  return [first, second];
}

/**
 * Which fiscal year a date falls in, given the org's start month.
 *
 * Written out rather than borrowed from `periods/calendar.ts`, for
 * `balance-sheet-support.ts`'s reason: the oracle for "which year did the report
 * use" must not be the code that chose the year.
 */
function fiscalYearOf(date: string, startMonth: number): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return month >= startMonth ? year : year - 1;
}
