import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { MoneyParseError } from '../money';

import {
  MAX_TAX_RATE_UNITS,
  TAX_RATE_DENOMINATOR,
  ZERO_TAX_RATE,
  exclusiveTaxRatio,
  inclusiveTaxRatio,
  isZeroTaxRate,
  taxRateFromPercentString,
  taxRateFromUnits,
  taxRateToPercentString,
  taxRateUnits,
} from './rate';

describe('the wire form of a rate', () => {
  it('parses the percentages tax authorities actually publish', () => {
    expect(taxRateUnits(taxRateFromPercentString('20'))).toBe(200_000n);
    expect(taxRateUnits(taxRateFromPercentString('8.875'))).toBe(88_750n);
    expect(taxRateUnits(taxRateFromPercentString('8.0625'))).toBe(80_625n);
    expect(taxRateUnits(taxRateFromPercentString('0'))).toBe(0n);
    expect(taxRateUnits(taxRateFromPercentString('100'))).toBe(MAX_TAX_RATE_UNITS);
  });

  /**
   * The case that ruled out basis points. 8.875% is 887.5 basis points, so the
   * obvious integer representation cannot hold New York City's sales tax.
   */
  it('holds a rate that basis points cannot', () => {
    const nyc = taxRateFromPercentString('8.875');
    expect(taxRateUnits(nyc) * 10n).toBe(887_500n);
    expect(taxRateToPercentString(nyc)).toBe('8.875');
  });

  it('refuses anything that is not a canonical percentage', () => {
    for (const text of ['', '08', '.5', '5.', '20%', '1e2', '-5', '0.00001', '100.0001', '101']) {
      expect(() => taxRateFromPercentString(text)).toThrow(MoneyParseError);
    }
  });

  it('formats canonically, so a rate has exactly one spelling', () => {
    expect(taxRateToPercentString(taxRateFromPercentString('20.0000'))).toBe('20');
    expect(taxRateToPercentString(taxRateFromPercentString('20.5000'))).toBe('20.5');
    expect(taxRateToPercentString(ZERO_TAX_RATE)).toBe('0');
  });

  it('round-trips every representable rate', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: MAX_TAX_RATE_UNITS }), (units) => {
        const rate = taxRateFromUnits(units);
        const text = taxRateToPercentString(rate);
        expect(taxRateUnits(taxRateFromPercentString(text))).toBe(units);
        expect(taxRateToPercentString(taxRateFromPercentString(text))).toBe(text);
      }),
    );
  });

  it('bounds the rate at both ends', () => {
    expect(() => taxRateFromUnits(-1n)).toThrow(MoneyParseError);
    expect(() => taxRateFromUnits(MAX_TAX_RATE_UNITS + 1n)).toThrow(MoneyParseError);
    expect(isZeroTaxRate(taxRateFromUnits(0n))).toBe(true);
  });
});

describe('the two ratios a rate produces', () => {
  it('applies the exclusive rate over the fixed denominator', () => {
    const rate = taxRateFromPercentString('20');
    expect(exclusiveTaxRatio(rate)).toEqual({ numerator: 200_000n, denominator: 1_000_000n });
  });

  /**
   * `rate / (1 + rate)` with the denominator carried as `1_000_000 + units`, which
   * is the whole of the inclusive arithmetic: one exact ratio, one rounding.
   */
  it('applies the inclusive rate over one plus itself', () => {
    const rate = taxRateFromPercentString('20');
    expect(inclusiveTaxRatio(rate)).toEqual({
      numerator: 200_000n,
      denominator: TAX_RATE_DENOMINATOR + 200_000n,
    });
  });

  it('leaves a zero rate meaning zero in both directions', () => {
    expect(exclusiveTaxRatio(ZERO_TAX_RATE).numerator).toBe(0n);
    expect(inclusiveTaxRatio(ZERO_TAX_RATE).numerator).toBe(0n);
  });
});
