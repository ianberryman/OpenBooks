import { describe, expect, it } from 'vitest';
import type { Money } from './money';
import {
  add,
  equals,
  fromDecimalString,
  fromMinorUnits,
  isNegative,
  isPositive,
  negate,
  subtract,
  sum,
  toDecimalString,
  toMinorUnits,
} from './money';
import { ratioFromDecimalString, scale } from './rounding';
import { allocate, allocateEvenly } from './allocate';

const minorUnits = (parts: readonly Money[]): bigint[] => parts.map(toMinorUnits);

describe('allocate', () => {
  it('splits non-dividing amounts with no lost cents', () => {
    expect(minorUnits(allocate(fromMinorUnits(100n), [1n, 1n, 1n]))).toEqual([34n, 33n, 33n]);
    expect(minorUnits(allocate(fromMinorUnits(1n), [1n, 1n, 1n]))).toEqual([1n, 0n, 0n]);
    expect(minorUnits(allocate(fromMinorUnits(3n), [1n, 1n, 1n, 1n]))).toEqual([1n, 1n, 1n, 0n]);
    expect(minorUnits(allocate(fromMinorUnits(100n), [1n, 2n, 3n]))).toEqual([17n, 33n, 50n]);
    expect(minorUnits(allocate(fromMinorUnits(0n), [1n, 1n, 1n]))).toEqual([0n, 0n, 0n]);
  });

  it('gives leftover units to the largest remainder, ties to the lower index', () => {
    // 10 across 3 equal weights: every remainder is 1, so the single leftover
    // unit goes to index 0 and the result is reproducible.
    expect(minorUnits(allocate(fromMinorUnits(10n), [1n, 1n, 1n]))).toEqual([4n, 3n, 3n]);
    // Weights 3,1,1: shares are 6.0, 2.0, 2.0 — no leftover to break.
    expect(minorUnits(allocate(fromMinorUnits(10n), [3n, 1n, 1n]))).toEqual([6n, 2n, 2n]);
    // Weights 1,1,4: shares are 1.66, 1.66, 6.66 — two leftovers, lowest
    // indices win the tie.
    expect(minorUnits(allocate(fromMinorUnits(10n), [1n, 1n, 4n]))).toEqual([2n, 2n, 6n]);
  });

  it('mirrors exactly for negative amounts, so a reversal cancels line for line', () => {
    expect(minorUnits(allocate(fromMinorUnits(-100n), [1n, 1n, 1n]))).toEqual([-34n, -33n, -33n]);
    expect(minorUnits(allocate(fromMinorUnits(-1n), [1n, 1n, 1n]))).toEqual([-1n, 0n, 0n]);

    for (const amount of [1n, 7n, 100n, 12345n, 999_999_999n]) {
      for (const weights of [[1n, 1n, 1n], [1n, 2n, 3n, 4n], [5n, 0n, 1n], [7n]]) {
        const forward = allocate(fromMinorUnits(amount), weights);
        const reversed = allocate(negate(fromMinorUnits(amount)), weights);
        expect(minorUnits(reversed)).toEqual(minorUnits(forward.map(negate)));
      }
    }
  });

  it('never gives a leftover unit to a zero weight', () => {
    expect(minorUnits(allocate(fromMinorUnits(5n), [1n, 0n, 1n]))).toEqual([3n, 0n, 2n]);
    expect(minorUnits(allocate(fromMinorUnits(1n), [0n, 0n, 1n]))).toEqual([0n, 0n, 1n]);
    expect(minorUnits(allocate(fromMinorUnits(2n), [0n, 3n, 3n]))).toEqual([0n, 1n, 1n]);
  });

  it('sums exactly for every amount and weight vector tried', () => {
    const weightVectors = [
      [1n, 1n, 1n],
      [1n, 1n, 1n, 1n, 1n, 1n, 1n],
      [1n, 2n, 3n, 4n],
      [5n, 0n, 1n],
      [999n, 1n],
      [1n],
    ];

    for (const weights of weightVectors) {
      for (let unit = -500n; unit <= 500n; unit++) {
        const amount = fromMinorUnits(unit);
        const parts = allocate(amount, weights);

        expect(parts).toHaveLength(weights.length);
        expect(equals(sum(parts), amount)).toBe(true);
        // No part may flip sign: a positive split has no negative lines.
        for (const part of parts) {
          if (unit > 0n) expect(isNegative(part)).toBe(false);
          if (unit < 0n) expect(isPositive(part)).toBe(false);
        }
      }
    }
  });

  it('stays exact past the range of a double', () => {
    const amount = fromMinorUnits(2n ** 62n + 5n);
    const parts = allocate(amount, [1n, 1n, 1n, 1n, 1n, 1n, 1n]);
    expect(equals(sum(parts), amount)).toBe(true);
    expect(minorUnits(parts)[0]).toBe(658812288346769702n);
  });

  it('rejects inputs it cannot split', () => {
    expect(() => allocate(fromMinorUnits(1n), [])).toThrow(RangeError);
    expect(() => allocate(fromMinorUnits(1n), [1n, -1n])).toThrow(RangeError);
    expect(() => allocate(fromMinorUnits(1n), [0n, 0n])).toThrow(RangeError);
    // Splitting nothing across nothing is well defined.
    expect(minorUnits(allocate(fromMinorUnits(0n), [0n, 0n]))).toEqual([0n, 0n]);
  });
});

