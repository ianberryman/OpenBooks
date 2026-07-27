import { ApiError } from '../../api';

/**
 * The small pieces the three settings sections share (OB-050). Nothing here is a
 * component: the shared *visual* atoms are in `./section.tsx`, and anything that would
 * be a second `Dialog` or a second `Field` belongs in `src/components/` or nowhere.
 */

/**
 * `details.precondition` off a `precondition_failed`, or `null`.
 *
 * `PreconditionFailedError` on the server takes a validated identifier token precisely so
 * that a client can branch on the *fact* instead of parsing prose, and two of this
 * screen's refusals are only legible if it does: `dimension_value_in_use` is what turns a
 * failed delete into an offer to archive instead, and `last_owner_in_org` is what names
 * the one rule the member list has to explain before a user meets it.
 *
 * Narrowed rather than cast, for the reason `fieldErrorsFrom` in `src/api/presentation.ts`
 * gives: `details` is a free-form bag in the generated types, so trusting its shape would
 * be trusting a description. Anything unrecognized reads as `null` and the caller falls
 * back to the server's message, which is already correct — the token only adds an action.
 */
export function preconditionOf(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.code !== 'precondition_failed') return null;

  const body: unknown = error.body;
  if (typeof body !== 'object' || body === null || !('error' in body)) return null;
  const envelope: unknown = body.error;
  if (typeof envelope !== 'object' || envelope === null || !('details' in envelope)) return null;
  const details: unknown = envelope.details;
  if (typeof details !== 'object' || details === null || !('precondition' in details)) return null;

  const precondition: unknown = details.precondition;
  return typeof precondition === 'string' ? precondition : null;
}

const MONTH_NAMES = [
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
] as const;

const MONTH_ABBREVIATIONS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** 1–12, as the org's `fiscalYearStartMonth` and a period's month number both are. */
export function monthName(month: number): string {
  return MONTH_NAMES[month - 1] ?? String(month);
}

export function monthAbbreviation(month: number): string {
  return MONTH_ABBREVIATIONS[month - 1] ?? String(month);
}

export interface CalendarMonth {
  readonly year: number;
  readonly month: number;
}

/**
 * The twelve months of one fiscal year, given the org's start month (D-17).
 *
 * Integer arithmetic, and no `Date` anywhere near it. `packages/server/src/modules/
 * periods/calendar.ts` argues the same point on the server and it holds identically here:
 * a `Date` built from a calendar value carries a timezone, and the month a period belongs
 * to must not depend on where the reader is sitting.
 */
export function fiscalYearMonths(fiscalYear: number, startMonth: number): readonly CalendarMonth[] {
  return Array.from({ length: 12 }, (_unused, offset) => {
    const absolute = startMonth - 1 + offset;
    return { year: fiscalYear + Math.floor(absolute / 12), month: (absolute % 12) + 1 };
  });
}

/**
 * Which fiscal year a calendar month falls in. A year beginning in April 2026 and ending
 * in March 2027 is fiscal year 2026, so January 2027 belongs to 2026 and not to 2027 —
 * the case that makes a non-January org's default wrong if this is skipped.
 */
export function fiscalYearOf(month: CalendarMonth, startMonth: number): number {
  return month.month >= startMonth ? month.year : month.year - 1;
}

/** The current calendar month, read once at the call site so a test can pass its own. */
export function currentCalendarMonth(now: Date = new Date()): CalendarMonth {
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

/**
 * `FY 2026 · Apr 2026 – Mar 2027`, or `FY 2026 · Jan – Dec 2026` when the year is the
 * calendar one. The span is spelled out rather than implied: an org whose books start in
 * April has no other way to tell which twelve months a button is about to create.
 */
export function fiscalYearLabel(fiscalYear: number, startMonth: number): string {
  const months = fiscalYearMonths(fiscalYear, startMonth);
  const first = months[0];
  const last = months[months.length - 1];
  if (first === undefined || last === undefined) return `FY ${String(fiscalYear)}`;

  const span =
    first.year === last.year
      ? `${monthAbbreviation(first.month)} – ${monthAbbreviation(last.month)} ${String(first.year)}`
      : `${monthAbbreviation(first.month)} ${String(first.year)} – ` +
        `${monthAbbreviation(last.month)} ${String(last.year)}`;

  return `FY ${String(fiscalYear)} · ${span}`;
}

/** `2026-04` — the key a period's `startDate` reduces to, and how a month is looked up. */
export function monthKey(month: CalendarMonth): string {
  return `${String(month.year)}-${String(month.month).padStart(2, '0')}`;
}

/**
 * `2026-04-01` → `1 Apr 2026`, by slicing the string.
 *
 * Never `new Date('2026-04-01')`, which parses as UTC midnight and renders as 31 March for
 * anyone west of Greenwich — the same trap `calendar.ts` documents on the server, arriving
 * here as a period that appears to start on the wrong day.
 */
export function formatCalendarDate(date: string): string {
  const [year, month, day] = date.split('-');
  if (year === undefined || month === undefined || day === undefined) return date;

  return `${String(Number(day))} ${monthAbbreviation(Number(month))} ${year}`;
}

/**
 * A real instant — `closedAt`, `expiresAt` — in the reader's own zone, which is right for
 * exactly the values a calendar date is not.
 */
export function formatTimestamp(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
}
