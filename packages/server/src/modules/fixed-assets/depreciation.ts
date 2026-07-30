/**
 * The depreciation schedule: pure arithmetic, no database and no context (OB-164;
 * ROADMAP D-114, L2, L6).
 *
 * `computeDepreciationSchedule` is the one function `fixed-assets.service.ts`
 * calls to turn a registration into `fixed_asset_schedule` rows, and the one
 * function `depreciation.test.ts` proves against — `compute-term.ts`'s own reason
 * for staying pure: nothing here reads a row, so nothing here needs
 * `useTestDatabase()` to be tested exhaustively.
 *
 * Every amount is a `bigint` of minor units end to end (D-13); nothing here
 * divides in floating point, and the one invariant every caller may rely on is
 * L6: `Σ depreciationAmountMinor === acquisitionCostMinor − salvageValueMinor`,
 * exactly, for both methods, for every life and rate `depreciation.test.ts` tries.
 */

export type FixedAssetDepreciationMethod = 'straight_line' | 'declining_balance';

export interface DepreciationScheduleInput {
  readonly acquisitionCostMinor: bigint;
  readonly salvageValueMinor: bigint;
  readonly method: FixedAssetDepreciationMethod;
  readonly usefulLifeMonths: number;
  /** Parts per million (`rate_ppm`'s convention). Required for `declining_balance`, ignored otherwise. */
  readonly decliningRatePpm: number | null;
  readonly inServiceDate: string;
}

export interface DepreciationScheduleRow {
  readonly periodIndex: number;
  readonly periodDate: string;
  readonly depreciationAmountMinor: bigint;
}

const RATE_DENOMINATOR = 1_000_000n;

/**
 * `computeDepreciationSchedule(input)`: one row per month of `usefulLifeMonths`,
 * dated `addMonths(inServiceDate, periodIndex)`.
 *
 * Both methods true up on the final period rather than let floor-division drift
 * leave a remainder unaccounted for — the schedule's whole job is to reach
 * exactly `acquisitionCostMinor − salvageValueMinor`, not approximately.
 *
 * ## `straight_line` (D-114)
 *
 * `per = base / life` (bigint division, truncated toward zero — `base` and `life`
 * are both non-negative, so this is an ordinary floor). Every period charges
 * `per` except the last, which charges whatever floor division left behind:
 * `base − per × (life − 1)`. That is what makes the sum exact regardless of
 * whether `base` divides evenly by `life`.
 *
 * ## `declining_balance` (D-114)
 *
 * Each period charges `bookValue × rate ÷ 1,000,000`, floored at
 * `bookValue − salvage` so a period never takes the asset below its own salvage
 * value. `bookValue` starts at cost and decrements by exactly what was charged,
 * so it is always `cost − Σ(charges so far)` — which is what makes the final
 * period's true-up (`bookValue − salvage`, whatever that is by then) sum to the
 * same `base` the straight-line method reaches, however small the per-period
 * charge floored to along the way. If the declining charge reaches the salvage
 * floor before the final period, every period after that (including the final
 * one) simply charges zero — there is nothing left to true up, and the sum is
 * still exact.
 */
export function computeDepreciationSchedule(
  input: DepreciationScheduleInput,
): readonly DepreciationScheduleRow[] {
  const base = input.acquisitionCostMinor - input.salvageValueMinor;
  if (base < 0n) {
    // Not a business-input problem this function adjudicates — the wire schema
    // and `fixed-assets.service.ts` both refuse a cost at or below its own
    // salvage before this is ever called. A negative base here is a defect in
    // the caller, not a shape this schedule can express (L6 assumes it cannot
    // happen).
    throw new Error('acquisitionCostMinor must be greater than salvageValueMinor.');
  }
  if (input.usefulLifeMonths < 1) {
    throw new Error('usefulLifeMonths must be at least 1.');
  }

  return input.method === 'straight_line'
    ? straightLineSchedule(input, base)
    : decliningBalanceSchedule(input);
}

function straightLineSchedule(
  input: DepreciationScheduleInput,
  base: bigint,
): readonly DepreciationScheduleRow[] {
  const life = input.usefulLifeMonths;
  const per = base / BigInt(life);
  const lastIndex = life - 1;

  const rows: DepreciationScheduleRow[] = [];
  for (let periodIndex = 0; periodIndex < life; periodIndex++) {
    const amount = periodIndex === lastIndex ? base - per * BigInt(lastIndex) : per;
    rows.push({
      periodIndex,
      periodDate: addMonths(input.inServiceDate, periodIndex),
      depreciationAmountMinor: amount,
    });
  }
  return rows;
}

function decliningBalanceSchedule(
  input: DepreciationScheduleInput,
): readonly DepreciationScheduleRow[] {
  const life = input.usefulLifeMonths;
  const lastIndex = life - 1;
  const rate = BigInt(input.decliningRatePpm ?? 0);
  const salvage = input.salvageValueMinor;

  let bookValue = input.acquisitionCostMinor;
  const rows: DepreciationScheduleRow[] = [];

  for (let periodIndex = 0; periodIndex < life; periodIndex++) {
    const remainingToSalvage = bookValue - salvage;
    const amount =
      periodIndex === lastIndex
        ? remainingToSalvage
        : minBigint((bookValue * rate) / RATE_DENOMINATOR, remainingToSalvage);

    rows.push({
      periodIndex,
      periodDate: addMonths(input.inServiceDate, periodIndex),
      depreciationAmountMinor: amount,
    });
    bookValue -= amount;
  }

  // The loop reduces `bookValue` by exactly what it charges each period, ending
  // at `salvage` on the last iteration's true-up — so the sum charged is
  // `acquisitionCostMinor − bookValue`, which the true-up makes
  // `acquisitionCostMinor − salvageValueMinor` exactly (L6). `depreciation.test.ts`
  // is what actually proves this, across both methods and a spread of inputs,
  // rather than this comment.
  return rows;
}

function minBigint(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

// ---------------------------------------------------------------------------
// Pure calendar-month math, restated from
// `modules/invoicing/recurring/engine.ts`'s own `addMonths` rather than
// imported across the module boundary — `compute-term.ts`'s reason for
// restating `addCalendarDays` rather than reaching into `banking/matching`:
// importing it would assert in the dependency graph that fixed assets are
// built on recurring invoices, which is not true and which dependency-cruiser
// would then enforce as though it were.
// ---------------------------------------------------------------------------

interface CalendarParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function parseCalendarDate(date: string): CalendarParts {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return { year, month, day };
}

function formatCalendarDate(parts: CalendarParts): string {
  const year = String(parts.year).padStart(4, '0');
  const month = String(parts.month).padStart(2, '0');
  const day = String(parts.day).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** The last day of `month` (1–12) in `year`, for clamping a month-end rollover. */
function daysInMonth(year: number, month: number): number {
  // Day 0 of the following month is the last day of this one — `Date`'s own
  // overflow, used deliberately here rather than avoided.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Adds whole months, clamping the day to the target month's last one —
 * `engine.ts`'s `addMonths` verbatim: an asset placed in service on the 31st must
 * depreciate on the last day of a shorter month, not skip into the next one.
 */
function addMonths(date: string, months: number): string {
  const { year, month, day } = parseCalendarDate(date);
  const totalMonths = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = (totalMonths % 12) + 1;

  return formatCalendarDate({
    year: targetYear,
    month: targetMonth,
    day: Math.min(day, daysInMonth(targetYear, targetMonth)),
  });
}
