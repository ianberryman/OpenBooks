import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { AccountBalance, AccountBalances } from '../../src/modules/reports';
import {
  addAccountBalance,
  getAccountBalances,
  ZERO_ACCOUNT_BALANCE,
} from '../../src/modules/reports';
import { useReportDatabase } from '../reports/support';

import { AXIS_B_VALUES, materialize, planWithRangeArb, reportPlanArb } from './report-arbitraries';

/**
 * Acceptance B6: dimension tagging never moves money.
 *
 * "Every report unsliced equals its slices plus unassigned." The last three words
 * are the ones that make it a real property. A slice view that omits untagged
 * lines shows a smaller business than exists (D-18), and it does it most on the
 * accounts nobody remembered to tag — so a suite that only compared the tagged
 * buckets against each other would pass against exactly the implementation the
 * criterion exists to forbid.
 *
 * The generator tags each line on two independent axes and leaves either or both
 * untagged, which is what gives these properties teeth against the failure D-18
 * predicted: `journal_line_dimensions` holds one row per line per axis, so a
 * report that *joined* the tag table rather than semi-joining it would count a
 * doubly-tagged line twice. That is invisible with one axis, invisible with
 * examples where every line carries every axis, and caught here.
 */
const harness = useReportDatabase();

/** Heavier runs than the M1 ledger properties; the reasoning is on `report-trial-balance.test.ts`. */
const RUNS = 30;

describe('slices plus unassigned equal the whole (B6)', () => {
  it('sums to the ungrouped report, account by account, over any range', async () => {
    await fc.assert(
      fc.asyncProperty(planWithRangeArb, async ({ plan, range }) => {
        const { scene, axisA } = await materialize(harness, plan);

        const query = { from: range.from, to: range.to };
        const ungrouped = await getAccountBalances(query, scene.ctx);
        const grouped = await getAccountBalances({ ...query, groupBy: axisA.id }, scene.ctx);

        // Not a formality: the bucket is what the criterion is about, and its
        // presence must not depend on whether the generated ledger happened to
        // leave a line untagged.
        expect(grouped.groups.some((group) => group.key === null)).toBe(true);
        expect(grouped.groups.at(-1)?.key).toBeNull();

        expectSlicesSumToWhole(grouped, ungrouped);
      }),
      { numRuns: RUNS },
    );
  });

  it('still sums to the whole when a second axis is filtered at the same time', async () => {
    await fc.assert(
      fc.asyncProperty(reportPlanArb, async (plan) => {
        const { scene, axisA, axisB } = await materialize(harness, plan);
        const dimensions = [{ dimensionId: axisB.id, valueIds: [valueOf(axisB, 'B0')] }];

        const ungrouped = await getAccountBalances({ dimensions }, scene.ctx);
        const grouped = await getAccountBalances({ dimensions, groupBy: axisA.id }, scene.ctx);

        // Grouping on one axis while filtering another is the shape that
        // multiplies rows if the tag table is joined rather than semi-joined, and
        // a line carrying both axes is counted twice by exactly that mistake.
        expectSlicesSumToWhole(grouped, ungrouped);
      }),
      { numRuns: RUNS },
    );
  });

  it('filtering an axis to every value plus unassigned is filtering nothing', async () => {
    await fc.assert(
      fc.asyncProperty(planWithRangeArb, async ({ plan, range }) => {
        const { scene, axisB } = await materialize(harness, plan);

        const query = { from: range.from, to: range.to };
        const unfiltered = await getAccountBalances(query, scene.ctx);
        const filtered = await getAccountBalances(
          {
            ...query,
            dimensions: [
              {
                dimensionId: axisB.id,
                valueIds: everyValueOf(axisB),
                includeUnassigned: true,
              },
            ],
          },
          scene.ctx,
        );

        // The tagged and untagged branches of a filter must partition the lines:
        // together they are every line, and neither may pick up a line twice. A
        // `NOT EXISTS` that tested the wrong axis, or an `EXISTS` that dropped the
        // axis predicate, breaks this and nothing else in the suite.
        expectSameBalances(filtered, unfiltered);
      }),
      { numRuns: RUNS },
    );
  });
});

function expectSlicesSumToWhole(grouped: AccountBalances, ungrouped: AccountBalances): void {
  const summed = new Map<string, AccountBalance>();
  for (const group of grouped.groups) {
    for (const row of group.rows) {
      summed.set(
        row.accountId,
        addAccountBalance(summed.get(row.accountId) ?? ZERO_ACCOUNT_BALANCE, row.balance),
      );
    }
  }

  const whole = ungrouped.groups[0];
  if (whole === undefined) throw new Error('The ungrouped report returned no group.');

  expect(summed.size).toBe(whole.rows.length);
  for (const row of whole.rows) {
    expect(summed.get(row.accountId)).toEqual(row.balance);
  }

  expect(grouped.totals).toEqual(ungrouped.totals);
}

function expectSameBalances(left: AccountBalances, right: AccountBalances): void {
  const leftGroup = left.groups[0];
  const rightGroup = right.groups[0];
  if (leftGroup === undefined || rightGroup === undefined) {
    throw new Error('An ungrouped report returned no group.');
  }

  expect(leftGroup.rows.map((row) => row.accountId)).toEqual(
    rightGroup.rows.map((row) => row.accountId),
  );
  for (const [index, row] of leftGroup.rows.entries()) {
    expect(row.balance).toEqual(rightGroup.rows[index]?.balance);
  }
  expect(left.totals).toEqual(right.totals);
}

function valueOf(axis: { readonly values: ReadonlyMap<string, string> }, code: string): string {
  const id = axis.values.get(code);
  if (id === undefined) throw new Error(`Axis has no value ${code}.`);
  return id;
}

function everyValueOf(axis: { readonly values: ReadonlyMap<string, string> }): string[] {
  const ids = [...axis.values.values()];
  expect(ids).toHaveLength(AXIS_B_VALUES);
  return ids;
}
