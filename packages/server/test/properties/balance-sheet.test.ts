import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { getTrialBalance } from '../../src/modules/ledger';
import type {
  BalanceSheet,
  BalanceSheetGroup,
  BalanceSheetRow,
  BalanceSheetSection,
} from '../../src/modules/reports';
import { getBalanceSheet } from '../../src/modules/reports';
import {
  dayBefore,
  fiscalYearEndDate,
  fiscalYearStartDate,
} from '../reports/balance-sheet-support';
import { useReportDatabase, withContext } from '../reports/support';

import {
  balanceSheetPlanArb,
  CURRENT_FISCAL_YEAR,
  materializeBalanceSheet,
} from './balance-sheet-arbitraries';

/**
 * The balance sheet over generated ledgers (OB-043; acceptance B2, B3, B6, B7).
 *
 * B3 — "the balance sheet balances without a closing journal" — is a property and
 * cannot be anything else. An example proves the arithmetic for one shape of
 * ledger, and every way of getting D-20 wrong produces a sheet that balances for
 * *some* shape: derive the earnings over the wrong fiscal year and the sheet still
 * balances (the two derived lines move money between themselves and their sum is
 * unchanged); derive it inclusive of prior years and the sheet balances for an org
 * in its first year; flip its sign and the sheet balances whenever the year's
 * result is zero. Only a generator that varies the start month, the fiscal year a
 * posting lands in, and the sign of the result can tell those apart — which is what
 * `balance-sheet-arbitraries.ts` is for, and why the trial balance is the oracle
 * for the split rather than the sheet itself.
 */
const harness = useReportDatabase();

/**
 * 30 runs per property, matching the report core's.
 *
 * A run here builds more than an OB-041 run does — seven fixed accounts on top of
 * the generated chart, four fixed journals on top of the generated ones, and a
 * fresh org with three years of periods — and measures at about 100ms against the
 * harness container, so three properties cost a few seconds. The generator is what
 * makes 30 enough: every run varies the fiscal-year start month, the chart shape,
 * the tag distribution, the amount band, and which side of the year boundary each
 * posting falls on.
 */
const RUNS = 30;

