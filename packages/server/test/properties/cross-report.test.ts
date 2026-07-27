import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { RequestContext } from '../../src/context';
import { getTrialBalance } from '../../src/modules/ledger';
import type { BalanceSheet, GeneralLedger, ProfitAndLoss } from '../../src/modules/reports';
import { getBalanceSheet, getGeneralLedger, getProfitAndLoss } from '../../src/modules/reports';
import {
  dayBefore,
  fiscalYearEndDate,
  fiscalYearStartDate,
} from '../reports/balance-sheet-support';
import type { Axis } from '../reports/support';
import { useReportDatabase, withContext } from '../reports/support';

import type { MaterializedBalanceSheetLedger } from './balance-sheet-arbitraries';
import { CURRENT_FISCAL_YEAR, materializeBalanceSheet } from './balance-sheet-arbitraries';
import type { CrossReportCase } from './cross-report-arbitraries';
import {
  accountId,
  crossReportCaseArb,
  postCorrection,
  reverseCorrection,
} from './cross-report-arbitraries';

/**
 * The properties that span two reports (OB-053).
 *
 * Waves 3 and 4 each shipped the properties their own report owned: the core is
 * differentially tested against `getTrialBalance`, the P&L ties to it row by row,
 * the balance sheet foots and its two derived lines are checked against the oracle
 * at both ends of the fiscal year, and the general ledger's pages, ordering and
 * slices are pinned. None of that is repeated here.
 *
 * What none of those tickets owned is a claim about **two reports agreeing**, because
 * such a claim belongs to neither. Every property in this file is one:
 *
 *  1. The P&L's bottom line is the balance sheet's `currentYearEarnings`, and the
 *     P&L run to the day before the fiscal year is its `priorYearEarnings`. Two
 *     derivations of the same figure, from the same ledger, by different code.
 *  2. The general ledger's `closing` for an account is that account's trial-balance
 *     balance, and its `movement` is the difference between two trial balances.
 *  3. A journal and its reversal leave every report exactly where it was — per
 *     dimension slice as well as in total (D-16).
 *  4. Crossing a fiscal-year boundary moves money from `currentYearEarnings` into
 *     `priorYearEarnings` and changes nothing else (D-20's correction).
 *
 * ## Why these are worth having when each report is already tested
 *
 * Each report has an oracle, and each oracle is `getTrialBalance`. That is the right
 * choice and it has a blind spot: a trial balance is cumulative to a single date, so
 * it can say what an account holds and it cannot say what a *report* claims about a
 * window, a fiscal year, or a slice. Two reports can each agree with it on their own
 * terms and disagree with each other — the balance sheet reading `movement` over a
 * fiscal year it resolved itself, the P&L reading `movement` over a range its caller
 * named, both tying to the oracle account by account, and the two printing different
 * net incomes because the windows differ by a day. That is the divergence a reader
 * notices when the two reports are open side by side in front of a client, and until
 * this file nothing asserted it could not happen.
 *
 * The generator is `crossReportCaseArb`; its own header says which shapes it forces
 * and why. In short: never a January fiscal year, postings on both sides of the year
 * boundary and on the boundary itself, multi-line journals, contra accounts, tags on
 * two axes with untagged lines among them, and a correction to reverse.
 */
const harness = useReportDatabase();

/**
 * 20 runs for the read-only properties, 12 for the reversal ones.
 *
 * A run materializes the balance sheet suite's ledger — a fresh org, three years of
 * periods, two axes, a generated chart plus seven fixed accounts, and eight or so
 * journals through the real posting service — which `balance-sheet.test.ts` measures
 * at about 100ms. The reads on top are what differ: properties 1 and 4 issue four or
 * five report calls per run, property 2 issues one general ledger per account, and
 * the reversal properties read every report twice, so their runs cost roughly five
 * times a read-only one. Variety comes from the generator rather than the count —
 * every run varies the start month, the chart, the tags, the amount band, which side
 * of the boundary each posting falls on, and the correction's shape.
 */
const RUNS = 20;
const REVERSAL_RUNS = 12;

