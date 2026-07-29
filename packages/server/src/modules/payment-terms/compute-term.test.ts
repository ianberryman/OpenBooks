import { describe, expect, it } from 'vitest';

import { computePaymentTerm } from './compute-term';

/**
 * `computePaymentTerm`'s arithmetic (OB-136; D-79, D-106), pure and colocated —
 * no `useTestDatabase()`, matching `shared-types/src/tax/compute.test.ts` for the
 * same reason: nothing here reads a row.
 */
describe('a simple term (net days only)', () => {
  it('computes the due date and no discount', () => {
    const result = computePaymentTerm(
      { netDays: 30, discountRatePpm: null, discountWindowDays: null },
      '2026-01-01',
      '150000',
    );

    expect(result).toEqual({
      dueDate: '2026-01-31',
      discountAmountMinor: null,
      discountDeadline: null,
    });
  });

  it('is due on receipt at zero net days', () => {
    const result = computePaymentTerm(
      { netDays: 0, discountRatePpm: null, discountWindowDays: null },
      '2026-03-15',
      '0',
    );

    expect(result.dueDate).toBe('2026-03-15');
  });

  it('crosses a month and a leap-year February correctly', () => {
    expect(
      computePaymentTerm(
        { netDays: 30, discountRatePpm: null, discountWindowDays: null },
        '2024-01-20',
        '0',
      ).dueDate,
    ).toBe('2024-02-19');

    // 2024 is a leap year; `Date.UTC` carries the leap day without a caller
    // having to know the year's length.
    expect(
      computePaymentTerm(
        { netDays: 15, discountRatePpm: null, discountWindowDays: null },
        '2024-02-20',
        '0',
      ).dueDate,
    ).toBe('2024-03-06');
  });
});

describe('a rich term (2/10 net 30)', () => {
  const twoTenNet30 = { netDays: 30, discountRatePpm: 20_000, discountWindowDays: 10 };

  it('computes the due date, the discount window and the discount amount', () => {
    const result = computePaymentTerm(twoTenNet30, '2026-01-01', '100000');

    expect(result.dueDate).toBe('2026-01-31');
    expect(result.discountDeadline).toBe('2026-01-11');
    // 2% of $1,000.00 is $20.00.
    expect(result.discountAmountMinor).toBe('2000');
  });

  it('rounds the discount half-up, at the single point `scale` defines', () => {
    // 20,000 ppm (2%) of 333 minor units is 6.66, which rounds to 7.
    const result = computePaymentTerm(twoTenNet30, '2026-01-01', '333');

    expect(result.discountAmountMinor).toBe('7');
  });

  it('produces a zero discount from a zero total without dividing by zero or erroring', () => {
    const result = computePaymentTerm(twoTenNet30, '2026-01-01', '0');

    expect(result.discountAmountMinor).toBe('0');
    expect(result.discountDeadline).toBe('2026-01-11');
  });

  it('mirrors a negative total (a credit line) exactly, since `scale` is symmetric', () => {
    const positive = computePaymentTerm(twoTenNet30, '2026-01-01', '333');
    const negative = computePaymentTerm(twoTenNet30, '2026-01-01', '-333');

    expect(BigInt(negative.discountAmountMinor ?? '0')).toBe(
      -BigInt(positive.discountAmountMinor ?? '0'),
    );
  });
});
