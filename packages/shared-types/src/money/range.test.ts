import { describe, expect, it } from 'vitest';

import {
  MAX_MONEY_MINOR_UNITS,
  MIN_MONEY_MINOR_UNITS,
  MoneyParseError,
  fromDecimalString,
  fromMinorString,
  fromMinorUnits,
  toMinorString,
} from './index';

/**
 * The wire format is a decimal string of minor units — cents only, never a decimal
 * amount. That choice is why this bound has to exist.
 *
 * A JSON number would have imposed its own ceiling at 2^53 and lost precision
 * quietly above it. A string has no ceiling at all, so `"99999999999999999999"`
 * parses to a perfectly valid `bigint` that no `BIGINT` column can store. Before
 * this check, such a value reached the driver and came back as an opaque
 * `internal_error` — the server taking blame for a request it should have refused.
 */
describe('money is bounded to what a BIGINT column can hold', () => {
  it('accepts the exact boundaries', () => {
    expect(fromMinorUnits(MAX_MONEY_MINOR_UNITS)).toBe(MAX_MONEY_MINOR_UNITS);
    expect(fromMinorUnits(MIN_MONEY_MINOR_UNITS)).toBe(MIN_MONEY_MINOR_UNITS);
  });

  it('rejects one past either boundary', () => {
    expect(() => fromMinorUnits(MAX_MONEY_MINOR_UNITS + 1n)).toThrow(MoneyParseError);
    expect(() => fromMinorUnits(MIN_MONEY_MINOR_UNITS - 1n)).toThrow(MoneyParseError);
  });

  it('rejects an over-range wire string rather than passing it to the driver', () => {
    expect(() => fromMinorString('99999999999999999999')).toThrow(MoneyParseError);
    expect(() => fromMinorString('-99999999999999999999')).toThrow(MoneyParseError);
  });

  it('rejects an over-range decimal string too', () => {
    // fromDecimalString funnels through fromMinorUnits, so it inherits the bound
    // rather than needing its own check.
    expect(() => fromDecimalString('999999999999999999.99')).toThrow(MoneyParseError);
  });

  it('still carries amounts a JSON number could not represent', () => {
    // The reason the wire format is a string at all. 2^53 + 1 is the first integer
    // an IEEE-754 double cannot distinguish from its neighbour.
    const beyondDouble = fromMinorString('9007199254740993');
    expect(toMinorString(beyondDouble)).toBe('9007199254740993');
  });

  it('rejects anything that is not a plain count of cents', () => {
    // The constraint on the wire format: cents only. A decimal amount is a
    // presentation form and must not appear in transport.
    for (const malformed of ['1500.00', '1.5', '1e5', '+150000', '01500', ' 150000', '']) {
      expect(() => fromMinorString(malformed)).toThrow(MoneyParseError);
    }
  });
});
