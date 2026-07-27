import fc from 'fast-check';

import type { TestDatabase } from '../db';
import type { FiscalScene } from '../reports/balance-sheet-support';
import {
  calendarDate,
  createFiscalScene,
  dayBefore,
  fiscalYearEndDate,
  fiscalYearStartDate,
} from '../reports/balance-sheet-support';
import type { AccountPlan, Axis, LinePlan, SceneAccount } from '../reports/support';
import { createAxis, createChart, post } from '../reports/support';

import { MAX_LINE_AMOUNT } from './arbitraries';
import type { PlannedTags, ReportPlan } from './report-arbitraries';
import { accountCode, AXIS_A_VALUES, AXIS_B_VALUES, reportPlanArb } from './report-arbitraries';

/**
 * Generated ledgers for the OB-043 properties.
 *
 * Built on `reportPlanArb` — which is itself built on `ledgerPlanArb` — for the
 * reason that file states: those generators already know how to produce journals
 * the posting service accepts, with amounts spanning the band above 2^53 and a
 * chart whose hierarchy is deep rather than accidentally flat. Re-deriving any of
 * that here would mean a property failing because the *generator* was wrong.
 *
 * Two things are added, and each of them is the difference between testing D-20 and
 * only appearing to.
 *
 * ## Dates that cross a fiscal-year boundary, under a start month that is not January
 *
 * `reportPlanArb` posts inside one calendar year, which is right for a report whose
 * range comes from the request. It is wrong here: the balance sheet's range is
 * *derived* — the lower bound is the start of the fiscal year containing `asOf`
 * (D-17 puts the start month on the org) — so a ledger confined to one calendar
 * year would leave `opening` empty on every revenue and expense row, and
 * `priorYearEarnings` permanently zero. A wrong fiscal year would then produce the
 * right answer, because there would be nothing on the other side of the boundary to
 * misclassify.
 *
 * So every generated org starts its year in a month **other than January**, dates
 * run over two fiscal years plus the tails of the calendar years around them, and
 * the boundary dates themselves — the year's first day, the day before it, the
 * year's last day — are drawn three times as often as an ordinary day. That
 * weighting is the same measurement `report-arbitraries.ts` records for range
 * bounds: a date picked uniformly from two years coincides with a boundary about
 * once in seven hundred runs, and the boundary is where `<` and `>=` live.
 *
 * ## Guaranteed revenue and expense on both sides of the boundary
 *
 * A randomly typed chart of two to five accounts has revenue *and* expense
 * accounts, with postings in both fiscal years, on a minority of runs. Since that
 * is precisely the state D-20 is about, it is constructed rather than hoped for:
 * seven fixed accounts are appended to every generated chart and four fixed
 * journals are posted against them, including one dated on the fiscal year's first
 * day — the single date an off-by-one at the boundary moves between the two derived
 * lines.
 *
 * The fixed accounts include a contra asset and a contra revenue, because the sign
 * of every figure in this report keys off `type` and a projection that keyed off
 * `normalBalance` instead is correct for every ordinary account.
 */

/** The calendar year the *current* fiscal year starts in. Its prior year is 2025. */
export const CURRENT_FISCAL_YEAR = 2026;

/**
 * Never January.
 *
 * A generator that sometimes produced 1 would let a mutation hard-coding January
 * pass on those runs, and the failure would then depend on the seed. Excluding it
 * makes "resolve the org's start month" and "assume January" different on every
 * single run. February and November are in the list alongside the common April,
 * July and October so the year-end that lands in the *next* calendar year is
 * exercised at both extremes.
 */
const startMonthArb = fc.constantFrom(2, 4, 7, 10, 11);

/**
 * The chart every generated ledger carries in addition to its random one.
 *
 * Codes are 9xxx so they cannot collide with `accountCode`, which numbers the
 * generated chart from 1000. Parents come before children, which `createChart`
 * requires and which also keeps a child's type equal to its parent's — the rule
 * `accounts/hierarchy.ts` enforces and the one that lets a section's rows be
 * filtered out of a whole-chart forest without severing a subtree.
 */