describe('allocateEvenly', () => {
  it('spreads the remainder over the earliest parts', () => {
    expect(minorUnits(allocateEvenly(fromMinorUnits(1n), 3))).toEqual([1n, 0n, 0n]);
    expect(minorUnits(allocateEvenly(fromDecimalString('100.00'), 3))).toEqual([
      3334n,
      3333n,
      3333n,
    ]);
    expect(minorUnits(allocateEvenly(fromMinorUnits(7n), 1))).toEqual([7n]);
  });

  it('requires a positive integer part count', () => {
    expect(() => allocateEvenly(fromMinorUnits(1n), 0)).toThrow(RangeError);
    expect(() => allocateEvenly(fromMinorUnits(1n), -3)).toThrow(RangeError);
    expect(() => allocateEvenly(fromMinorUnits(1n), 2.5)).toThrow(RangeError);
  });
});

describe('discount and tax on an invoice', () => {
  /**
   * The scenario spec §11 names: a discount and a tax over lines that do not
   * divide evenly. The discount is allocated (lossless), then each net line is
   * scaled once (the defined rounding point). Both totals must be exact sums of
   * their parts — that is what makes the resulting journal balance.
   */
  it('sums exactly with no lost cents', () => {
    const lines = [
      fromDecimalString('10.00'),
      fromDecimalString('20.00'),
      fromDecimalString('0.01'),
    ];
    const subtotal = sum(lines);
    const discount = fromDecimalString('5.00');

    const discounts = allocate(discount, lines.map(toMinorUnits));
    expect(discounts.map(toDecimalString)).toEqual(['1.67', '3.33', '0.00']);
    // The whole discount lands on the lines, to the cent.
    expect(equals(sum(discounts), discount)).toBe(true);

    const net = lines.map((line, index) => subtract(line, discounts[index] ?? fromMinorUnits(0n)));
    expect(equals(sum(net), subtract(subtotal, discount))).toBe(true);

    const rate = ratioFromDecimalString('0.0825');
    const taxes = net.map((line) => scale(line, rate));
    expect(taxes.map(toDecimalString)).toEqual(['0.69', '1.38', '0.00']);

    const total = add(sum(net), sum(taxes));
    expect(toDecimalString(total)).toBe('27.08');

    // Per-line tax and tax-on-the-total differ by a cent here. Both are
    // defensible; only one can be the defined point. This suite fixes it at
    // per-line, so the invoice total is always the sum of its lines.
    expect(toDecimalString(sum(taxes))).toBe('2.07');
    expect(toDecimalString(scale(sum(net), rate))).toBe('2.06');
  });
});
