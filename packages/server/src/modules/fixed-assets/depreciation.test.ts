import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { computeDepreciationSchedule } from './depreciation';
import type { DepreciationScheduleRow } from './depreciation';

/**
 * `computeDepreciationSchedule`'s arithmetic (OB-164, OB-168; ROADMAP D-114, L2,
 * L6), pure and colocated — `compute-term.test.ts`'s own reason: nothing here
 * reads a row, so nothing here needs `useTestDatabase()`.
 *
 * The property every example test in this file's sibling files takes for granted
 * and this one actually proves: `Σ depreciationAmountMinor` equals
 * `acquisitionCostMinor − salvageValueMinor` exactly, for both methods, over a
 * spread of costs, salvage values, lives and rates fast-check generates rather
 * than the handful an author would have thought to try. A two-line example suite
 * could not have caught a mutation that dropped the final period's true-up —
 * every hand-written example in `compute-term.test.ts`'s style divides evenly by
 * construction (CLAUDE.md's mutation-testing habit, restated here for the one
 * function in this module worth it).
 */

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

function sumMinor(rows: readonly DepreciationScheduleRow[]): bigint {
  return rows.reduce((total, row) => total + row.depreciationAmountMinor, 0n);
}

/** A calendar date built from independently-ranged parts, so day 29–31 exercises the month clamp. */
const inServiceDateArb = fc
  .record({
    year: fc.integer({ min: 2000, max: 2099 }),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 28 }),
  })
  .map(({ year, month, day }) => {
    const y = String(year).padStart(4, '0');
    const m = String(month).padStart(2, '0');
    const d = String(day).padStart(2, '0');
    return `${y}-${m}-${d}`;
  });

/** `salvage < cost`, both non-negative — `chk_fixed_assets_salvage`'s own bound. */
const costAndSalvageArb = fc
  .tuple(fc.integer({ min: 1, max: 100_000_000 }), fc.integer({ min: 0, max: 1_000_000 }))
  .map(([costUnits, salvageFraction]): { cost: bigint; salvage: bigint } => {
    const cost = BigInt(costUnits);
    // Scale salvage down from `cost` by a fraction in [0, 1), so it stays
    // strictly below cost across the whole generated range without a rejection
    // filter thinning out fast-check's shrinking.
    const salvage = (cost * BigInt(salvageFraction)) / 1_000_001n;
    return { cost, salvage };
  });

const usefulLifeMonthsArb = fc.integer({ min: 1, max: 360 });
const decliningRatePpmArb = fc.integer({ min: 1, max: 1_000_000 });

