/**
 * Calendar-date arithmetic in UTC (OB-079).
 *
 * The same UTC method `reports/aging.service.ts` uses in its `daysBetween`, and for
 * the same reason: a calendar date has no timezone — `scripts/codegen.mjs` maps a
 * MySQL `DATE` to `string`, not `Date` — so a local-midnight subtraction spans 23 or
 * 25 hours across a DST boundary and a whole-day count comes out fractional exactly on
 * the boundary a match tolerance is judged at. In UTC the quotient is the integer.
 *
 * Restated here rather than imported because `daysBetween` is a private helper of the
 * aging service and this module must not reach into another module's internals for a
 * six-line function. The behaviour is asserted directly in this module's tests.
 */

const MILLISECONDS_PER_DAY = 86_400_000;

function toUtcMillis(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined || Number.isNaN(day)) {
    // A stored `DATE` and the request schema's `calendarDateSchema` have both parsed
    // this already; a malformed value here is a fault in this process, not input.
    throw new Error(`A calendar date was not in YYYY-MM-DD form: ${date}`);
  }
  return Date.UTC(year, month - 1, day);
}

/**
 * Whole days `to − from`, negative when `to` is the earlier date.
 *
 * The sign convention the wire contract asks of `dayDifference` on a match reason:
 * "negative when the candidate is earlier". Called with `from = line date`,
 * `to = candidate date`, it produces exactly that.
 */
export function dayDifference(from: string, to: string): number {
  return Math.round((toUtcMillis(to) - toUtcMillis(from)) / MILLISECONDS_PER_DAY);
}

/** `date` shifted by `days` (which may be negative), back as a `YYYY-MM-DD` string. */
export function addCalendarDays(date: string, days: number): string {
  const shifted = new Date(toUtcMillis(date) + days * MILLISECONDS_PER_DAY);
  const iso = shifted.toISOString();
  // `toISOString` is `YYYY-MM-DDTHH:mm:ss.sssZ`; the date part is the first ten chars.
  return iso.slice(0, 10);
}
