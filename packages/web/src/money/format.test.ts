import { describe, expect, it } from 'vitest';

import { formatMinorUnits, MoneyFormatError, toMinorUnits, tryToMinorUnits } from './format';

/**
 * Run by `yarn test`: the root `vitest.config.ts` lists a `web` project that extends
 * `packages/web/vite.config.ts`, which carries the `test` block.
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

describe('toMinorUnits', () => {
  it('converts a typed amount to cents', () => {
    expect(toMinorUnits('1500.00')).toBe('150000');
    expect(toMinorUnits('19.99')).toBe('1999');
    expect(toMinorUnits('0.05')).toBe('5');
    expect(toMinorUnits('-1500.00')).toBe('-150000');
  });

  it('accepts the partial forms a field passes through while being typed', () => {
    expect(toMinorUnits('1500')).toBe('150000');
    expect(toMinorUnits('5.')).toBe('500');
    expect(toMinorUnits('.5')).toBe('50');
    expect(toMinorUnits('1.5')).toBe('150');
    expect(toMinorUnits('  19.99  ')).toBe('1999');
  });

  it('emits the canonical wire form, so leading zeros and -0 never reach the API', () => {
    expect(toMinorUnits('007.00')).toBe('700');
    expect(toMinorUnits('0.00')).toBe('0');
    expect(toMinorUnits('-0.00')).toBe('0');
    expect(toMinorUnits('-0')).toBe('0');
  });

  /**
   * The assertion that this is not `Math.round(Number(entry) * 100)`. That expression
   * yields 111 for `'1.115'` — the double nearest 1.115 is below it — and 8114 for
   * `'81.145'`. Both are a cent short in a journal line, and neither is visible in the
   * posted entry.
   */
  it('is exact where a float round-trip is not', () => {
    expect(toMinorUnits('1.11')).toBe('111');
    expect(toMinorUnits('81.14')).toBe('8114');
    expect(toMinorUnits('90071992547409.93')).toBe('9007199254740993');
    expect(toMinorUnits('92233720368547758.07')).toBe('9223372036854775807');
  });

  it('refuses excess precision rather than rounding it', () => {
    expect(() => toMinorUnits('1.005')).toThrow(MoneyFormatError);
    expect(() => toMinorUnits('0.001')).toThrow(MoneyFormatError);
  });

  it.each(['', '-', '.', '1,500.00', '1 500', '1e5', '+15', '15-', 'abc', '1.2.3'])(
    'rejects %o',
    (malformed) => {
      expect(() => toMinorUnits(malformed)).toThrow(MoneyFormatError);
    },
  );

  /** Every conversion round-trips through the formatter it is the inverse of. */
  it.each(['150000', '1999', '5', '0', '-150000', '-5', '9007199254740993'])(
    'round-trips %o',
    (wire) => {
      expect(toMinorUnits(formatMinorUnits(wire))).toBe(wire === '-0' ? '0' : wire);
    },
  );
});

describe('tryToMinorUnits', () => {
  it('reports an unfinished entry as null rather than throwing', () => {
    expect(tryToMinorUnits('')).toBeNull();
    expect(tryToMinorUnits('-')).toBeNull();
    expect(tryToMinorUnits('1.005')).toBeNull();
    expect(tryToMinorUnits('19.99')).toBe('1999');
  });
});