describe('straight_line', () => {
  const arb = fc.record({
    costAndSalvage: costAndSalvageArb,
    usefulLifeMonths: usefulLifeMonthsArb,
    inServiceDate: inServiceDateArb,
  });

  it('sums to exactly cost minus salvage', () => {
    fc.assert(
      fc.property(arb, ({ costAndSalvage, usefulLifeMonths, inServiceDate }) => {
        const rows = computeDepreciationSchedule({
          acquisitionCostMinor: costAndSalvage.cost,
          salvageValueMinor: costAndSalvage.salvage,
          method: 'straight_line',
          usefulLifeMonths,
          decliningRatePpm: null,
          inServiceDate,
        });

        expect(sumMinor(rows)).toBe(costAndSalvage.cost - costAndSalvage.salvage);
      }),
    );
  });

  it('produces exactly usefulLifeMonths rows, none negative, strictly increasing dates', () => {
    fc.assert(
      fc.property(arb, ({ costAndSalvage, usefulLifeMonths, inServiceDate }) => {
        const rows = computeDepreciationSchedule({
          acquisitionCostMinor: costAndSalvage.cost,
          salvageValueMinor: costAndSalvage.salvage,
          method: 'straight_line',
          usefulLifeMonths,
          decliningRatePpm: null,
          inServiceDate,
        });

        expect(rows).toHaveLength(usefulLifeMonths);
        expectNeverNegativeAndOrdered(rows);
      }),
    );
  });

  it('a single-period asset charges the whole base in period 0', () => {
    const rows = computeDepreciationSchedule({
      acquisitionCostMinor: 150_000n,
      salvageValueMinor: 30_000n,
      method: 'straight_line',
      usefulLifeMonths: 1,
      decliningRatePpm: null,
      inServiceDate: '2026-01-15',
    });

    expect(rows).toEqual([
      { periodIndex: 0, periodDate: '2026-01-15', depreciationAmountMinor: 120_000n },
    ]);
  });

  it('a base that does not divide evenly still sums exactly, on the last period', () => {
    // 100 over 3 months: floor(100/3) = 33 for the first two, and the third
    // absorbs the remainder rather than losing a cent to truncation.
    const rows = computeDepreciationSchedule({
      acquisitionCostMinor: 100n,
      salvageValueMinor: 0n,
      method: 'straight_line',
      usefulLifeMonths: 3,
      decliningRatePpm: null,
      inServiceDate: '2026-01-31',
    });

    expect(rows.map((row) => row.depreciationAmountMinor)).toEqual([33n, 33n, 34n]);
    // The month-end clamp: 31 Jan + 1 month lands on 28 Feb (2026 is not a leap
    // year), and + 2 months reaches 31 Mar again since March has 31 days —
    // `engine.ts`'s own `addMonths` behaviour, restated here.
    expect(rows.map((row) => row.periodDate)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
  });
});

describe('declining_balance', () => {
  const arb = fc.record({
    costAndSalvage: costAndSalvageArb,
    usefulLifeMonths: usefulLifeMonthsArb,
    decliningRatePpm: decliningRatePpmArb,
    inServiceDate: inServiceDateArb,
  });

  it('sums to exactly cost minus salvage, whatever the rate', () => {
    fc.assert(
      fc.property(arb, ({ costAndSalvage, usefulLifeMonths, decliningRatePpm, inServiceDate }) => {
        const rows = computeDepreciationSchedule({
          acquisitionCostMinor: costAndSalvage.cost,
          salvageValueMinor: costAndSalvage.salvage,
          method: 'declining_balance',
          usefulLifeMonths,
          decliningRatePpm,
          inServiceDate,
        });

        expect(sumMinor(rows)).toBe(costAndSalvage.cost - costAndSalvage.salvage);
      }),
    );
  });

  it('never takes a period below the salvage floor, and never goes negative', () => {
    fc.assert(
      fc.property(arb, ({ costAndSalvage, usefulLifeMonths, decliningRatePpm, inServiceDate }) => {
        const rows = computeDepreciationSchedule({
          acquisitionCostMinor: costAndSalvage.cost,
          salvageValueMinor: costAndSalvage.salvage,
          method: 'declining_balance',
          usefulLifeMonths,
          decliningRatePpm,
          inServiceDate,
        });

        expect(rows).toHaveLength(usefulLifeMonths);
        expectNeverNegativeAndOrdered(rows);

        // Book value after each period, reconstructed from the amounts, never
        // drops below salvage — the floor the per-period charge is capped at.
        let bookValue = costAndSalvage.cost;
        for (const row of rows) {
          bookValue -= row.depreciationAmountMinor;
          expect(bookValue >= costAndSalvage.salvage).toBe(true);
        }
      }),
    );
  });

  it('a high rate against a long life reaches the salvage floor early and trues up to zero', () => {
    // 100% of book value per period exhausts the depreciable base in period 0;
    // every period after that — including the guarded final true-up — charges
    // zero rather than a negative amount.
    const rows = computeDepreciationSchedule({
      acquisitionCostMinor: 100_000n,
      salvageValueMinor: 20_000n,
      method: 'declining_balance',
      usefulLifeMonths: 4,
      decliningRatePpm: 1_000_000,
      inServiceDate: '2026-01-01',
    });

    expect(rows.map((row) => row.depreciationAmountMinor)).toEqual([80_000n, 0n, 0n, 0n]);
    expect(sumMinor(rows)).toBe(80_000n);
  });
});

function expectNeverNegativeAndOrdered(rows: readonly DepreciationScheduleRow[]): void {
  let previousDate: string | undefined;
  for (const row of rows) {
    expect(row.depreciationAmountMinor >= 0n).toBe(true);
    expect(row.periodDate).toMatch(CALENDAR_DATE);
    if (previousDate !== undefined) {
      // `YYYY-MM-DD` sorts lexicographically exactly as it sorts chronologically
      // (`calendarDateSchema`'s own format), so a plain string comparison proves
      // strictly increasing dates without parsing either side.
      expect(row.periodDate > previousDate).toBe(true);
    }
    previousDate = row.periodDate;
  }
}
