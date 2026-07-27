import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { getTrialBalance } from '../../src/modules/ledger';
import type {
  ProfitAndLoss,
  ProfitAndLossRow,
  ProfitAndLossSection,
} from '../../src/modules/reports';
import { getProfitAndLoss } from '../../src/modules/reports';
import { useReportDatabase, withContext } from '../reports/support';

import { dayBefore, materialize, planWithRangeArb } from './report-arbitraries';

/**
 * Acceptance B2 for the profit and loss (OB-042): the statement ties to the trial
 * balance.
 *
 * The oracle is the same one OB-041 used and for the same reason — `getTrialBalance`
 * has backed A2 since M1, has had properties behind it the whole time, and is the
 * one aggregation in this system a new number can be checked against without the
 * check being another guess. The P&L is not compared against figures a human wrote
 * down; it is compared against a trial balance *differenced* over the statement's
 * own range, account by account, over generated charts, hierarchies, tags and
 * postings.
 *
 * ## What "ties to the trial balance" is, arithmetically
 *
 * A trial balance is cumulative to a date, so the movement of one account over
 * `[from, to]` is `balance(to) - balance(dayBefore(from))` — two oracle calls and a
 * subtraction, with nothing from the report core in it. Then:
 *
 *  - a revenue row's `amount` must be **minus** that difference,
 *  - an expense row's `amount` must be **plus** it,
 *  - and therefore `netIncome` must equal `-Σ movement` over every revenue and
 *    expense account, which is B2's headline stated as one equation.
 *
 * Stating it per row as well as in total is deliberate: a report that flipped the
 * sign of both sections would still produce the correct magnitude for net income on
 * any ledger where revenue and expense happen to be equal, and the totals-only form
 * would let a revenue misclassified as an expense cancel against its own sign flip.
 *
 * The generated chart makes contra accounts — `normalBalance` is independent of
 * `type` (`arbitraries.ts`) — so a projection that signed by the normal balance
 * instead of by the type disagrees with the oracle here rather than only on a chart
 * someone remembered to write down.
 *
 * B6 and B7 are restated for this projection too, because both are properties of a
 * *report* and the core holding them says nothing about what a projection does to
 * them afterwards: a sign applied per group, or a subtotal read off the wrong node,
 * breaks them without touching the core at all.
 */
const harness = useReportDatabase();

/** 30 runs; the cost argument is on `report-trial-balance.test.ts`. */
const RUNS = 30;

interface OracleMovement {
  readonly type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  readonly code: string;
  /** `debits - credits` inside the range, from two cumulative trial balances. */
  readonly balance: bigint;
}

describe('the profit and loss ties to the trial balance (B2)', () => {
  it('reports each account’s period movement, signed to its section', async () => {
    await fc.assert(
      fc.asyncProperty(planWithRangeArb, async ({ plan, range }) => {
        const { scene } = await materialize(harness, plan);

        const [report, movement] = await withContext(scene.ctx, async () => [
          await getProfitAndLoss({ from: range.from, to: range.to }, scene.ctx),
          await oracleMovement(scene.ctx, range),
        ]);

        expectSectionMatchesOracle(soleGroup(report).revenue, movement, 'revenue');
        expectSectionMatchesOracle(soleGroup(report).expenses, movement, 'expense');
      }),
      { numRuns: RUNS },
    );
  });

  it('reports net income as the negated movement of every revenue and expense account', async () => {
    await fc.assert(
      fc.asyncProperty(planWithRangeArb, async ({ plan, range }) => {
        const { scene } = await materialize(harness, plan);

        const [report, movement] = await withContext(scene.ctx, async () => [
          await getProfitAndLoss({ from: range.from, to: range.to }, scene.ctx),
          await oracleMovement(scene.ctx, range),
        ]);

        let expected = 0n;
        for (const account of movement.values()) {
          if (account.type === 'revenue' || account.type === 'expense') expected -= account.balance;
        }

        const group = soleGroup(report);
        expect(report.totals.netIncome).toBe(expected.toString());
        expect(group.netIncome).toBe(expected.toString());
        expect(BigInt(group.revenue.total) - BigInt(group.expenses.total)).toBe(expected);
      }),
      { numRuns: RUNS },
    );
  });

  it('has a bottom line unaffected by which axis it is sliced by (B6)', async () => {
    await fc.assert(
      fc.asyncProperty(planWithRangeArb, async ({ plan, range }) => {
        const { scene, axisA } = await materialize(harness, plan);

        const query = { from: range.from, to: range.to };
        const whole = await getProfitAndLoss(query, scene.ctx);
        const sliced = await getProfitAndLoss({ ...query, groupBy: axisA.id }, scene.ctx);

        // The bucket the criterion is about. Its presence must not depend on the
        // generated ledger happening to leave a line untagged (D-18).
        expect(sliced.groups.some((group) => group.key === null)).toBe(true);
        expect(sliced.groups.at(-1)?.key).toBeNull();

        expect(sliced.totals).toEqual(whole.totals);
        expectSlicesSumToWhole(sliced, whole);
      }),
      { numRuns: RUNS },
    );
  });

  it('gives every row a subtotal equal to its subtree, in every group (B7)', async () => {
    await fc.assert(
      fc.asyncProperty(planWithRangeArb, async ({ plan, range }) => {
        const { scene, axisA } = await materialize(harness, plan);

        for (const groupBy of [undefined, axisA.id]) {
          const report = await getProfitAndLoss(
            { from: range.from, to: range.to, ...(groupBy === undefined ? {} : { groupBy }) },
            scene.ctx,
          );

          for (const group of report.groups) {
            expectSubtotalsAddUp(group.revenue);
            expectSubtotalsAddUp(group.expenses);
          }
        }
      }),
      { numRuns: RUNS },
    );
  });
});