describe('the balance sheet balances without a closing journal (OB-043, B3, D-20)', () => {
  it('assets equal liabilities plus equity plus the two derived earnings lines', async () => {
    // Counted across runs rather than asserted inside one. Two independently drawn
    // amounts can coincide, and a run whose revenue exactly equalled its expenses
    // would fail a per-run "not zero" for a reason that says nothing about the
    // report. Counting instead makes the claim the one that matters: the generator
    // actually produces the state D-20 is about, on most runs rather than never.
    let priorEarningsSeen = 0;
    let currentEarningsSeen = 0;

    await fc.assert(
      fc.asyncProperty(balanceSheetPlanArb, async (plan) => {
        const { scene } = await materializeBalanceSheet(harness, plan);

        const sheet = await withContext(scene.ctx, () =>
          getBalanceSheet({ asOf: plan.asOf }, scene.ctx),
        );

        if (sheet.totals.priorYearEarnings !== '0') priorEarningsSeen += 1;
        if (sheet.totals.currentYearEarnings !== '0') currentEarningsSeen += 1;

        // B3, stated the way the sheet prints it: two numbers a reader can compare.
        expect(sheet.totals.assets).toBe(sheet.totals.liabilitiesAndEquity);
        expect(sheet.totals.difference).toBe('0');

        // The fiscal year is *resolved*, not assumed (D-17). Compared against the
        // month the generator chose rather than against `fiscalYearSpan`, so the
        // assertion does not agree with the service by construction.
        expect(sheet.fiscalYear.startMonth).toBe(plan.startMonth);
        expect(sheet.fiscalYear.year).toBe(CURRENT_FISCAL_YEAR);
        expect(sheet.fiscalYear.startDate).toBe(
          fiscalYearStartDate(CURRENT_FISCAL_YEAR, plan.startMonth),
        );
        expect(sheet.fiscalYear.endDate).toBe(
          fiscalYearEndDate(CURRENT_FISCAL_YEAR, plan.startMonth),
        );
        expect(sheet.asOf).toBe(plan.asOf);
        expect(sheet.basis).toBe('accrual');
      }),
      { numRuns: RUNS },
    );

    // If either line were zero on every run, every arrangement of the two would
    // pass and B3 would be asserting nothing about D-20.
    expect(priorEarningsSeen).toBeGreaterThan(RUNS / 2);
    expect(currentEarningsSeen).toBeGreaterThan(RUNS / 2);
  });

  it('ties to the trial balance, account by account and on both derived lines (B2)', async () => {
    await fc.assert(
      fc.asyncProperty(balanceSheetPlanArb, async (plan) => {
        const { scene } = await materializeBalanceSheet(harness, plan);
        const yearStart = fiscalYearStartDate(CURRENT_FISCAL_YEAR, plan.startMonth);

        const [sheet, atDate, beforeYear] = await withContext(scene.ctx, async () => [
          await getBalanceSheet({ asOf: plan.asOf }, scene.ctx),
          await getTrialBalance({ asOf: plan.asOf }, scene.ctx),
          await getTrialBalance({ asOf: dayBefore(yearStart) }, scene.ctx),
        ]);

        const group = soleGroup(sheet);
        const oracle = new Map(atDate.rows.map((row) => [row.accountId, row]));

        // Every printed row is the oracle's figure with one sign applied. Row for
        // row rather than in total: a projection that swapped two accounts' amounts
        // would total identically, which is the mutation class CLAUDE.md records as
        // having survived M1's example suite.
        for (const section of [group.assets, group.liabilities, group.equity]) {
          for (const row of section.rows) {
            const expected = oracle.get(row.accountId);
            if (expected === undefined) throw new Error(`No trial balance row for ${row.code}.`);

            expect(expected.type).toBe(row.type);
            expect(row.amount).toBe(
              (row.type === 'asset'
                ? BigInt(expected.balance)
                : -BigInt(expected.balance)
              ).toString(),
            );
          }
        }

        // The derived lines, from the oracle at both ends of the fiscal year. This
        // is the assertion a wrong fiscal year fails and B3 cannot: B3 only sees
        // the two lines added together, and moving the boundary moves money from
        // one to the other without changing the sum.
        expect(sheet.totals.priorYearEarnings).toBe(earningsFrom(beforeYear).toString());
        expect(sheet.totals.currentYearEarnings).toBe(
          (earningsFrom(atDate) - earningsFrom(beforeYear)).toString(),
        );

        // Every account of the chart is printed or derived, none twice.
        const printed =
          group.assets.rows.length + group.liabilities.rows.length + group.equity.rows.length;
        const earningsAccounts = atDate.rows.filter(
          (row) => row.type === 'revenue' || row.type === 'expense',
        ).length;
        expect(printed + earningsAccounts).toBe(atDate.rows.length);
      }),
      { numRuns: RUNS },
    );
  });

  it('slices plus unassigned equal the unsliced sheet, and subtotals roll up (B6, B7)', async () => {
    let slicedRuns = 0;

    await fc.assert(
      fc.asyncProperty(balanceSheetPlanArb, async (plan) => {
        const { scene, axisA } = await materializeBalanceSheet(harness, plan);

        const [whole, sliced] = await withContext(scene.ctx, async () => [
          await getBalanceSheet({ asOf: plan.asOf }, scene.ctx),
          await getBalanceSheet({ asOf: plan.asOf, groupBy: axisA.id }, scene.ctx),
        ]);

        // D-18: the unassigned bucket is not optional, and a report missing it would
        // otherwise satisfy nothing below except by accident.
        expect(sliced.groups.filter((group) => group.key === null)).toHaveLength(1);
        expect(sliced.groupBy).toBe(axisA.id);
        if (sliced.groups.length > 1) slicedRuns += 1;

        // B6 on the foot of the sheet.
        expect(sliced.totals).toEqual(whole.totals);
        for (const field of [
          'assets',
          'liabilities',
          'equity',
          'priorYearEarnings',
          'currentYearEarnings',
        ] as const) {
          const summed = sliced.groups.reduce(
            (total, group) => total + BigInt(group.totals[field]),
            0n,
          );
          expect(summed.toString()).toBe(whole.totals[field]);
        }

        // B6 account by account, which is the statement D-18 actually makes: no
        // account may gain or lose money by being looked at through an axis.
        for (const section of ['assets', 'liabilities', 'equity'] as const) {
          const wholeGroup = soleGroup(whole);
          for (const row of wholeGroup[section].rows) {
            const summed = sliced.groups.reduce(
              (total, group) => total + BigInt(rowFor(group[section], row.accountId).amount),
              0n,
            );
            expect(summed.toString()).toBe(row.amount);
          }
        }

        // B7 in every section of every bucket, including the sliced ones — a
        // subtotal that only rolled up correctly for the whole report would be a
        // subtotal computed after the grouping rather than inside it.
        for (const group of [...sliced.groups, soleGroup(whole)]) {
          for (const section of [group.assets, group.liabilities, group.equity]) {
            expectSubtotalsRollUp(section);
          }
        }
      }),
      { numRuns: RUNS },
    );

    // B6 over a single bucket is B6 over the whole report, so a run that produced
    // only the unassigned bucket proves nothing about slicing. Counted rather than
    // asserted per run: the tags are generated, and a run that happened to tag
    // nothing on axis A is a legitimate ledger.
    expect(slicedRuns).toBeGreaterThan(RUNS / 2);
  });
});

