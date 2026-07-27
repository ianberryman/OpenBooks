import type { TestDatabase } from '../db';
import { SYSTEM_ROLE_UUIDS } from '../db';

import type { Scene } from './support';
import { contextFor } from './support';

/**
 * Fixtures for the OB-043 suites.
 *
 * `support.ts` next door builds a scene with the org factory's defaults: a
 * fiscal-year start month of January, and one open period covering 2026. Neither
 * is usable here. D-20's derivation is scoped to *the fiscal year containing the
 * report date*, so a balance sheet suite that only ever posted into one calendar
 * year under a January start would exercise the easy half of the ticket and none of
 * the hard one — a wrong fiscal-year resolution would be invisible, and prior-year
 * earnings would always be zero.
 *
 * So this file adds exactly two things: an org whose fiscal year starts in a month
 * the test chooses, and periods spanning several calendar years.
 */

/** The one thing a balance-sheet scene knows that a report scene does not. */
export interface FiscalScene extends Scene {
  readonly startMonth: number;
}

export interface FiscalSceneOptions {
  /** 1-12. Every generated scene uses something other than 1 — see the generator. */
  readonly startMonth: number;
  /** Calendar years to open a period over. Every posted date must fall in one. */
  readonly calendarYears: readonly number[];
}

/**
 * An org with an owner, a member row, and one open period per calendar year.
 *
 * The periods are **calendar** years even when the fiscal year is not, and that is
 * deliberate rather than sloppy: a period exists to make a date postable (A4), and
 * nothing in this report reads `fiscal_periods` at all. Generating twelve real
 * monthly periods per year through the periods service would triple the fixture's
 * cost to assert nothing — the fiscal-year *boundary* this suite is about comes
 * from `orgs.fiscal_year_start_month`, which is set below, and a period that
 * straddles it cannot move it.
 */
export async function createFiscalScene(
  db: TestDatabase,
  options: FiscalSceneOptions,
): Promise<FiscalScene> {
  const org = await db.factories.org();

  // Through the migrator handle because the factory has no override for the column
  // and this suite must not widen a shared fixture while two other report tickets
  // are in flight against it.
  await db.migrator
    .updateTable('orgs')
    .set({ fiscal_year_start_month: options.startMonth })
    .where('id', '=', org.id)
    .execute();

  const user = await db.factories.user();
  await db.factories.orgMember({ orgId: org.id, userId: user.id });

  for (const year of options.calendarYears) {
    await db.factories.fiscalPeriod({
      orgId: org.id,
      name: `Year ${String(year)}`,
      startDate: `${String(year)}-01-01`,
      endDate: `${String(year)}-12-31`,
    });
  }

  return {
    ctx: contextFor(org.uuid, SYSTEM_ROLE_UUIDS.owner, user.uuid),
    orgUuid: org.uuid,
    orgId: org.id,
    userId: user.id,
    startMonth: options.startMonth,
  };
}

/** `YYYY-MM-DD` from its parts, zero-padded so string order stays date order. */
export function calendarDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;
}

/**
 * The last day of the fiscal year starting `startMonth` in `year`, computed here
 * rather than borrowed from `periods/calendar.ts`.
 *
 * The oracle for "which window did the report use" must not be the code that chose
 * the window. `fiscalYearSpan` is what the service calls; a test asserting against
 * it would agree with the service for any start month at all, including the one a
 * mutation hard-codes.
 */
export function fiscalYearEndDate(year: number, startMonth: number): string {
  const endMonth = startMonth === 1 ? 12 : startMonth - 1;
  const endYear = startMonth === 1 ? year : year + 1;
  return calendarDate(endYear, endMonth, daysInMonth(endYear, endMonth));
}

export function fiscalYearStartDate(year: number, startMonth: number): string {
  return calendarDate(year, startMonth, 1);
}

/** The calendar day before `date`, on the string. */
export function dayBefore(date: string): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));

  if (day > 1) return calendarDate(year, month, day - 1);
  if (month > 1) return calendarDate(year, month - 1, daysInMonth(year, month - 1));
  return calendarDate(year - 1, 12, 31);
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function daysInMonth(year: number, month: number): number {
  if (month === 2 && ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0)) return 29;
  return DAYS_IN_MONTH[month - 1] ?? 28;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
