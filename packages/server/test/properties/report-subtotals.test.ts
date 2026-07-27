import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { AccountBalanceNode, ReportGroup } from '../../src/modules/reports';
import {
  addAccountBalance,
  getAccountBalances,
  sumAccountBalances,
  ZERO_ACCOUNT_BALANCE,
} from '../../src/modules/reports';
import { useReportDatabase } from '../reports/support';

import { materialize, planWithRangeArb, reportPlanArb } from './report-arbitraries';

/**
 * Acceptance B7, the subtotal half: a parent's subtotal equals the sum of its
 * descendants.
 *
 * The cycle half is OB-035's and is asserted in `test/accounts/hierarchy.test.ts`
 * against two live connections; nothing here re-litigates it. What is checked here
 * is the arithmetic the hierarchy exists to make possible, over generated charts
 * whose shape varies run to run — a chain, a fan, several roots, a single account
 * with no parent at all.
 *
 * Two claims, and the second is the one an example test would miss:
 *
 *  1. Every node's subtotal is the sum of its subtree's own balances, recomputed
 *     here from the flat rows rather than from the tree the core built.
 *  2. **Every row is in exactly one tree.** The roots' subtotals must add up to
 *     the group's totals, which is what catches an account silently dropped from
 *     the forest — a row in the totals and in no subtotal, which no per-node
 *     assertion can see.
 *
 * The generator makes a child adopt its parent's type, so charts here are as deep
 * as they were asked to be. `normalBalance` stays independent of `type`, which
 * puts contra accounts under ordinary parents: a rollup that decided which way to
 * accumulate from the normal balance rather than simply adding debits to debits
 * would be right for every ordinary chart and wrong for those.
 */
const harness = useReportDatabase();

const RUNS = 30;

describe('hierarchy subtotals equal the sum of descendants (B7)', () => {
  it('holds for every node, in every group, over any range', async () => {
    await fc.assert(
      fc.asyncProperty(planWithRangeArb, async ({ plan, range }) => {
        const { scene, axisA } = await materialize(harness, plan);

        for (const groupBy of [undefined, axisA.id]) {
          const report = await getAccountBalances(
            { from: range.from, to: range.to, ...(groupBy === undefined ? {} : { groupBy }) },
            scene.ctx,
          );

          for (const group of report.groups) expectSubtotalsAddUp(group);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('puts a parent’s own postings in its subtotal and not only its children’s', async () => {
    await fc.assert(
      fc.asyncProperty(reportPlanArb, async (plan) => {
        const { scene } = await materialize(harness, plan);
        const report = await getAccountBalances({}, scene.ctx);
        const group = report.groups[0];
        if (group === undefined) throw new Error('An ungrouped report returned no group.');

        for (const node of everyNode(group.tree)) {
          const childrenOnly = sumAccountBalances(node.children.map((child) => child.subtotal));

          // Stated as a difference rather than as a sum, so a subtotal that
          // ignored the parent's own row passes only when the parent has no
          // postings — which, over generated ledgers, it frequently does have.
          expect(node.subtotal).toEqual(addAccountBalance(childrenOnly, node.row.balance));
        }
      }),
      { numRuns: RUNS },
    );
  });
});

function expectSubtotalsAddUp(group: ReportGroup): void {
  const balances = new Map(group.rows.map((row) => [row.accountId, row.balance]));
  const seen = new Set<string>();

  for (const node of everyNode(group.tree)) {
    seen.add(node.row.accountId);

    let expected = ZERO_ACCOUNT_BALANCE;
    for (const descendant of everyNode([node])) {
      const balance = balances.get(descendant.row.accountId);
      if (balance === undefined) throw new Error('A node names an account with no row.');
      expected = addAccountBalance(expected, balance);
    }

    expect(node.subtotal).toEqual(expected);
  }

  // Exactly one tree per row, and no row outside the forest.
  expect(seen.size).toBe(group.rows.length);
  expect(sumAccountBalances(group.tree.map((root) => root.subtotal))).toEqual(group.totals);
}

function* everyNode(nodes: readonly AccountBalanceNode[]): Generator<AccountBalanceNode> {
  for (const node of nodes) {
    yield node;
    yield* everyNode(node.children);
  }
}