/**
 * A longer timeout for the two reversal properties, and only for them.
 *
 * Passing, they take about two seconds each. Failing, fast-check shrinks — and a
 * shrink attempt here is not a re-evaluation of a pure function, it is a fresh org,
 * three years of periods, a chart, eight journals and forty report reads. Measured:
 * against a `reverseJournal` deliberately broken to permute accounts instead of
 * swapping sides, the shrink took 16s; against a defect found while writing this
 * file it ran past the project's 30s default and reported as a *timeout*, which is
 * the least useful thing a property test can say — the counterexample was found and
 * then thrown away. The budget only applies when something is already wrong.
 */
const SHRINKING_BUDGET_MS = 120_000;

describe('the P&L and the balance sheet agree (OB-053, B2, D-20)', () => {
  it('nets income to the sheet’s current-year earnings, in total and per slice', async () => {
    let slicedRuns = 0;

    await fc.assert(
      fc.asyncProperty(crossReportCaseArb, async ({ plan }) => {
        const ledger = await materializeBalanceSheet(harness, plan);
        const yearStart = fiscalYearStartDate(CURRENT_FISCAL_YEAR, plan.startMonth);
        const window = { from: yearStart, to: plan.asOf };

        const [sheet, statement, slicedSheet, slicedStatement] = await withContext(
          ledger.scene.ctx,
          async () => [
            await getBalanceSheet({ asOf: plan.asOf }, ledger.scene.ctx),
            await getProfitAndLoss(window, ledger.scene.ctx),
            await getBalanceSheet({ asOf: plan.asOf, groupBy: ledger.axisA.id }, ledger.scene.ctx),
            await getProfitAndLoss({ ...window, groupBy: ledger.axisA.id }, ledger.scene.ctx),
          ],
        );

        // The headline. The two figures are computed by different files from
        // different arms of the core: the P&L sums `movement` over the range its
        // caller named, the sheet sums `movement` over the fiscal year it resolved
        // for itself from `asOf` and the org's start month. Nothing but this makes
        // them the same number.
        expect(statement.totals.netIncome).toBe(sheet.totals.currentYearEarnings);

        // And the other derived line, against a P&L with no lower bound — which is
        // the inception-to-date reading, and exactly the window `priorYearEarnings`
        // is defined over. Without this, a boundary off by a year would move money
        // between the two lines while leaving the headline above intact.
        const prior = await withContext(ledger.scene.ctx, () =>
          getProfitAndLoss({ to: dayBefore(yearStart) }, ledger.scene.ctx),
        );
        expect(prior.totals.netIncome).toBe(sheet.totals.priorYearEarnings);

        if (slicedSheet.groups.length > 1) slicedRuns += 1;
        expectEarningsAgreePerSlice(slicedSheet, slicedStatement, ledger.axisA);
      }),
      { numRuns: RUNS },
    );

    // A single-bucket run says nothing the unsliced assertions did not already say.
    expect(slicedRuns).toBeGreaterThan(RUNS / 2);
  });
});