/**
 * Every account's movement over the range, from the oracle alone.
 *
 * Two cumulative trial balances differenced, rather than anything the report core
 * computed. `dayBefore(from)` is what makes both range bounds inclusive on the
 * oracle side — a journal posted on exactly `from` belongs to the period, and the
 * generator draws its bounds from the plan's own journal dates precisely so that
 * case arises (`report-arbitraries.ts`).
 */
async function oracleMovement(
  ctx: Parameters<typeof getTrialBalance>[1],
  range: { readonly from: string; readonly to: string },
): Promise<ReadonlyMap<string, OracleMovement>> {
  const closing = await getTrialBalance({ asOf: range.to }, ctx);
  const opening = await getTrialBalance({ asOf: dayBefore(range.from) }, ctx);

  const before = new Map(opening.rows.map((row) => [row.accountId, BigInt(row.balance)]));

  return new Map(
    closing.rows.map((row) => [
      row.accountId,
      {
        type: row.type,
        code: row.code,
        balance: BigInt(row.balance) - (before.get(row.accountId) ?? 0n),
      },
    ]),
  );
}

function expectSectionMatchesOracle(
  section: ProfitAndLossSection,
  movement: ReadonlyMap<string, OracleMovement>,
  type: 'revenue' | 'expense',
): void {
  const expectedCodes = [...movement.values()]
    .filter((account) => account.type === type)
    .map((account) => account.code);

  // Order is part of the claim, as it is in the core's own oracle comparison: a
  // set comparison would let right numbers against wrong accounts pass, which is
  // the mutation class CLAUDE.md records as having survived M1's example suite.
  expect(section.rows.map((row) => row.code)).toEqual(expectedCodes);

  let total = 0n;
  for (const row of section.rows) {
    const account = movement.get(row.accountId);
    if (account === undefined) throw new Error('The statement reported an unknown account.');

    const expected = type === 'revenue' ? -account.balance : account.balance;
    expect(row.amount).toBe(expected.toString());
    expect(row.type).toBe(type);
    total += expected;
  }

  expect(section.total).toBe(total.toString());
}

function expectSlicesSumToWhole(sliced: ProfitAndLoss, whole: ProfitAndLoss): void {
  const wholeGroup = soleGroup(whole);

  for (const key of ['revenue', 'expenses'] as const) {
    const summed = new Map<string, bigint>();
    for (const group of sliced.groups) {
      for (const row of group[key].rows) {
        summed.set(row.accountId, (summed.get(row.accountId) ?? 0n) + BigInt(row.amount));
      }
    }

    expect(summed.size).toBe(wholeGroup[key].rows.length);
    for (const row of wholeGroup[key].rows) {
      expect(summed.get(row.accountId)).toBe(BigInt(row.amount));
    }
  }
}

/**
 * Every row's subtotal against its own subtree, recomputed from the flat rows and
 * their parent pointers rather than from anything the report nested.
 *
 * Plus the check no per-row assertion can make: the roots' subtotals must add up to
 * the section total, which is what catches a row counted in the total and in no
 * subtree — B7's other half, stated the way `report-subtotals.test.ts` states it.
 */
function expectSubtotalsAddUp(section: ProfitAndLossSection): void {
  const amounts = new Map(section.rows.map((row) => [row.accountId, BigInt(row.amount)]));
  const childrenOf = new Map<string, ProfitAndLossRow[]>();
  const roots: ProfitAndLossRow[] = [];

  for (const row of section.rows) {
    const parent = row.parentAccountId;
    if (parent === null || !amounts.has(parent)) {
      roots.push(row);
      continue;
    }
    const siblings = childrenOf.get(parent) ?? [];
    siblings.push(row);
    childrenOf.set(parent, siblings);
  }

  const subtreeOf = (row: ProfitAndLossRow): bigint => {
    let total = amounts.get(row.accountId) ?? 0n;
    for (const child of childrenOf.get(row.accountId) ?? []) total += subtreeOf(child);
    return total;
  };

  for (const row of section.rows) expect(row.subtotal).toBe(subtreeOf(row).toString());

  let fromRoots = 0n;
  for (const root of roots) fromRoots += BigInt(root.subtotal);
  expect(fromRoots.toString()).toBe(section.total);
}

/** An unsliced statement has exactly one group, whose key is null. */
function soleGroup(report: ProfitAndLoss): ProfitAndLoss['groups'][number] {
  expect(report.groups).toHaveLength(1);
  expect(report.groupBy).toBeNull();

  const group = report.groups[0];
  if (group === undefined) throw new Error('An unsliced statement returned no group.');
  expect(group.key).toBeNull();

  return group;
}
