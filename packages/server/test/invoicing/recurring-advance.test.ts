import { describe, expect, it } from 'vitest';

import { advance } from '../../src/modules/invoicing/recurring/engine';

/**
 * `advance`'s pure date math (OB-128), against a real MySQL 8 database — see
 * `recurring.test.ts` for that half of the ticket. This one is what proves the
 * month-end clamp: `Date.setUTCMonth` does not clamp on its own, and a subscription
 * dated the 31st has to land on the last day of a shorter month rather than skip
 * into the next one.
 */
describe('advance', () => {
  it('adds seven days per interval for weekly', () => {
    expect(advance('2026-01-01', 'weekly', 1)).toBe('2026-01-08');
    expect(advance('2026-01-01', 'weekly', 3)).toBe('2026-01-22');
  });

  it('adds whole months for monthly, unclamped when the day exists', () => {
    expect(advance('2026-01-15', 'monthly', 1)).toBe('2026-02-15');
  });

  it('clamps to the last day of a shorter target month', () => {
    // 2026 is not a leap year: 31 Jan + 1 month lands on 28 Feb, not 3 Mar.
    expect(advance('2026-01-31', 'monthly', 1)).toBe('2026-02-28');
    // 2024 is a leap year: the clamp reaches the 29th.
    expect(advance('2024-01-31', 'monthly', 1)).toBe('2024-02-29');
  });

  it('adds three months per interval for quarterly, with the same clamp', () => {
    expect(advance('2026-01-31', 'quarterly', 1)).toBe('2026-04-30');
  });

  it('adds twelve months per interval for yearly', () => {
    expect(advance('2026-06-15', 'yearly', 2)).toBe('2028-06-15');
    // A leap-day template outlives the leap year: clamped to 28 Feb the next.
    expect(advance('2024-02-29', 'yearly', 1)).toBe('2025-02-28');
  });

  it('rolls the year over when a month interval crosses December', () => {
    expect(advance('2026-11-30', 'monthly', 2)).toBe('2027-01-30');
  });
});
