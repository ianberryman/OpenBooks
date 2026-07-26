import type { CalendarDate } from '@openbooks/plugin-api';

/**
 * Calendar arithmetic for fiscal periods, on `YYYY-MM-DD` strings.
 *
 * ## Why there is no `Date` in this file
 *
 * `src/db/migrations/README.md` overrides the generated `DATE` mapping to `string`
 * for a stated reason: "a calendar date has no timezone, and constructing a `Date`
 * from one invents a moment — which is how an `entry_date` lands in the wrong
 * fiscal period." `new Date('2026-04-01')` is midnight *UTC*, so
 * `getMonth()` on a machine west of Greenwich answers March, and a posting dated
 * the first of the month resolves to the previous period. The bug is silent, it is
 * environment-dependent, and it is in the one place the books must be exact.
 *
 * So every function here is integer and string arithmetic. The leap rule is four
 * lines and the month lengths are twelve numbers; that is a smaller surface than
 * the timezone reasoning a `Date`-based implementation would need to keep correct.
 *
 * ## Why string comparison is a valid date comparison
 *
 * `YYYY-MM-DD` is fixed-width and zero-padded, and its fields run
 * most-significant-first, so lexicographic order *is* chronological order. That is
 * what lets `rangesOverlap` compare dates with `<=` and what lets MySQL's own
 * `DATE` comparison in `periods.repository.ts` agree with it exactly. It holds only
 * while the padding does — hence `formatCalendarDate` pads rather than
 * concatenating, and nothing in this module produces a bare `2026-4-1`.
 */

/** A calendar month, identified by its year and its 1-based month number. */
export interface CalendarMonth {
  readonly year: number;
  readonly month: number;
}

/** One fiscal period's worth of calendar month: its label and its inclusive range. */
export interface MonthSpan extends CalendarMonth {
  readonly name: string;
  readonly startDate: CalendarDate;
  /** Inclusive, matching `fiscal_periods.end_date` and `chk_fiscal_periods_range`. */
  readonly endDate: CalendarDate;
}

/** A fiscal year: twelve contiguous monthly spans and the range they cover. */
export interface FiscalYearSpan {
  readonly fiscalYear: number;
  readonly startMonth: number;
  readonly startDate: CalendarDate;
  readonly endDate: CalendarDate;
  /** Exactly `MONTHS_PER_YEAR` entries, contiguous and in ascending date order. */
  readonly months: readonly MonthSpan[];
}

export const MONTHS_PER_YEAR = 12;