export const FIXED_ACCOUNTS: readonly AccountPlan[] = [
  { code: '9100', type: 'asset', normalBalance: 'debit' },
  // Accumulated depreciation: an asset with a credit normal balance. It must
  // *reduce* total assets, which is true when the sign comes from `type` and false
  // when it comes from `normalBalance`.
  { code: '9110', type: 'asset', normalBalance: 'credit', parentCode: '9100' },
  { code: '9200', type: 'liability', normalBalance: 'credit' },
  // An ordinary equity account — this is what a retained-earnings account is, and
  // it must be counted in the equity section and not in either derived line (D-20).
  { code: '9300', type: 'equity', normalBalance: 'credit' },
  { code: '9400', type: 'revenue', normalBalance: 'credit' },
  // Sales discounts: contra revenue, which subtracts from earnings.
  { code: '9410', type: 'revenue', normalBalance: 'debit', parentCode: '9400' },
  { code: '9500', type: 'expense', normalBalance: 'debit' },
];

export interface FixedLine {
  readonly code: string;
  readonly side: 'debit' | 'credit';
  readonly amount: bigint;
  readonly tags: PlannedTags;
}

export interface FixedJournal {
  readonly date: string;
  readonly lines: readonly FixedLine[];
}

export interface BalanceSheetPlan {
  readonly startMonth: number;
  /** The generated chart, hierarchy and tags, with its journal dates re-drawn. */
  readonly base: ReportPlan;
  readonly fixed: readonly FixedJournal[];
  /** Always inside the fiscal year starting `startMonth` in `CURRENT_FISCAL_YEAR`. */
  readonly asOf: string;
}

/**
 * Amounts, in the two bands that behave differently.
 *
 * The band above 2^53 is why money is `bigint` end to end and a string on the wire
 * (D-13), and a balance sheet is where a lost bit shows up as a sheet that does not
 * balance. `MAX_LINE_AMOUNT` is imported rather than restated: it is derived from
 * the posting service's own bound, and a local literal would drift into a
 * `MoneyParseError` in an unrelated property.
 */
const amountArb = fc.oneof(
  { withCrossShrink: true },
  { arbitrary: fc.bigInt({ min: 1n, max: 1_000_000n }), weight: 6 },
  { arbitrary: fc.bigInt({ min: 2n ** 53n + 1n, max: MAX_LINE_AMOUNT }), weight: 2 },
);

const tagsArb: fc.Arbitrary<PlannedTags> = fc.record({
  a: fc.option(fc.nat({ max: AXIS_A_VALUES - 1 }), { nil: null }),
  b: fc.option(fc.nat({ max: AXIS_B_VALUES - 1 }), { nil: null }),
});

/** Any day of the fiscal year starting `startMonth` in `year`. */
function fiscalDayArb(year: number, startMonth: number): fc.Arbitrary<string> {
  return fc
    .record({ offset: fc.nat({ max: 11 }), day: fc.integer({ min: 1, max: 28 }) })
    .map(({ offset, day }) => {
      const ordinal = startMonth - 1 + offset;
      return calendarDate(year + Math.floor(ordinal / 12), (ordinal % 12) + 1, day);
    });
}

/**
 * A posting date, weighted onto the boundary the derivation is split at.
 *
 * The four constants are the whole point: a journal dated on `currentStart` belongs
 * to current-year earnings and one dated the day before belongs to prior-year
 * earnings, and those two dates are adjacent. Everything else about the split can
 * be right while that single comparison is `>` instead of `>=`.
 */
function postingDateArb(startMonth: number): fc.Arbitrary<string> {
  const currentStart = fiscalYearStartDate(CURRENT_FISCAL_YEAR, startMonth);

  return fc.oneof(
    { withCrossShrink: true },
    {
      arbitrary: fc.constantFrom(
        fiscalYearStartDate(CURRENT_FISCAL_YEAR - 1, startMonth),
        dayBefore(currentStart),
        currentStart,
        fiscalYearEndDate(CURRENT_FISCAL_YEAR, startMonth),
      ),
      weight: 3,
    },
    { arbitrary: fiscalDayArb(CURRENT_FISCAL_YEAR, startMonth), weight: 1 },
    { arbitrary: fiscalDayArb(CURRENT_FISCAL_YEAR - 1, startMonth), weight: 1 },
  );
}

/**
 * The four journals every run posts on top of its generated ones.
 *
 * Two in the prior fiscal year and two in the current one, and the third is dated
 * on the fiscal year's first day rather than somewhere inside it — so every run,
 * not one in a hundred, has money sitting on the boundary. All four are balanced by
 * construction: each debit amount appears once on each side.
 */
