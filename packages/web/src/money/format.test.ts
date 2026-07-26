import { describe, expect, it } from 'vitest';

import { formatMinorUnits, MoneyFormatError } from './format';

/**
 * **Not yet run by `yarn test`.** The root `vitest.config.ts` lists its projects
 * explicitly and has no entry for this package, and that file is outside this ticket's
 * scope. `packages/web/vite.config.ts` carries the `test` block, so wiring it up is one
 * line in the root config — see the note there. Until that lands, this runs with
 * `yarn vitest run --root packages/web`.
 */
describe('formatMinorUnits', () => {
  it('renders whole and fractional amounts with a fixed two decimals', () => {
    expect(formatMinorUnits('150000')).toBe('1500.00');
    expect(formatMinorUnits('1999')).toBe('19.99');
    expect(formatMinorUnits('100')).toBe('1.00');
  });

  it('pads amounts smaller than one major unit', () => {
    expect(formatMinorUnits('5')).toBe('0.05');
    expect(formatMinorUnits('50')).toBe('0.50');
    expect(formatMinorUnits('0')).toBe('0.00');
  });

  it('keeps the sign in front of the padding', () => {
    expect(formatMinorUnits('-150000')).toBe('-1500.00');
    expect(formatMinorUnits('-5')).toBe('-0.05');
    // `"-0"` is canonical on the wire and `fromMinorString` accepts it, but it is the one
    // input whose sign is dropped: `bigint` has no negative zero, so `toDecimalString`
    // renders the same value `"0.00"` and the two sides must not disagree.
    expect(formatMinorUnits('-0')).toBe('0.00');
  });

  /**
   * The assertion behind D-13. `Number('9007199254740993')` is 9007199254740992 and
   * `/100` on it is inexact twice over; slicing digits is neither.
   */
  it('is exact above 2^53', () => {
    expect(formatMinorUnits('9007199254740993')).toBe('90071992547409.93');
    expect(formatMinorUnits('9223372036854775807')).toBe('92233720368547758.07');
  });

  /**
   * Case by case, matching `fromMinorString`'s own rejections: the wire format is cents,
   * never an amount.
   */
  it.each(['1500.00', '1.5', '1e5', '+150000', '01500', '', ' 150000', '150_000', 'NaN'])(
    'rejects %o',
    (malformed) => {
      expect(() => formatMinorUnits(malformed)).toThrow(MoneyFormatError);
    },
  );
});
