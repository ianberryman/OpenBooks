import { describe, expect, it } from 'vitest';
import {
  MoneyParseError,
  equals,
  fromDecimalString,
  fromMinorUnits,
  negate,
  toDecimalString,
  toMinorUnits,
} from './money';
import { DEFAULT_ROUNDING_MODE, ratio, ratioFromDecimalString, scale } from './rounding';

describe('ratio', () => {
  it('requires a positive denominator', () => {
    expect(() => ratio(1n, 0n)).toThrow(RangeError);
    expect(() => ratio(1n, -2n)).toThrow(RangeError);
    expect(ratio(-1n, 2n)).toEqual({ numerator: -1n, denominator: 2n });
  });

  it('parses a rate exactly, deriving the denominator from the input precision', () => {
    expect(ratioFromDecimalString('0.0825')).toEqual({ numerator: 825n, denominator: 10000n });
    expect(ratioFromDecimalString('0.2')).toEqual({ numerator: 2n, denominator: 10n });
    expect(ratioFromDecimalString('1')).toEqual({ numerator: 1n, denominator: 1n });
    expect(ratioFromDecimalString('-0.15')).toEqual({ numerator: -15n, denominator: 100n });
  });

  it.each(['', '.5', '1.', 'abc', '1e-2', '2%'])('rejects the rate %o', (text) => {
    expect(() => ratioFromDecimalString(text)).toThrow(MoneyParseError);
  });
});

describe('scale', () => {
  it('is exact when the ratio divides', () => {
    const amount = fromDecimalString('100.00');
    expect(toDecimalString(scale(amount, ratioFromDecimalString('0.0825')))).toBe('8.25');
    expect(toDecimalString(scale(amount, ratio(1n, 4n)))).toBe('25.00');
    expect(toDecimalString(scale(amount, ratio(1n, 1n)))).toBe('100.00');
  });

  it('defaults to half-up, away from zero on a tie', () => {
    expect(DEFAULT_ROUNDING_MODE).toBe('half-up');
    // 1.01 halved is 0.505 — an exact tie at the minor unit.
    expect(toMinorUnits(scale(fromMinorUnits(101n), ratio(1n, 2n)))).toBe(51n);
    expect(toMinorUnits(scale(fromMinorUnits(103n), ratio(1n, 2n)))).toBe(52n);
    // Not a tie: ordinary rounding either way.
    expect(toMinorUnits(scale(fromMinorUnits(100n), ratio(1n, 3n)))).toBe(33n);
    expect(toMinorUnits(scale(fromMinorUnits(200n), ratio(1n, 3n)))).toBe(67n);
  });

  it('rounds half-even to the even neighbour when asked', () => {
    expect(toMinorUnits(scale(fromMinorUnits(101n), ratio(1n, 2n), 'half-even'))).toBe(50n);
    expect(toMinorUnits(scale(fromMinorUnits(103n), ratio(1n, 2n), 'half-even'))).toBe(52n);
    expect(toMinorUnits(scale(fromMinorUnits(105n), ratio(1n, 2n), 'half-even'))).toBe(52n);
  });

  it('is symmetric about zero in both modes, so a reversal mirrors exactly', () => {
    for (const minorUnits of [1n, 5n, 101n, 103n, 999n, 1_000_003n]) {
      for (const factor of [ratio(1n, 2n), ratio(1n, 3n), ratioFromDecimalString('0.0825')]) {
        for (const mode of ['half-up', 'half-even'] as const) {
          const amount = fromMinorUnits(minorUnits);
          expect(
            equals(scale(negate(amount), factor, mode), negate(scale(amount, factor, mode))),
          ).toBe(true);
        }
      }
    }
  });

  it('is deterministic', () => {
    const amount = fromDecimalString('9.99');
    const rate = ratioFromDecimalString('0.0825');
    const results = Array.from({ length: 5 }, () => toMinorUnits(scale(amount, rate)));
    // 9.99 * 8.25% = 0.824175 -> 82 minor units, every time.
    expect(results).toEqual([82n, 82n, 82n, 82n, 82n]);
  });

  it('shows why the application point has to be defined, not just the mode', () => {
    // Rounding at each step and rounding once on the combined ratio disagree.
    // Neither is wrong; that is exactly why spec §11 asks for one defined point
    // rather than one defined mode. `scale` is that point, and callers must
    // apply it once per amount instead of once per intermediate step.
    const oneCent = fromMinorUnits(1n);
    expect(toMinorUnits(scale(scale(oneCent, ratio(1n, 2n)), ratio(1n, 2n)))).toBe(1n);
    expect(toMinorUnits(scale(oneCent, ratio(1n, 4n)))).toBe(0n);
  });
});
