import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { getTrialBalance } from '../../src/modules/ledger';
import type { AccountBalances, ReportGroup } from '../../src/modules/reports';
import { getAccountBalances } from '../../src/modules/reports';
import { useReportDatabase, withContext } from '../reports/support';

import { dayBefore, materialize, planWithRangeArb, reportPlanArb } from './report-arbitraries';

/**
 * The report core against its oracle (OB-041).
 *
 * `getTrialBalance` backs acceptance A2, has had property tests behind it since
 * M1, and has been correct the whole time. That makes it the one thing in this
 * system a new aggregation can be checked against without the check being another
 * guess: rather than asserting that the core returns numbers a human wrote down,
 * these properties assert that a trial balance *derived through the core* is the
 * trial balance the oracle produces — over randomly generated charts, hierarchies,
 * tags and postings, for randomly chosen dates.
 *
 * The oracle is not touched. Nothing here calls into it except to read.
 *
 * Three relations, each stronger than the last:
 *
 *  1. **Closing reproduces `asOf`.** A report with no lower bound and `to = asOf`
 *     must equal `getTrialBalance({ asOf })`, account for account and total for
 *     total. This is the statement that the range mechanism did not change the
 *     aggregation.
 *  2. **Opening reproduces the day before `from`.** The postings before a range
 *     are a trial balance in their own right, so `opening` must equal
 *     `getTrialBalance({ asOf: dayBefore(from) })`.
 *  3. **Opening plus movement is closing, and closing is `asOf: to`.** Acceptance
 *     B4, checked against the oracle at both ends rather than against itself.
 *
 * Together they pin every arm of the decomposition to an independently-correct
 * answer, which no example test could do: the boundary between "before the range"
 * and "in the range" is one `<` against one `>=` in one `CASE`, and an off-by-one
 * day there is invisible unless a generated journal happens to land on exactly the
 * boundary date. Over a few hundred generated journals across a year, one does.
 */
const harness = useReportDatabase();

/**
 * 30 runs, against the 75 the M1 ledger properties use.
 *
 * A run here is heavier than a posting run by roughly a factor of three: it builds
 * a chart through `createAccount` (a locking parent walk per account), two axes
 * with five values, and then posts and tags every line through the real services.
 * Measured at about 200ms a run against the harness container, so 30 runs is a few
 * seconds per property. The generator is what makes that enough — every run varies
 * the chart shape, the tag distribution, the amount band and the dates, so the
 * thirtieth run is a different ledger rather than a repeat.
 */
const RUNS = 30;

describe('the report core reproduces the trial balance (OB-041, oracle: A2)', () => {
  it('closing with no lower bound equals the trial balance as at the same date', async () => {
    await fc.assert(
      fc.asyncProperty(planWithRangeArb, async ({ plan, range }) => {
        const { scene } = await materialize(harness, plan);

        const [report, oracle] = await withContext(scene.ctx, async () => [
          await getAccountBalances({ to: range.to }, scene.ctx),
          await getTrialBalance({ asOf: range.to }, scene.ctx),
        ]);

        expectAgreesWithTrialBalance(soleGroup(report), oracle, 'closing');

        // The opening half must be *empty*, not merely consistent. A report with
        // no lower bound has nothing before it by definition, and an
        // implementation that quietly summed the whole ledger into `opening` and
        // nothing into `movement` would satisfy the closing comparison above.
        for (const row of soleGroup(report).rows) {
          expect(row.balance.opening).toEqual({ debits: 0n, credits: 0n, balance: 0n });
          expect(row.balance.movement).toEqual(row.balance.closing);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('opening equals the trial balance as at the day before the range', async () => {
    await fc.assert(
      fc.asyncProperty(planWithRangeArb, async ({ plan, range }) => {
        const { scene } = await materialize(harness, plan);

        const [report, oracle] = await withContext(scene.ctx, async () => [
          await getAccountBalances({ from: range.from, to: range.to }, scene.ctx),
          await getTrialBalance({ asOf: dayBefore(range.from) }, scene.ctx),
        ]);

        expectAgreesWithTrialBalance(soleGroup(report), oracle, 'opening');
      }),
      { numRuns: RUNS },
    );
  });

  it('opening plus movement equals closing, and closing equals the trial balance (B4)', async () => {
    await fc.assert(
      fc.asyncProperty(planWithRangeArb, async ({ plan, range }) => {
        const { scene } = await materialize(harness, plan);

        const [report, oracle] = await withContext(scene.ctx, async () => [
          await getAccountBalances({ from: range.from, to: range.to }, scene.ctx),
          await getTrialBalance({ asOf: range.to }, scene.ctx),
        ]);

        for (const row of soleGroup(report).rows) {
          expect(row.balance.closing.debits).toBe(
            row.balance.opening.debits + row.balance.movement.debits,
          );
          expect(row.balance.closing.credits).toBe(
            row.balance.opening.credits + row.balance.movement.credits,
          );
        }

        expectAgreesWithTrialBalance(soleGroup(report), oracle, 'closing');
      }),
      { numRuns: RUNS },
    );
  });

  it('an unbounded report equals the trial balance with no asOf at all', async () => {
    await fc.assert(
      fc.asyncProperty(reportPlanArb, async (plan) => {
        const { scene } = await materialize(harness, plan);

        const [report, oracle] = await withContext(scene.ctx, async () => [
          await getAccountBalances({}, scene.ctx),
          await getTrialBalance({}, scene.ctx),
        ]);

        expectAgreesWithTrialBalance(soleGroup(report), oracle, 'closing');
      }),
      { numRuns: RUNS },
    );
  });
});

/**
 * An ungrouped report has exactly one group. Asserted rather than assumed, because
 * a core that produced two would make every comparison below read half a ledger
 * and still pass whenever the other half was empty.
 */
function soleGroup(report: AccountBalances): ReportGroup {
  expect(report.groups).toHaveLength(1);
  expect(report.groupBy).toBeNull();

  const group = report.groups[0];
  if (group === undefined) throw new Error('An ungrouped report returned no group.');
  expect(group.key).toBeNull();

  return group;
}

/**
 * Row for row, in order, plus the totals.
 *
 * The order is part of the claim. Both sides sort by account code, and comparing
 * as sets would let a core that returned the right numbers against the wrong
 * accounts pass — which is exactly the mutation class CLAUDE.md records as having
 * survived M1's example suite.
 */
function expectAgreesWithTrialBalance(
  group: ReportGroup,
  oracle: Awaited<ReturnType<typeof getTrialBalance>>,
  arm: 'opening' | 'movement' | 'closing',
): void {
  expect(group.rows.map((row) => row.code)).toEqual(oracle.rows.map((row) => row.code));

  let debits = 0n;
  let credits = 0n;

  for (const [index, row] of group.rows.entries()) {
    const expected = oracle.rows[index];
    if (expected === undefined) throw new Error('The oracle returned fewer rows than the report.');

    const amounts = row.balance[arm];
    expect(row.accountId).toBe(expected.accountId);
    expect(amounts.debits.toString()).toBe(expected.debits);
    expect(amounts.credits.toString()).toBe(expected.credits);
    expect(amounts.balance.toString()).toBe(expected.balance);

    debits += amounts.debits;
    credits += amounts.credits;
  }

  expect(debits.toString()).toBe(oracle.totalDebits);
  expect(credits.toString()).toBe(oracle.totalCredits);
  expect(group.totals[arm].debits.toString()).toBe(oracle.totalDebits);
  expect(group.totals[arm].credits.toString()).toBe(oracle.totalCredits);
}
