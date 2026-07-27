import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { AccountBalance, AccountBalances } from '../../src/modules/reports';
import { getAccountBalances, isZeroBalance, sumAccountBalances } from '../../src/modules/reports';
import { useReportDatabase } from '../reports/support';

import { materialize, planWithRangeArb } from './report-arbitraries';

/**
 * The core's account filter is a restriction and nothing else (OB-041).
 *
 * `AccountBalancesOptions.accountIds` exists so the general ledger can read one
 * account's decomposition without aggregating a whole account type to find it. A
 * filter added to the query every M2 report is projected from is only safe if it
 * is *provably* invisible in the numbers — so the statement asserted here is the
 * strongest one available and the one that makes the filter usable anywhere:
 *
 *   for any subset of the chart, the filtered report equals the unfiltered report
 *   restricted to that subset.
 *
 * Not "the totals agree", which a filter that quietly widened to the whole chart
 * would fail only when some account outside the subset happened to be non-zero;
 * and not "the subset's accounts are present", which a filter that ignored its
 * argument entirely would pass. Equality against the unfiltered report is what
 * catches both, and `fc.subarray` supplies the two subsets an example suite always
 * forgets: the empty one, where a filter that folded emptiness back into "no
 * filter" answers a request for nothing with everything, and the full one, where
 * the filter must be a no-op.
 *
 * B2, B4, B6 and B7 continue to be asserted against the unfiltered core in the
 * files beside this one. This property is what says they carry over to a filtered
 * call, since a restriction of a report satisfying them satisfies them too.
 */
const harness = useReportDatabase();

/** 30 runs, matching the other OB-041 properties; the reasoning is on `report-trial-balance.test.ts`. */
const RUNS = 30;

const planWithSubsetArb = planWithRangeArb.chain(({ plan, range }) =>
  fc.subarray(plan.accounts.map((_, index) => index)).map((indices) => ({ plan, range, indices })),
);

describe('the report core’s account filter (OB-041)', () => {
  it('returns exactly the unfiltered report restricted to the named accounts', async () => {
    await fc.assert(
      fc.asyncProperty(planWithSubsetArb, async ({ plan, range, indices }) => {
        const { scene, accounts } = await materialize(harness, plan);
        const subset = indices.map((index) => accountId(accounts, index));

        const query = { from: range.from, to: range.to };
        const unfiltered = await getAccountBalances(query, scene.ctx);
        const filtered = await getAccountBalances(query, scene.ctx, { accountIds: subset });

        const expected = onlyGroup(unfiltered).rows.filter((row) => subset.includes(row.accountId));

        // `toEqual` on whole rows, not on balances: an account filter that also
        // disturbed a row's code, type, parent or `isActive` would leave every
        // arithmetic assertion in this directory passing while the report named
        // the wrong accounts. The ordering rides along — the core returns account
        // code order, and a restriction of an ordered list is still ordered.
        expect(onlyGroup(filtered).rows).toEqual(expected);
        expect(filtered.totals).toEqual(sumAccountBalances(expected.map((row) => row.balance)));
        expect(filtered.range).toEqual(unfiltered.range);
      }),
      { numRuns: RUNS },
    );
  });

  it('restricts each bucket of a grouped report, and still always has the unassigned one', async () => {
    await fc.assert(
      fc.asyncProperty(planWithSubsetArb, async ({ plan, range, indices }) => {
        const { scene, accounts, axisA } = await materialize(harness, plan);
        const subset = indices.map((index) => accountId(accounts, index));

        const query = { from: range.from, to: range.to, groupBy: axisA.id };
        const unfiltered = await getAccountBalances(query, scene.ctx);
        const filtered = await getAccountBalances(query, scene.ctx, { accountIds: subset });

        // Every bucket carries exactly the accounts asked for, in the chart's own
        // order — any of the unfiltered report's buckets will do to read that
        // order off, since the core is dense. Asserted separately from the
        // balances because the comparison below reads both reports through the
        // same subset, and so is blind on its own to a filter that returned more
        // accounts than it was given.
        const expectedIds = (unfiltered.groups[0]?.rows ?? [])
          .map((row) => row.accountId)
          .filter((id) => subset.includes(id));
        for (const group of filtered.groups) {
          expect(group.rows.map((row) => row.accountId)).toEqual(expectedIds);
        }

        // Grouped is where a restriction can go wrong in a way ungrouped cannot: a
        // bucket owed entirely to accounts outside the subset must disappear, and
        // one owed partly to them must shrink rather than vanish. Comparing the
        // (bucket, account) balances of both reports says both at once.
        expect(nonZeroBalances(filtered, subset)).toEqual(nonZeroBalances(unfiltered, subset));

        // D-18: the unassigned bucket is not conditional on anything — least of all
        // on which accounts were asked for, including none of them.
        expect(filtered.groups.at(-1)?.key).toBeNull();
        expect(filtered.groups.filter((group) => group.key === null)).toHaveLength(1);
      }),
      { numRuns: RUNS },
    );
  });
});

function accountId(accounts: readonly { readonly id: string }[], index: number): string {
  const account = accounts[index];
  if (account === undefined) throw new Error(`Materialized chart has no account at ${index}.`);
  return account.id;
}

function onlyGroup(report: AccountBalances) {
  const group = report.groups[0];
  if (group === undefined) throw new Error('An ungrouped report returned no group.');
  if (report.groups.length !== 1) throw new Error('An ungrouped report returned several groups.');
  return group;
}

/**
 * Every non-zero `(bucket, account)` balance of a report, for the named accounts.
 *
 * Zeros are dropped on both sides rather than compared, because the core already
 * drops a bucket whose every amount is zero (`balances.service.ts`) — so a bucket
 * the restriction empties is absent from one report and present-and-zero in the
 * other, and that difference is the documented behaviour rather than the failure
 * this is looking for.
 */
function nonZeroBalances(
  report: AccountBalances,
  accountIds: readonly string[],
): ReadonlyMap<string, AccountBalance> {
  const balances = new Map<string, AccountBalance>();

  for (const group of report.groups) {
    for (const row of group.rows) {
      if (!accountIds.includes(row.accountId) || isZeroBalance(row.balance)) continue;
      balances.set(`${group.key?.dimensionValueId ?? ''}|${row.accountId}`, row.balance);
    }
  }

  return balances;
}