const DAYS_IN_MONTH: readonly number[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * English month names, from a fixed table rather than `Intl.DateTimeFormat`.
 *
 * `fiscal_periods.name` is persisted, so it must not depend on the process that
 * wrote it. ICU data ships with the Node build, so `Intl` output can differ between
 * the API container, the worker, and a developer's machine — which would leave one
 * org's twelve periods named in two styles depending on which process generated
 * them. Localization is a presentation concern and M2's UI has `start_date` to
 * format from; the stored name only has to be stable and legible.
 */
const MONTH_NAMES: readonly string[] = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(month: CalendarMonth): number {
  if (month.month === 2 && isLeapYear(month.year)) return 29;
  const days = DAYS_IN_MONTH[month.month - 1];
  if (days === undefined) throw rangeError(month);
  return days;
}

export function monthStartDate(month: CalendarMonth): CalendarDate {
  return formatCalendarDate(month.year, month.month, 1);
}

export function monthEndDate(month: CalendarMonth): CalendarDate {
  return formatCalendarDate(month.year, month.month, daysInMonth(month));
}

/**
 * `month` shifted by `count` months, carrying into the year.
 *
 * Month numbers are 1-based on the outside and 0-based inside, because the carry is
 * a division and 1-based division has an off-by-one at every December.
 */
export function addMonths(month: CalendarMonth, count: number): CalendarMonth {
  assertMonthInRange(month);
  const ordinal = month.year * MONTHS_PER_YEAR + (month.month - 1) + count;
  // Euclidean, not `%`: JavaScript's remainder is negative for a negative operand,
  // which would produce month 0 or -3 for a shift before year zero.
  const normalized = ((ordinal % MONTHS_PER_YEAR) + MONTHS_PER_YEAR) % MONTHS_PER_YEAR;
  return {
    year: Math.floor(ordinal / MONTHS_PER_YEAR),
    month: normalized + 1,
  };
}

export function monthLabel(month: CalendarMonth): string {
  const name = MONTH_NAMES[month.month - 1];
  if (name === undefined) throw rangeError(month);
  return `${name} ${String(month.year).padStart(4, '0')}`;
}

export function monthSpan(month: CalendarMonth): MonthSpan {
  assertMonthInRange(month);
  return {
    year: month.year,
    month: month.month,
    name: monthLabel(month),
    startDate: monthStartDate(month),
    endDate: monthEndDate(month),
  };
}

/**
 * The twelve months of a fiscal year, in order.
 *
 * `fiscalYear` names the calendar year the fiscal year **starts** in, so an org
 * whose year starts in April has fiscal year 2026 running 2026-04-01 to 2027-03-31.
 * The convention has to be stated because it is genuinely contested — the UK and
 * Australia label a fiscal year by the year it *ends* in — and every caller-visible
 * result carries explicit `startDate` and `endDate` so no integrator has to infer
 * which convention this system chose.
 *
 * Contiguity is a property of the construction, not a check: each month is the
 * previous one plus one, and each span runs from the first of its month to its last
 * day. That is what ROADMAP D-17 means by "periods are contiguous by construction,
 * which sidesteps the gap problem".
 */
export function fiscalYearSpan(fiscalYear: number, startMonth: number): FiscalYearSpan {
  const first: CalendarMonth = { year: fiscalYear, month: startMonth };
  assertMonthInRange(first);

  const months: MonthSpan[] = [];
  for (let offset = 0; offset < MONTHS_PER_YEAR; offset += 1) {
    months.push(monthSpan(addMonths(first, offset)));
  }

  return {
    fiscalYear,
    startMonth,
    startDate: monthStartDate(first),
    endDate: monthEndDate(addMonths(first, MONTHS_PER_YEAR - 1)),
    months,
  };
}

/**
 * Whether two inclusive date ranges share at least one day.
 *
 * `aStart <= bEnd && bStart <= aEnd` is the whole predicate, and it is the whole
 * predicate for a reason worth recording: migration `0002_ledger` notes that MySQL
 * cannot express non-overlap as a constraint and that
 * `uq_fiscal_periods_org_start` "catches the most common duplicate but does not
 * catch a genuine overlap". The naive replacement — "is there a period whose
 * `start_date` falls inside my range" — misses two real cases:
 *
 *  - **Containment.** An existing 2026-01-01…2026-12-31 period wholly contains a
 *    proposed June 2026. Its start is before the range and its end is after it, so
 *    a start-date test sees nothing.
 *  - **Straddling.** An existing 2026-12-15…2027-01-15 period overlaps a proposed
 *    fiscal year beginning 2027-01-01 by fifteen days, again with its start outside
 *    the range.
 *
 * Both are tested. The symmetric form above has no such blind spot: two ranges fail
 * to overlap only if one ends strictly before the other begins, which is exactly
 * the negation written here.
 *
 * Ranges are inclusive on both ends, matching `fiscal_periods.end_date`, so
 * abutting periods (…-03-31 and -04-01…) do **not** overlap — which they must not,
 * or a contiguous run would be self-conflicting.
 */
export function rangesOverlap(
  aStart: CalendarDate,
  aEnd: CalendarDate,
  bStart: CalendarDate,
  bEnd: CalendarDate,
): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

function formatCalendarDate(year: number, month: number, day: number): CalendarDate {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(
    2,
    '0',
  )}`;
}

function assertMonthInRange(month: CalendarMonth): void {
  if (!Number.isInteger(month.month) || month.month < 1 || month.month > MONTHS_PER_YEAR) {
    throw rangeError(month);
  }
  if (!Number.isInteger(month.year)) throw rangeError(month);
}

/**
 * A `RangeError`, not a domain error: every caller-supplied month reaches this
 * module through the Zod schemas in `periods.schemas.ts`, so an out-of-range value
 * here is a programming fault rather than bad input.
 */
function rangeError(month: CalendarMonth): RangeError {
  return new RangeError(
    `Not a calendar month: year ${month.year}, month ${month.month}. Months are 1-12.`,
  );
}
