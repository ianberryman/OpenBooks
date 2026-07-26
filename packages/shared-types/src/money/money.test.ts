import { describe, expect, it } from 'vitest';
import type { Money } from './money';
import {
  MoneyParseError,
  ZERO,
  abs,
  add,
  compare,
  equals,
  fromDecimalString,
  fromMajorMinor,
  fromMinorString,
  fromMinorUnits,
  isNegative,
  isPositive,
  isZero,
  negate,
  subtract,
  sum,
  toDecimalString,
  toMinorString,
  toMinorUnits,
} from './money';

describe('Money brand', () => {
  it('does not accept a bare bigint', () => {
    // @ts-expect-error — a bare bigint must not be assignable to Money.
    const unbranded: Money = 1234n;
    expect(toMinorUnits(unbranded)).toBe(1234n);
  });

  it('does not accept a number, so the lint rule need not check that case', () => {
    // @ts-expect-error — number is not assignable to Money; the compiler owns this one.
    const fromNumber: Money = 1234;
    expect(String(fromNumber)).toBe('1234');
  });
});

describe('fromDecimalString', () => {
  it('parses exactly, without routing through Number', () => {
    expect(toMinorUnits(fromDecimalString('1234.56'))).toBe(123456n);
    expect(toMinorUnits(fromDecimalString('0.07'))).toBe(7n);
    expect(toMinorUnits(fromDecimalString('0.1'))).toBe(10n);
    expect(toMinorUnits(fromDecimalString('-0.05'))).toBe(-5n);
    expect(toMinorUnits(fromDecimalString('0'))).toBe(0n);
    expect(toMinorUnits(fromDecimalString('-0.00'))).toBe(0n);
  });

  it('keeps precision far beyond Number.MAX_SAFE_INTEGER', () => {
    // 2^53 minor units and change: a float parse would round this.
    const parsed = fromDecimalString('90071992547409.93');
    expect(toMinorUnits(parsed)).toBe(9007199254740993n);
    expect(toDecimalString(parsed)).toBe('90071992547409.93');
  });

  it.each([
    '',
    ' ',
    '1.234',
    '.5',
    '1.',
    '01.5',
    '+1.00',
    '1e3',
    '1,234.56',
    ' 1.00',
    '1.00 ',
    'abc',
    'NaN',
    'Infinity',
    '--1.00',
    '1.-0',
  ])('rejects %o rather than coercing it', (text) => {
    expect(() => fromDecimalString(text)).toThrow(MoneyParseError);
  });
});

describe('fromMinorString', () => {
  it('round-trips the wire representation', () => {
    expect(toMinorString(fromMinorString('123456'))).toBe('123456');
    expect(toMinorString(fromMinorString('-5'))).toBe('-5');
    expect(toMinorString(fromMinorString('0'))).toBe('0');
    // Well past 2^53, exact.
    expect(toMinorString(fromMinorString('92233720368547758'))).toBe('92233720368547758');
  });

  it.each(['12.34', '1_0', '0100', '', '1e3', 'abc', '0x10'])('rejects %o', (text) => {
    expect(() => fromMinorString(text)).toThrow(MoneyParseError);
  });
});

describe('JSON transport', () => {
  it('is a minor-unit string because bigint cannot be stringified', () => {
    expect(() => JSON.stringify(fromMinorUnits(1n))).toThrow(TypeError);

    const wire = JSON.stringify({ amount: toMinorString(fromDecimalString('1234.56')) });
    expect(wire).toBe('{"amount":"123456"}');

    const parsed = JSON.parse(wire) as { amount: string };
    expect(equals(fromMinorString(parsed.amount), fromDecimalString('1234.56'))).toBe(true);
  });
});

describe('fromMajorMinor', () => {
  it('composes the fields a money input collects', () => {
    expect(toMinorUnits(fromMajorMinor(12n, 34n))).toBe(1234n);
    expect(toMinorUnits(fromMajorMinor(-12n, 34n))).toBe(-1234n);
    expect(toMinorUnits(fromMajorMinor(0n, 5n))).toBe(5n);
    expect(toMinorUnits(fromMajorMinor(0n, 0n))).toBe(0n);
  });

  it('rejects a minor part outside one major unit', () => {
    expect(() => fromMajorMinor(1n, 100n)).toThrow(MoneyParseError);
    expect(() => fromMajorMinor(1n, -1n)).toThrow(MoneyParseError);
  });
});

describe('toDecimalString', () => {
  it('always renders both fraction digits', () => {
    expect(toDecimalString(fromMinorUnits(123456n))).toBe('1234.56');
    expect(toDecimalString(fromMinorUnits(5n))).toBe('0.05');
    expect(toDecimalString(fromMinorUnits(-5n))).toBe('-0.05');
    expect(toDecimalString(fromMinorUnits(100n))).toBe('1.00');
    expect(toDecimalString(ZERO)).toBe('0.00');
  });

  it('round-trips through fromDecimalString', () => {
    for (const minorUnits of [0n, 1n, -1n, 99n, 100n, -12345n, 987654321098765n]) {
      const value = fromMinorUnits(minorUnits);
      expect(equals(fromDecimalString(toDecimalString(value)), value)).toBe(true);
    }
  });
});

describe('arithmetic helpers', () => {
  const ten = fromDecimalString('10.00');
  const three = fromDecimalString('3.00');

  it('adds, subtracts and negates exactly', () => {
    expect(toDecimalString(add(ten, three))).toBe('13.00');
    expect(toDecimalString(subtract(ten, three))).toBe('7.00');
    expect(toDecimalString(subtract(three, ten))).toBe('-7.00');
    expect(toDecimalString(negate(ten))).toBe('-10.00');
    expect(equals(negate(negate(ten)), ten)).toBe(true);
    expect(isZero(negate(ZERO))).toBe(true);
  });

  it('stays exact at magnitudes a double could not hold', () => {
    const huge = fromMinorUnits(9007199254740993n);
    expect(toMinorUnits(add(huge, fromMinorUnits(1n)))).toBe(9007199254740994n);
    expect(toMinorUnits(subtract(add(huge, fromMinorUnits(1n)), huge))).toBe(1n);
  });

  it('sums, with an empty total of zero', () => {
    expect(isZero(sum([]))).toBe(true);
    expect(toDecimalString(sum([ten, three, negate(three)]))).toBe('10.00');
    const cents = Array.from({ length: 1000 }, () => fromMinorUnits(1n));
    expect(toDecimalString(sum(cents))).toBe('10.00');
  });

  it('compares and classifies', () => {
    expect(compare(three, ten)).toBe(-1);
    expect(compare(ten, three)).toBe(1);
    expect(compare(ten, fromDecimalString('10.00'))).toBe(0);
    expect(equals(ten, fromMinorUnits(1000n))).toBe(true);
    expect(isNegative(negate(ten))).toBe(true);
    expect(isNegative(ZERO)).toBe(false);
    expect(isPositive(ZERO)).toBe(false);
    expect(isPositive(ten)).toBe(true);
    expect([...[three, ten, negate(ten)]].sort(compare).map(toDecimalString)).toEqual([
      '-10.00',
      '3.00',
      '10.00',
    ]);
  });

  it('takes absolute values symmetrically', () => {
    expect(equals(abs(negate(ten)), ten)).toBe(true);
    expect(equals(abs(ten), ten)).toBe(true);
    expect(isZero(abs(ZERO))).toBe(true);
  });
});