function fixedJournalsArb(startMonth: number): fc.Arbitrary<readonly FixedJournal[]> {
  const currentStart = fiscalYearStartDate(CURRENT_FISCAL_YEAR, startMonth);

  return fc
    .record({
      priorTrading: fc.record({
        date: fiscalDayArb(CURRENT_FISCAL_YEAR - 1, startMonth),
        sales: amountArb,
        costs: amountArb,
      }),
      priorCapital: fc.record({
        date: fc.constantFrom(
          fiscalYearStartDate(CURRENT_FISCAL_YEAR - 1, startMonth),
          dayBefore(currentStart),
        ),
        invested: amountArb,
      }),
      currentTrading: fc.record({ sales: amountArb, costs: amountArb }),
      currentContra: fc.record({
        date: fiscalDayArb(CURRENT_FISCAL_YEAR, startMonth),
        discounts: amountArb,
        depreciation: amountArb,
      }),
      tags: fc.array(tagsArb, { minLength: 16, maxLength: 16 }),
    })
    .map((draw) => {
      const tag = (index: number): PlannedTags => draw.tags[index] ?? { a: null, b: null };

      return [
        {
          date: draw.priorTrading.date,
          lines: [
            { code: '9100', side: 'debit', amount: draw.priorTrading.sales, tags: tag(0) },
            { code: '9500', side: 'debit', amount: draw.priorTrading.costs, tags: tag(1) },
            { code: '9400', side: 'credit', amount: draw.priorTrading.sales, tags: tag(2) },
            { code: '9200', side: 'credit', amount: draw.priorTrading.costs, tags: tag(3) },
          ],
        },
        {
          date: draw.priorCapital.date,
          lines: [
            { code: '9100', side: 'debit', amount: draw.priorCapital.invested, tags: tag(4) },
            { code: '9300', side: 'credit', amount: draw.priorCapital.invested, tags: tag(5) },
          ],
        },
        {
          // Exactly the fiscal year's first day. Movement, never opening.
          date: currentStart,
          lines: [
            { code: '9100', side: 'debit', amount: draw.currentTrading.sales, tags: tag(6) },
            { code: '9500', side: 'debit', amount: draw.currentTrading.costs, tags: tag(7) },
            { code: '9400', side: 'credit', amount: draw.currentTrading.sales, tags: tag(8) },
            { code: '9200', side: 'credit', amount: draw.currentTrading.costs, tags: tag(9) },
          ],
        },
        {
          date: draw.currentContra.date,
          lines: [
            { code: '9410', side: 'debit', amount: draw.currentContra.discounts, tags: tag(10) },
            { code: '9500', side: 'debit', amount: draw.currentContra.depreciation, tags: tag(11) },
            { code: '9100', side: 'credit', amount: draw.currentContra.discounts, tags: tag(12) },
            {
              code: '9110',
              side: 'credit',
              amount: draw.currentContra.depreciation,
              tags: tag(13),
            },
          ],
        },
      ];
    });
}

/**
 * A plan, and a report date inside its current fiscal year.
 *
 * `asOf` is drawn from the ledger's own dates three times out of four, which is the
 * measurement `report-arbitraries.ts` records for range bounds and which applies
 * here for a second reason: the sheet is "as at" a date, so the interesting
 * question is what a journal posted on exactly `asOf` does — it is in, both bounds
 * being inclusive — and a date picked uniformly from a year lands on one about once
 * in a hundred runs.
 *
 * It is always inside the current fiscal year, because the fiscal year is derived
 * *from* it: an `asOf` in the prior year would move the whole window rather than
 * shorten it, and the run would then say nothing about prior-year earnings.
 */