describe('the general ledger reconciles to the trial balance (OB-053, B2, B4)', () => {
  it('closes where the trial balance says, and moves by the difference of two', async () => {
    await fc.assert(
      fc.asyncProperty(crossReportCaseArb, async ({ plan, range }) => {
        const ledger = await materializeBalanceSheet(harness, plan);

        const [closingOracle, openingOracle] = await withContext(ledger.scene.ctx, async () => [
          await getTrialBalance({ asOf: range.to }, ledger.scene.ctx),
          await getTrialBalance({ asOf: dayBefore(range.from) }, ledger.scene.ctx),
        ]);
        const opening = new Map(openingOracle.rows.map((row) => [row.accountId, row]));

        let closingDebits = 0n;
        let closingCredits = 0n;

        for (const row of closingOracle.rows) {
          const gl = await readLedger(ledger.scene.ctx, {
            accountId: row.accountId,
            from: range.from,
            to: range.to,
          });

          const before = opening.get(row.accountId);
          if (before === undefined) {
            throw new Error(`The oracle lost account ${row.code} between two dates.`);
          }

          // The general ledger's header comes from the report core through the
          // `accountIds` narrowing — the one path into the aggregation that no
          // other property exercises, because every other caller reads the whole
          // chart. A narrowing applied to the account list but not to the sum, or
          // to the sum but not the list, produces a header that is individually
          // plausible and disagrees with the oracle here.
          expect(gl.closing.debits, row.code).toBe(row.debits);
          expect(gl.closing.credits, row.code).toBe(row.credits);
          expect(gl.closing.balance, row.code).toBe(row.balance);

          expect(gl.opening.debits, row.code).toBe(before.debits);
          expect(gl.opening.credits, row.code).toBe(before.credits);
          expect(gl.opening.balance, row.code).toBe(before.balance);

          // Movement as the oracle sees it: two cumulative trial balances
          // differenced, with nothing the report core computed in it. Both range
          // bounds are inclusive, which is what `dayBefore(from)` expresses, and
          // the generator draws its bounds from the plan's own journal dates so
          // that a journal really does land on the boundary.
          for (const field of ['debits', 'credits', 'balance'] as const) {
            expect(gl.movement[field], `${row.code}.${field}`).toBe(
              (BigInt(row[field]) - BigInt(before[field])).toString(),
            );
          }

          closingDebits += BigInt(gl.closing.debits);
          closingCredits += BigInt(gl.closing.credits);
        }

        // Summed over the chart, the general ledgers are the trial balance. Per
        // account the checks above cannot see an account the report core dropped
        // entirely — there would simply be no ledger to read — and this can.
        expect(closingDebits.toString()).toBe(closingOracle.totalDebits);
        expect(closingCredits.toString()).toBe(closingOracle.totalCredits);
      }),
      { numRuns: RUNS },
    );
  });
});

describe('a reversal nets to zero in every report (OB-053, D-16)', () => {
  it(
    'returns the trial balance, P&L, sheet and every account’s ledger, per slice too',
    async () => {
      let taggedRuns = 0;

      await fc.assert(
        fc.asyncProperty(crossReportCaseArb, async ({ plan, correction }) => {
          const ledger = await materializeBalanceSheet(harness, plan);
          const reading = readingFor(plan, ledger);
          // Resolved before the correction is posted, so both readings ask for the
          // same keys. A slice read that only existed on one side would compare two
          // records of different shapes and fail for a reason that is not the claim.
          const touched = touchedAccounts(ledger, correction);

          const before = await readEveryReport(reading, { slicedAccountIds: touched });
          const grossBefore = await grossDebits(reading);

          const posted = await postCorrection(ledger, correction);
          if (correction.lines.some((line) => line.tags.a !== null)) taggedRuns += 1;

          // Retagged to match, which is what `setJournalLineDimensions` is for and
          // what a user correcting a posting does. `reverseJournal` deliberately does
          // not copy tags (D-32) — the property that holds when it is left alone is
          // the next one down, and it is a different property.
          await reverseCorrection(ledger, posted, { copyTags: true });

          const after = await readEveryReport(reading, { slicedAccountIds: touched });

          // Every net figure in every report, keyed by account code and slice, so a
          // failure names the account and the bucket rather than reporting that two
          // large objects differ. Gross debits and credits are deliberately absent:
          // they *double*, and that is the point of D-16 — the zero is the sum of two
          // recorded movements rather than the absence of one. `reversal.test.ts`
          // asserts the doubling; this asserts what a reader of a report sees.
          expect(after).toEqual(before);

          // And the guard against passing vacuously. Everything above is satisfied
          // by a run in which neither the correction nor its reversal reached the
          // window a report reads — a date outside it, a posting that silently did
          // nothing — and the reports would then be identical for the least
          // interesting reason available. Gross debits must have grown by exactly
          // twice the correction, which is only true if both journals landed inside
          // `[from, asOf]`, and it is D-16's own statement: the zero is two recorded
          // movements, not the absence of one.
          const posting = correction.lines
            .filter((line) => line.side === 'debit')
            .reduce((total, line) => total + line.amount, 0n);
          expect((await grossDebits(reading)) - grossBefore).toBe(posting * 2n);
        }),
        { numRuns: REVERSAL_RUNS },
      );

      // Without a tagged correction the per-slice half of the claim is vacuous: every
      // amount would sit in the unassigned bucket and restoring it would prove nothing
      // about slices at all.
      expect(taggedRuns).toBeGreaterThan(REVERSAL_RUNS / 2);
    },
    SHRINKING_BUDGET_MS,
  );

  it(
    'restores every total when left untagged, and moves no tagged slice (D-32)',
    async () => {
      let taggedRuns = 0;

      await fc.assert(
        fc.asyncProperty(crossReportCaseArb, async ({ plan, correction }) => {
          const ledger = await materializeBalanceSheet(harness, plan);
          const reading = readingFor(plan, ledger);
          const touched = touchedAccounts(ledger, correction);

          // Three readings, so the per-account ledger sweep is narrowed to the
          // accounts the correction touches. Reading every account's ledger three
          // times is the property above's job, and repeating it here would triple the
          // suite's cost to restate a claim that is already made.
          const scope = { ledgerAccountIds: touched, slicedAccountIds: touched };

          const before = await readEveryReport(reading, scope);
          const posted = await postCorrection(ledger, correction);
          const midway = await readEveryReport(reading, scope);

          await reverseCorrection(ledger, posted, { copyTags: false });
          const after = await readEveryReport(reading, scope);

          const tagged = correction.lines.some((line) => line.tags.a !== null);
          if (tagged) taggedRuns += 1;

          // The totals come back. An untagged reversal is still a reversal: nothing
          // about the tag table changes what a line does to an account's balance.
          expect(after.unsliced).toEqual(before.unsliced);

          // And no tagged bucket moves, because the reversal carries no tag. Stated
          // against the reading taken *after* the correction rather than before it:
          // the correction's own tagged lines are in both, so what is asserted is
          // that the reversal alone left them alone. With B6 — slices plus unassigned
          // equal the whole, proven in `report-slices.test.ts` — the two assertions
          // together say the reversal landed entirely in the unassigned bucket, which
          // is exactly D-32's cost and the reason `setJournalLineDimensions` is the
          // operation for retagging an amount that already exists.
          expect(taggedSlicesOf(after)).toEqual(taggedSlicesOf(midway));
        }),
        { numRuns: REVERSAL_RUNS },
      );

      expect(taggedRuns).toBeGreaterThan(REVERSAL_RUNS / 2);
    },
    SHRINKING_BUDGET_MS,
  );
});