/** An unsliced sheet has exactly one group, keyed null. Asserted, never assumed. */
function soleGroup(sheet: BalanceSheet): BalanceSheetGroup {
  expect(sheet.groups).toHaveLength(1);
  expect(sheet.groupBy).toBeNull();

  const group = sheet.groups[0];
  if (group === undefined) throw new Error('An unsliced balance sheet returned no group.');
  expect(group.key).toBeNull();

  return group;
}

function rowFor(section: BalanceSheetSection, accountId: string): BalanceSheetRow {
  const row = section.rows.find((candidate) => candidate.accountId === accountId);
  if (row === undefined) {
    throw new Error(
      `No row for ${accountId}. Every group carries every account, so an absent row is the ` +
        'failure rather than the setup.',
    );
  }
  return row;
}

/**
 * B7, computed from the rows rather than read back from the report.
 *
 * The descendants are collected by walking `parentAccountId` in the section's own
 * rows, which is the pointer a client would follow to render the tree — so this
 * asserts the number a reader would compute equals the number the report printed.
 */
function expectSubtotalsRollUp(section: BalanceSheetSection): void {
  const children = new Map<string, string[]>();
  for (const row of section.rows) {
    if (row.parentAccountId === null) continue;
    const siblings = children.get(row.parentAccountId) ?? [];
    siblings.push(row.accountId);
    children.set(row.parentAccountId, siblings);
  }

  const amounts = new Map(section.rows.map((row) => [row.accountId, BigInt(row.amount)]));

  const subtreeTotal = (accountId: string): bigint => {
    const own = amounts.get(accountId) ?? 0n;
    return (children.get(accountId) ?? []).reduce(
      (total, child) => total + subtreeTotal(child),
      own,
    );
  };

  let roots = 0n;
  for (const row of section.rows) {
    expect(row.subtotal).toBe(subtreeTotal(row.accountId).toString());
    if (row.parentAccountId === null) roots += BigInt(row.subtotal);
  }

  // The section total is the sum of the *rows*, so it must also be the sum of the
  // roots' subtotals. A total taken over every row's subtotal instead would count
  // each parent's subtree once per level, which is the mistake this pins.
  expect(roots.toString()).toBe(section.total);
}

/** Revenue less expenses in the equity direction: `-(debits - credits)` over both. */
function earningsFrom(trialBalance: Awaited<ReturnType<typeof getTrialBalance>>): bigint {
  return trialBalance.rows
    .filter((row) => row.type === 'revenue' || row.type === 'expense')
    .reduce((total, row) => total - BigInt(row.balance), 0n);
}
