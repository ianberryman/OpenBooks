import { describe, expect, it } from 'vitest';

import {
  addMonths,
  daysInMonth,
  fiscalYearSpan,
  isLeapYear,
  monthEndDate,
  monthLabel,
  MONTHS_PER_YEAR,
  monthStartDate,
  rangesOverlap,
} from '../../src/modules/periods';

/**
 * The calendar arithmetic behind period generation (ROADMAP D-17).
 *
 * No database and no context: these are the pure functions, and they are tested
 * separately because the properties that matter — contiguity, leap years, the exact
 * shape of the overlap predicate — are arithmetic, and asserting them through a
 * service call would mean twelve inserts per case for no additional confidence.
 */

describe('leap years and month lengths', () => {
  it.each([
    [2024, true],
    [2026, false],
    [1900, false],
    [2000, true],
    [2100, false],
    [2400, true],
  ])('%i is a leap year: %s', (year, expected) => {
    expect(isLeapYear(year)).toBe(expected);
  });

  it('gives February 29 days only in a leap year', () => {
    expect(daysInMonth({ year: 2024, month: 2 })).toBe(29);
    expect(daysInMonth({ year: 2026, month: 2 })).toBe(28);
    expect(daysInMonth({ year: 1900, month: 2 })).toBe(28);
    expect(daysInMonth({ year: 2000, month: 2 })).toBe(29);
  });

  it('produces zero-padded dates, which is what makes string comparison chronological', () => {
    expect(monthStartDate({ year: 2026, month: 4 })).toBe('2026-04-01');
    expect(monthEndDate({ year: 2026, month: 4 })).toBe('2026-04-30');
    expect(monthEndDate({ year: 2024, month: 2 })).toBe('2024-02-29');
    expect(monthEndDate({ year: 2026, month: 12 })).toBe('2026-12-31');
    // The property the padding buys: lexicographic order is date order.
    expect(
      monthStartDate({ year: 2026, month: 9 }) < monthStartDate({ year: 2026, month: 10 }),
    ).toBe(true);
  });

  it('rejects a month number that is not a month', () => {
    expect(() => daysInMonth({ year: 2026, month: 0 })).toThrow(RangeError);
    expect(() => daysInMonth({ year: 2026, month: 13 })).toThrow(RangeError);
    expect(() => monthLabel({ year: 2026, month: 13 })).toThrow(RangeError);
  });

  it('carries into the following year when months are added', () => {
    expect(addMonths({ year: 2026, month: 10 }, 3)).toEqual({ year: 2027, month: 1 });
    expect(addMonths({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
    expect(addMonths({ year: 2026, month: 1 }, 0)).toEqual({ year: 2026, month: 1 });
    expect(addMonths({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
    expect(addMonths({ year: 2026, month: 1 }, 24)).toEqual({ year: 2028, month: 1 });
  });
});

describe('a fiscal year is twelve contiguous calendar months', () => {
  it('starts where the org says and runs into the next calendar year', () => {
    const span = fiscalYearSpan(2026, 4);

    expect(span.months).toHaveLength(MONTHS_PER_YEAR);
    expect(span.startDate).toBe('2026-04-01');
    expect(span.endDate).toBe('2027-03-31');
    expect(span.months.map((month) => month.name)).toEqual([
      'April 2026',
      'May 2026',
      'June 2026',
      'July 2026',
      'August 2026',
      'September 2026',
      'October 2026',
      'November 2026',
      'December 2026',
      'January 2027',
      'February 2027',
      'March 2027',
    ]);
  });

  /**
   * Contiguity is the property D-17 leans on: "periods are contiguous by
   * construction, which sidesteps the gap problem". Asserted as "every month starts
   * the day after the previous one ends", which is the same statement without
   * reimplementing the arithmetic — the next day is derived from the *next* span's
   * own start rather than computed here.
   */
  it.each([1, 4, 7, 10, 12])('leaves no gap and no overlap for start month %i', (startMonth) => {
    const span = fiscalYearSpan(2026, startMonth);

    for (const [index, month] of span.months.entries()) {
      expect(month.startDate).toBe(monthStartDate(month));
      expect(month.endDate).toBe(monthEndDate(month));

      const next = span.months[index + 1];
      if (next === undefined) continue;

      // Abutting, not overlapping: the ranges are inclusive on both ends.
      expect(month.endDate < next.startDate).toBe(true);
      expect(addMonths(month, 1)).toEqual({ year: next.year, month: next.month });
      expect(rangesOverlap(month.startDate, month.endDate, next.startDate, next.endDate)).toBe(
        false,
      );
    }

    expect(span.months[0]?.startDate).toBe(span.startDate);
    expect(span.months[MONTHS_PER_YEAR - 1]?.endDate).toBe(span.endDate);
  });

  it('gets February right in a fiscal year that straddles a leap year', () => {
    // FY2023 with an April start contains February 2024, which has 29 days.
    const february = fiscalYearSpan(2023, 4).months.find((month) => month.month === 2);
    expect(february?.startDate).toBe('2024-02-01');
    expect(february?.endDate).toBe('2024-02-29');
  });

  it('does not overlap the following fiscal year', () => {
    const first = fiscalYearSpan(2026, 7);
    const second = fiscalYearSpan(2027, 7);

    expect(first.endDate).toBe('2027-06-30');
    expect(second.startDate).toBe('2027-07-01');
    expect(rangesOverlap(first.startDate, first.endDate, second.startDate, second.endDate)).toBe(
      false,
    );
  });

  it('rejects a start month that is not a month', () => {
    expect(() => fiscalYearSpan(2026, 0)).toThrow(RangeError);
    expect(() => fiscalYearSpan(2026, 13)).toThrow(RangeError);
  });
});

/**
 * The overlap predicate, including the two cases a `start_date`-only check misses.
 * `0002_ledger` is explicit that the unique key on `(org_id, start_date)` does not
 * catch a genuine overlap, so these are the cases the service is the only defence
 * against.
 */
describe('rangesOverlap', () => {
  const june = ['2026-06-01', '2026-06-30'] as const;

  it('is false for abutting ranges, so a contiguous run is not self-conflicting', () => {
    expect(rangesOverlap('2026-05-01', '2026-05-31', ...june)).toBe(false);
    expect(rangesOverlap(...june, '2026-07-01', '2026-07-31')).toBe(false);
  });

  it('is true when one range wholly contains the other', () => {
    // The case a start-date test misses: the container's start is *before* the
    // range and its end is *after* it, so it never appears in a start-date scan.
    expect(rangesOverlap('2026-01-01', '2026-12-31', ...june)).toBe(true);
    expect(rangesOverlap(...june, '2026-01-01', '2026-12-31')).toBe(true);
  });

  it('is true when a range straddles a boundary from either side', () => {
    // Starts before the range, ends inside it.
    expect(rangesOverlap('2026-12-15', '2027-01-15', '2027-01-01', '2027-12-31')).toBe(true);
    // Starts inside the range, ends after it.
    expect(rangesOverlap('2027-12-20', '2028-01-10', '2027-01-01', '2027-12-31')).toBe(true);
  });

  it('is true when the ranges share exactly one day', () => {
    expect(rangesOverlap('2026-01-01', '2026-06-01', ...june)).toBe(true);
    expect(rangesOverlap('2026-06-30', '2026-12-31', ...june)).toBe(true);
  });

  it('is true for identical ranges and for a single shared date', () => {
    expect(rangesOverlap(...june, ...june)).toBe(true);
    expect(rangesOverlap('2026-06-15', '2026-06-15', ...june)).toBe(true);
  });

  it('is symmetric', () => {
    const cases: ReadonlyArray<readonly [string, string, string, string]> = [
      ['2026-01-01', '2026-12-31', '2026-06-01', '2026-06-30'],
      ['2026-12-15', '2027-01-15', '2027-01-01', '2027-12-31'],
      ['2026-05-01', '2026-05-31', '2026-06-01', '2026-06-30'],
    ];

    for (const [aStart, aEnd, bStart, bEnd] of cases) {
      expect(rangesOverlap(aStart, aEnd, bStart, bEnd)).toBe(
        rangesOverlap(bStart, bEnd, aStart, aEnd),
      );
    }
  });
});