export const balanceSheetPlanArb: fc.Arbitrary<BalanceSheetPlan> = fc
  .record({ startMonth: startMonthArb, base: reportPlanArb })
  .chain(({ startMonth, base }) =>
    fc
      .record({
        dates: fc.array(postingDateArb(startMonth), {
          minLength: base.journals.length,
          maxLength: base.journals.length,
        }),
        fixed: fixedJournalsArb(startMonth),
      })
      .chain(({ dates, fixed }) => {
        const journals = base.journals.map((journal, index) => ({
          ...journal,
          date: dates[index] ?? journal.date,
        }));

        const currentStart = fiscalYearStartDate(CURRENT_FISCAL_YEAR, startMonth);
        const currentEnd = fiscalYearEndDate(CURRENT_FISCAL_YEAR, startMonth);
        const inYear = [...journals, ...fixed]
          .map((journal) => journal.date)
          .filter((date) => date >= currentStart && date <= currentEnd);

        return fc
          .oneof(
            { withCrossShrink: true },
            {
              arbitrary: fc.constantFrom(currentStart, currentEnd, ...new Set(inYear)),
              weight: 3,
            },
            { arbitrary: fiscalDayArb(CURRENT_FISCAL_YEAR, startMonth), weight: 1 },
          )
          .map((asOf) => ({
            startMonth,
            base: { ...base, journals },
            fixed,
            asOf,
          }));
      }),
  );

export interface MaterializedBalanceSheetLedger {
  readonly scene: FiscalScene;
  readonly accounts: ReadonlyMap<string, SceneAccount>;
  readonly axisA: Axis;
  readonly axisB: Axis;
}

/**
 * Builds one generated plan into its own org.
 *
 * A fresh org per run, for the reason `properties/support.ts` gives: the harness
 * resets once per `it` rather than once per run, so a new org is what keeps runs
 * independent — and the later runs then assert their property while several other
 * orgs' postings sit in the same tables, which is the state production is always
 * in. Here it does a second job: the fiscal-year start month is per org, so a run
 * that reused the previous org's would silently test one start month.
 *
 * Periods cover three calendar years, which is the span `postingDateArb` can reach
 * given a start month as late as November.
 */
export async function materializeBalanceSheet(
  db: TestDatabase,
  plan: BalanceSheetPlan,
): Promise<MaterializedBalanceSheetLedger> {
  const scene = await createFiscalScene(db, {
    startMonth: plan.startMonth,
    calendarYears: [CURRENT_FISCAL_YEAR - 1, CURRENT_FISCAL_YEAR, CURRENT_FISCAL_YEAR + 1],
  });

  const axisA = await createAxis(scene, 'AXIS_A', valueCodes('A', AXIS_A_VALUES));
  const axisB = await createAxis(scene, 'AXIS_B', valueCodes('B', AXIS_B_VALUES));

  const accounts = await createChart(scene, [
    ...plan.base.accounts.map((account, index) => ({
      code: accountCode(index),
      type: account.type,
      normalBalance: account.normalBalance,
      ...(account.parentIndex === null ? {} : { parentCode: accountCode(account.parentIndex) }),
    })),
    ...FIXED_ACCOUNTS,
  ]);

  const accountId = (code: string): string => {
    const account = accounts.get(code);
    if (account === undefined) throw new Error(`Chart is missing account ${code}.`);
    return account.id;
  };

  for (const [journalIndex, journal] of plan.base.journals.entries()) {
    const journalTags = plan.base.tags[journalIndex] ?? [];

    await post(
      scene,
      journal.date,
      journal.lines.map((line, lineIndex) => ({
        accountId: accountId(accountCode(line.accountIndex)),
        side: line.side,
        amount: line.amount,
        valueIds: tagValueIds(axisA, axisB, journalTags[lineIndex]),
      })),
    );
  }

  for (const journal of plan.fixed) {
    const lines: LinePlan[] = journal.lines.map((line) => ({
      accountId: accountId(line.code),
      side: line.side,
      amount: line.amount,
      valueIds: tagValueIds(axisA, axisB, line.tags),
    }));

    await post(scene, journal.date, lines);
  }

  return { scene, accounts, axisA, axisB };
}

function tagValueIds(axisA: Axis, axisB: Axis, tags: PlannedTags | undefined): readonly string[] {
  if (tags === undefined) return [];

  const ids: string[] = [];
  if (tags.a !== null) ids.push(valueId(axisA, 'A', tags.a));
  if (tags.b !== null) ids.push(valueId(axisB, 'B', tags.b));
  return ids;
}

function valueId(axis: Axis, prefix: string, index: number): string {
  const id = axis.values.get(`${prefix}${String(index)}`);
  if (id === undefined) throw new Error(`Axis is missing value ${prefix}${String(index)}.`);
  return id;
}

function valueCodes(prefix: string, count: number): readonly string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}${String(index)}`);
}
