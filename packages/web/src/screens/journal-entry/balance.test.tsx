import { describe, expect, it } from 'vitest';

import { absolute, totalsOf, toWireAmount } from './balance';
import type { SidedAmount } from './balance';

/**
 * The balancing arithmetic, and the one property it exists to have: it is exact for
 * every value a `BIGINT` column can hold.
 *
 * D-13 chose a string on the wire because integers are exact in a double only up to
 * 2^53 and the ceiling is invisible above it. The tests that matter here are therefore
 * the ones a `number` implementation passes everywhere except where it counts — and
 * "where it counts" is not exotic: 2^53 minor units is ninety trillion, which a
 * ledger denominated in a currency with a small unit reaches without anything unusual
 * happening.
 */
const debit = (amount: string): SidedAmount => ({ side: 'debit', amount });
const credit = (amount: string): SidedAmount => ({ side: 'credit', amount });

describe('totalsOf', () => {
  it('sums each side and reports the difference', () => {
    const totals = totalsOf([debit('150000'), credit('50000'), credit('100000')]);

    expect(totals.debits).toBe(150000n);
    expect(totals.credits).toBe(150000n);
    expect(totals.difference).toBe(0n);
    expect(totals.entered).toBe(true);
  });

  /**
   * The mutation this catches is `Number(amount)`: 9007199254740993 and 9007199254740992
   * are the *same double*, so a `number` implementation reports a difference of zero and
   * an editor built on it tells the user a one-cent-out entry is in balance. Nothing else
   * in the suite distinguishes the two implementations.
   */
  it('is exact above 2^53, where a number would round the two sides together', () => {
    const totals = totalsOf([debit('9007199254740993'), credit('9007199254740992')]);

    expect(totals.difference).toBe(1n);
    expect(Number('9007199254740993') - Number('9007199254740992')).toBe(0);
  });

  it('is exact at the edge of the storable BIGINT range', () => {
    const totals = totalsOf([debit('9223372036854775807'), credit('9223372036854775806')]);

    expect(totals.debits).toBe(9223372036854775807n);
    expect(totals.difference).toBe(1n);
  });

  it('accumulates many large amounts without drift', () => {
    const lines = Array.from({ length: 1000 }, () => debit('9007199254740993'));

    expect(totalsOf(lines).debits).toBe(9007199254740993000n);
  });

  /**
   * A line with no side has no amount either — the draft contract reads such a line back
   * with neither — so an amount left over from a field the user then cleared must not
   * appear in a total on the side it used to be on.
   */
  it('ignores a line that carries no side', () => {
    const totals = totalsOf([{ side: null, amount: '150000' }, debit('100')]);

    expect(totals.debits).toBe(100n);
    expect(totals.credits).toBe(0n);
  });

  it('treats an empty amount as nothing rather than as a parse failure', () => {
    expect(totalsOf([{ side: 'debit', amount: null }]).debits).toBe(0n);
  });

  /**
   * Non-canonical input cannot arrive from `MoneyInput` or from the API, and the guard is
   * still worth a test: `BigInt('1500.00')` throws, and a throw inside `totalsOf` takes
   * the whole editor down over one field rather than showing a wrong subtotal in one row.
   */
  it('does not throw on a value that is not canonical minor units', () => {
    expect(totalsOf([{ side: 'debit', amount: '1500.00' }]).debits).toBe(0n);
  });

  it('distinguishes an empty form from a balanced one', () => {
    expect(totalsOf([]).entered).toBe(false);
    expect(totalsOf([{ side: 'debit', amount: null }]).entered).toBe(false);
    expect(totalsOf([debit('1'), credit('1')]).entered).toBe(true);
  });

  it('signs the difference by which side is heavier', () => {
    expect(totalsOf([debit('300'), credit('100')]).difference).toBe(200n);
    expect(totalsOf([debit('100'), credit('300')]).difference).toBe(-200n);
  });
});

describe('display helpers', () => {
  it('takes the magnitude of a difference without losing precision', () => {
    expect(absolute(-9007199254740993n)).toBe(9007199254740993n);
    expect(absolute(9007199254740993n)).toBe(9007199254740993n);
    expect(absolute(0n)).toBe(0n);
  });

  /**
   * `formatMinorUnits` rejects anything that is not canonical minor units, so the
   * `bigint`-to-wire step has to produce exactly that — including for zero, which has no
   * negative form in `bigint` and so can never reach it as `"-0"`.
   */
  it('renders a bigint as canonical minor units', () => {
    expect(toWireAmount(0n)).toBe('0');
    expect(toWireAmount(-1n)).toBe('-1');
    expect(toWireAmount(9007199254740993n)).toBe('9007199254740993');
  });
});