describe('the balance sheet foots across a fiscal-year boundary (OB-053, D-20)', () => {
  it('rolls current-year earnings into prior-year earnings and changes nothing else', async () => {
    await fc.assert(
      fc.asyncProperty(crossReportCaseArb, async ({ plan }) => {
        const ledger = await materializeBalanceSheet(harness, plan);

        const yearEnd = fiscalYearEndDate(CURRENT_FISCAL_YEAR, plan.startMonth);
        // The very next day, by construction: a fiscal year ends on the last day of
        // the month before the start month, so these two dates are adjacent and no
        // posting can fall between them.
        const nextYearStart = fiscalYearStartDate(CURRENT_FISCAL_YEAR + 1, plan.startMonth);

        const [midYear, atEnd, nextYear, nextYearIncome] = await withContext(
          ledger.scene.ctx,
          async () => [
            await getBalanceSheet({ asOf: plan.asOf }, ledger.scene.ctx),
            await getBalanceSheet({ asOf: yearEnd }, ledger.scene.ctx),
            await getBalanceSheet({ asOf: nextYearStart }, ledger.scene.ctx),
            await getProfitAndLoss({ from: nextYearStart, to: nextYearStart }, ledger.scene.ctx),
          ],
        );

        for (const sheet of [midYear, atEnd, nextYear]) {
          expect(sheet.totals.difference).toBe('0');
        }
        expect(atEnd.fiscalYear.year).toBe(CURRENT_FISCAL_YEAR);
        expect(nextYear.fiscalYear.year).toBe(CURRENT_FISCAL_YEAR + 1);

        // Nothing is posted between the two dates, so every figure that comes from
        // an account is identical. This is the half of the claim that does *not*
        // bite on its own — D-20 records the measurement: a wrong year boundary
        // moves money between the two derived lines without changing their sum, so
        // both sheets still foot and both still print these same three totals.
        expect(nextYear.totals.assets).toBe(atEnd.totals.assets);
        expect(nextYear.totals.liabilities).toBe(atEnd.totals.liabilities);
        expect(nextYear.totals.equity).toBe(atEnd.totals.equity);

        // The half that does bite. Crossing the boundary must move the whole of the
        // closing year's earnings into the prior-year line and leave the current one
        // holding only what the new year has earned — which, on the year's first
        // day, is whatever a P&L for that single day reports. A derivation scoped to
        // the wrong year fails this while satisfying everything above it.
        expect(nextYear.totals.priorYearEarnings).toBe(
          (
            BigInt(atEnd.totals.priorYearEarnings) + BigInt(atEnd.totals.currentYearEarnings)
          ).toString(),
        );
        expect(nextYear.totals.currentYearEarnings).toBe(nextYearIncome.totals.netIncome);

        // Prior-year earnings is a property of the fiscal year, not of the date the
        // sheet is drawn on. A derivation whose lower bound drifted with `asOf` —
        // "everything before today" rather than "everything before the year" — would
        // agree with the trial balance on every account and disagree here.
        expect(midYear.totals.priorYearEarnings).toBe(atEnd.totals.priorYearEarnings);
      }),
      { numRuns: RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Reading the reports
// ---------------------------------------------------------------------------

/** The unassigned bucket's key. A dimension value id is a UUID and never empty. */
const UNASSIGNED = '';

interface Reading {
  readonly ctx: RequestContext;
  readonly asOf: string;
  readonly from: string;
  readonly axisA: Axis;
}

function readingFor(
  plan: CrossReportCase['plan'],
  ledger: MaterializedBalanceSheetLedger,
): Reading {
  return {
    ctx: ledger.scene.ctx,
    asOf: plan.asOf,
    from: fiscalYearStartDate(CURRENT_FISCAL_YEAR, plan.startMonth),
    axisA: ledger.axisA,
  };
}

/** Gross debits across the whole ledger to `asOf`, from the oracle. */
async function grossDebits(reading: Reading): Promise<bigint> {
  const trialBalance = await withContext(reading.ctx, () =>
    getTrialBalance({ asOf: reading.asOf }, reading.ctx),
  );
  return BigInt(trialBalance.totalDebits);
}

/** The distinct accounts a correction names, resolved without posting it. */
function touchedAccounts(
  ledger: MaterializedBalanceSheetLedger,
  correction: CrossReportCase['correction'],
): readonly string[] {
  return [...new Set(correction.lines.map((line) => accountId(ledger, line.code)))];
}

/**
 * Every report's net figures, flattened to two records keyed by what they describe.
 *
 * Flat records rather than the report objects themselves, for two reasons. A report
 * carries fields a reversal legitimately changes — gross debits and credits, and the
 * set of buckets, since a value whose net is zero can still have activity — so a
 * structural comparison would fail for reasons that are not the property. And a
 * `toEqual` over two nested report trees reports "objects differ"; over these it
 * reports the key, which names the account, the section and the slice.
 *
 * Absent buckets are read as `'0'` rather than skipped. The core drops a bucket with
 * no activity in the window (`balances.service.ts`), so the bucket set before a
 * correction and after it need not match — and a comparison that only visited the
 * buckets present in both would let a slice appear from nowhere.
 */
interface ReportFigures {
  /** Everything unsliced: trial balance, P&L, balance sheet, general ledger. */
  readonly unsliced: Record<string, string>;
  /** The same reports grouped by axis A, plus the axis-filtered general ledger. */
  readonly sliced: Record<string, string>;
}

interface ReadScope {
  /** The accounts whose own ledger is read. Every account when absent. */
  readonly ledgerAccountIds?: readonly string[];
  /** The accounts whose ledger is read once per axis-A value plus unassigned. */
  readonly slicedAccountIds?: readonly string[];
}

async function readEveryReport(reading: Reading, scope: ReadScope): Promise<ReportFigures> {
  const { ctx, asOf, from, axisA } = reading;
  const window = { from, to: asOf };

  const [trialBalance, statement, sheet, slicedStatement, slicedSheet] = await withContext(
    ctx,
    async () => [
      await getTrialBalance({ asOf }, ctx),
      await getProfitAndLoss(window, ctx),
      await getBalanceSheet({ asOf }, ctx),
      await getProfitAndLoss({ ...window, groupBy: axisA.id }, ctx),
      await getBalanceSheet({ asOf, groupBy: axisA.id }, ctx),
    ],
  );

  const unsliced: Record<string, string> = {};
  const sliced: Record<string, string> = {};

  for (const row of trialBalance.rows) {
    // The balance only. Debits and credits double under a reversal by design.
    unsliced[`tb/${row.code}`] = row.balance;
  }
  unsliced['tb#difference'] = trialBalance.difference;

  // The account codes each report prints, taken from the unsliced reading. Used as
  // the key set for every slice as well, because a slice need not print them all:
  // the core drops a bucket with no activity in the window, and a bucket whose net
  // is zero while its gross is not — precisely what a tagged correction and its
  // tagged reversal produce — exists after the reversal and not before it. Keying
  // off the buckets the report happened to return would then compare two records of
  // different shapes and fail for a reason that is not the property.
  const statementCodes = statementFigures(statement.groups[0]).codes;
  const sheetCodes = sheetFigures(sheet.groups[0]).codes;

  writeStatement(unsliced, 'pnl', statement.groups[0], statementCodes);
  writeSheet(unsliced, 'bs', sheet.groups[0], sheetCodes);

  for (const code of [...axisA.values.keys(), UNASSIGNED]) {
    writeStatement(
      sliced,
      `pnl@${code}`,
      groupWithKey(slicedStatement.groups, code),
      statementCodes,
    );
    writeSheet(sliced, `bs@${code}`, groupWithKey(slicedSheet.groups, code), sheetCodes);
  }

  // Every account's own ledger, over the same window the P&L used.
  const wanted = scope.ledgerAccountIds;
  for (const row of trialBalance.rows) {
    if (wanted !== undefined && !wanted.includes(row.accountId)) continue;
    const gl = await readLedger(ctx, { accountId: row.accountId, from, to: asOf });
    unsliced[`gl/${row.code}#opening`] = gl.opening.balance;
    unsliced[`gl/${row.code}#movement`] = gl.movement.balance;
    unsliced[`gl/${row.code}#closing`] = gl.closing.balance;
  }

  // The axis-filtered ledger, for the accounts the correction touched. A filter is
  // an `EXISTS` semi-join and grouping is a `LEFT JOIN` (`balances.repository.ts`),
  // so the sliced P&L and sliced sheet above say nothing about this path.
  for (const id of scope.slicedAccountIds ?? []) {
    for (const [code, valueId] of axisA.values) {
      const gl = await readLedger(ctx, {
        accountId: id,
        from,
        to: asOf,
        dimensions: [{ dimensionId: axisA.id, valueIds: [valueId] }],
      });
      sliced[`gl@${code}/${id}#closing`] = gl.closing.balance;
      sliced[`gl@${code}/${id}#movement`] = gl.movement.balance;
    }

    const unassigned = await readLedger(ctx, {
      accountId: id,
      from,
      to: asOf,
      dimensions: [{ dimensionId: axisA.id, includeUnassigned: true }],
    });
    sliced[`gl@${UNASSIGNED}/${id}#closing`] = unassigned.closing.balance;
    sliced[`gl@${UNASSIGNED}/${id}#movement`] = unassigned.movement.balance;
  }

  return { unsliced, sliced };
}

/** The sliced figures with the unassigned bucket removed. */
function taggedSlicesOf(figures: ReportFigures): Record<string, string> {
  const tagged: Record<string, string> = {};
  for (const [key, value] of Object.entries(figures.sliced)) {
    if (key.includes(`@${UNASSIGNED}/`) || key.includes(`@${UNASSIGNED}#`)) continue;
    tagged[key] = value;
  }
  return tagged;
}

function sliceKey(key: { readonly code: string } | null): string {
  return key === null ? UNASSIGNED : key.code;
}

type StatementGroup = ProfitAndLoss['groups'][number];
type SheetGroup = BalanceSheet['groups'][number];

/** A group's rows by account code, and the codes in report order. */
interface GroupFigures {
  readonly codes: readonly string[];
  readonly rows: ReadonlyMap<string, { readonly amount: string; readonly subtotal: string }>;
}

function statementFigures(group: StatementGroup | undefined): GroupFigures {
  return figuresOf(group === undefined ? [] : [...group.revenue.rows, ...group.expenses.rows]);
}

function sheetFigures(group: SheetGroup | undefined): GroupFigures {
  return figuresOf(
    group === undefined
      ? []
      : [...group.assets.rows, ...group.liabilities.rows, ...group.equity.rows],
  );
}

function figuresOf(
  rows: readonly { readonly code: string; readonly amount: string; readonly subtotal: string }[],
): GroupFigures {
  return {
    codes: rows.map((row) => row.code),
    rows: new Map(rows.map((row) => [row.code, { amount: row.amount, subtotal: row.subtotal }])),
  };
}

function groupWithKey<T extends { readonly key: { readonly code: string } | null }>(
  groups: readonly T[],
  code: string,
): T | undefined {
  return groups.find((group) => sliceKey(group.key) === code);
}

function writeStatement(
  into: Record<string, string>,
  prefix: string,
  group: StatementGroup | undefined,
  codes: readonly string[],
): void {
  const figures = statementFigures(group);
  for (const code of codes) {
    const row = figures.rows.get(code);
    into[`${prefix}/${code}`] = row?.amount ?? '0';
    into[`${prefix}/${code}#subtotal`] = row?.subtotal ?? '0';
  }

  into[`${prefix}#revenue`] = group?.revenue.total ?? '0';
  into[`${prefix}#expenses`] = group?.expenses.total ?? '0';
  into[`${prefix}#netIncome`] = group?.netIncome ?? '0';
}

function writeSheet(
  into: Record<string, string>,
  prefix: string,
  group: SheetGroup | undefined,
  codes: readonly string[],
): void {
  const figures = sheetFigures(group);
  for (const code of codes) {
    const row = figures.rows.get(code);
    into[`${prefix}/${code}`] = row?.amount ?? '0';
    into[`${prefix}/${code}#subtotal`] = row?.subtotal ?? '0';
  }

  for (const field of [
    'assets',
    'liabilities',
    'equity',
    'priorYearEarnings',
    'currentYearEarnings',
    'liabilitiesAndEquity',
    'difference',
  ] as const) {
    into[`${prefix}#${field}`] = group?.totals[field] ?? '0';
  }
}

/**
 * The P&L's net income against the sheet's current-year earnings, bucket by bucket.
 *
 * Keyed over the axis's own values plus unassigned rather than over the buckets
 * either report returned, because the two need not return the same set: the sheet
 * reads the whole chart and the P&L reads revenue and expense only, so a value tagged
 * exclusively on an asset line produces a bucket in one report and not in the other.
 * A comparison over the intersection would silently skip exactly that case.
 */
function expectEarningsAgreePerSlice(
  sheet: BalanceSheet,
  statement: ProfitAndLoss,
  axisA: Axis,
): void {
  const earnings = new Map(
    sheet.groups.map((group) => [sliceKey(group.key), group.totals.currentYearEarnings]),
  );
  const income = new Map(statement.groups.map((group) => [sliceKey(group.key), group.netIncome]));

  for (const code of [...axisA.values.keys(), UNASSIGNED]) {
    expect(earnings.get(code) ?? '0', `slice ${code || 'unassigned'}`).toBe(
      income.get(code) ?? '0',
    );
  }

  // The buckets must also add up to the report's own foot, or a per-bucket agreement
  // could hold while both reports lost the same slice.
  const summed = sheet.groups.reduce(
    (total, group) => total + BigInt(group.totals.currentYearEarnings),
    0n,
  );
  expect(summed.toString()).toBe(sheet.totals.currentYearEarnings);
  expect(sheet.totals.currentYearEarnings).toBe(statement.totals.netIncome);
}

function readLedger(
  ctx: RequestContext,
  query: Parameters<typeof getGeneralLedger>[0],
): Promise<GeneralLedger> {
  return withContext(ctx, () => getGeneralLedger(query, ctx));
}
