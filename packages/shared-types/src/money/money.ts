/**
 * Money — exact amounts as branded `bigint` minor units (spec §12).
 *
 * Two conventions hold across this module and every caller:
 *
 * - **Errors.** `MoneyParseError` means "external representation was malformed"
 *   — a string or a major/minor pair that came from a request body or a form
 *   field, so the transport layer maps it to a 400. `RangeError` means the
 *   caller misused an internal API (a zero denominator, a negative weight);
 *   that is a bug, not user input.
 * - **Exactness.** Every operation here is exact. Nothing in this file rounds
 *   or divides. Rounding lives in `./rounding` and has exactly one application
 *   point; proportional splitting lives in `./allocate` and is lossless.
 */

declare const moneyBrand: unique symbol;

/**
 * An exact monetary amount, in minor units (cents), carried as `bigint`.
 *
 * The brand is the whole point. A bare `bigint` alias would let a row count, a
 * line id, or a quantity flow into a money position unnoticed, which is the
 * class of bug spec §12 is trying to make unrepresentable. Because the brand
 * symbol is not exported, nothing outside this file can produce a `Money`
 * except through the constructors below, and `openbooks/no-float-money` keys
 * off the brand to ban raw operators on money-typed expressions.
 *
 * A `number` in a `Money` position is already a compile error — `number` is not
 * assignable to `bigint` — so the lint rule deliberately does not duplicate it.
 *
 * Currency is absent on purpose: spec §13 puts multi-currency out of v1 scope,
 * so every amount is in the org's single currency. Adding currency later means
 * a second brand parameter (`Money<'USD'>`) and a per-currency minor-unit
 * exponent, so no caller should bake in an assumption that one global currency
 * holds forever. Keep currency knowledge at the formatting boundary.
 */
export type Money = bigint & { readonly [moneyBrand]: 'Money' };

/**
 * Minor units per major unit, as a decimal exponent.
 *
 * Fixed at 2 for v1 because there is one currency and it has cents. This is the
 * one place a per-currency exponent (JPY 0, TND 3) would have to become data.
 */
export const MINOR_UNIT_EXPONENT = 2;

const MINOR_UNITS_PER_MAJOR = 100n;

/** Malformed external input. Never thrown for values produced inside this module. */
export class MoneyParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyParseError';
  }
}

/**
 * Canonical integer, no separators, no leading zeros. Deliberately strict:
 * a producer that sends `"0100"` or `"1.00"` on the wire has a bug, and
 * silently accepting it would hide the mismatch until it reached the ledger.
 */
const MINOR_UNITS_PATTERN = /^-?(?:0|[1-9][0-9]*)$/;

/**
 * Optional sign, integer part with no leading zeros, at most
 * `MINOR_UNIT_EXPONENT` fraction digits. A third fraction digit is rejected
 * rather than rounded — rounding happens in exactly one place (`scale`), and
 * parsing is not it.
 */
const DECIMAL_PATTERN = /^(-)?(0|[1-9][0-9]*)(?:\.([0-9]{1,2}))?$/;

export const ZERO = 0n as Money;

/** The primitive constructor: a `bigint` count of minor units is already a Money. */
export function fromMinorUnits(minorUnits: bigint): Money {
  return minorUnits as Money;
}

/**
 * Widens a `Money` back to the plain `bigint` it is at runtime.
 *
 * Needed at two real boundaries: binding a `BIGINT` column (spec §12 stores
 * money as `BIGINT` end to end) and the internal division in `./rounding` and
 * `./allocate`. Widening also drops the lint rule's protection, so it is not a
 * general-purpose escape hatch — code that just needs to compute should call
 * `add` / `subtract` / `sum` instead.
 */
export function toMinorUnits(value: Money): bigint {
  return value;
}

/**
 * Parses the JSON/wire representation: a base-10 integer string of minor units.
 *
 * **How Money crosses JSON.** As a *string of minor units* (`"123456"`), never
 * as a JSON number and never as a decimal string.
 *
 * - A JSON number is an IEEE-754 double in every mainstream parser, so any
 *   amount above 2^53 minor units silently loses precision, and JS clients
 *   reformat what they round-trip. Spec §12 says no floats end to end; putting
 *   money in a JSON number breaks that at the one place we do not control.
 * - `JSON.stringify` throws on `bigint`, so the wire type has to be chosen
 *   explicitly rather than inherited from the runtime.
 * - Minor units rather than a decimal string (`"1234.56"`) because the decimal
 *   form requires the reader to know the currency's exponent. Keeping the wire
 *   format in minor units keeps it currency-agnostic, which matters when
 *   currency arrives (spec §13) and the exponent stops being 2 everywhere.
 *
 * Decimal strings are a *presentation* format: produced by `toDecimalString`
 * for the UI, consumed by `fromDecimalString` from the money input component.
 */
export function fromMinorString(text: string): Money {
  if (!MINOR_UNITS_PATTERN.test(text)) {
    throw new MoneyParseError(
      `Expected a canonical integer string of minor units, received ${JSON.stringify(text)}.`,
    );
  }
  return fromMinorUnits(BigInt(text));
}

/**
 * Parses a decimal string such as `"1234.56"` exactly.
 *
 * The digits are assembled with `BigInt`; the input never touches `Number` or
 * `parseFloat`, so `"0.07"` cannot arrive as 0.07000000000000001 and a value
 * larger than `Number.MAX_SAFE_INTEGER` parses without loss.
 */
export function fromDecimalString(text: string): Money {
  const match = DECIMAL_PATTERN.exec(text);
  if (!match) {
    throw new MoneyParseError(
      `Expected a decimal amount with at most ${String(MINOR_UNIT_EXPONENT)} fraction digits, ` +
        `received ${JSON.stringify(text)}.`,
    );
  }

  const [, sign, major = '0', fraction = ''] = match;
  const magnitude =
    BigInt(major) * MINOR_UNITS_PER_MAJOR + BigInt(fraction.padEnd(MINOR_UNIT_EXPONENT, '0'));

  return fromMinorUnits(sign === '-' ? -magnitude : magnitude);
}

/**
 * Composes an amount from separate major and minor fields — the shape the one
 * money input component (spec §12) collects.
 *
 * `major` carries the sign, so an amount smaller than one major unit cannot be
 * negative here: use `fromDecimalString('-0.05')` or `negate` for that.
 */
export function fromMajorMinor(major: bigint, minor: bigint): Money {
  if (minor < 0n || minor >= MINOR_UNITS_PER_MAJOR) {
    throw new MoneyParseError(
      `Minor units must be in [0, ${String(MINOR_UNITS_PER_MAJOR)}), received ${String(minor)}.`,
    );
  }
  const magnitude = (major < 0n ? -major : major) * MINOR_UNITS_PER_MAJOR + minor;
  return fromMinorUnits(major < 0n ? -magnitude : magnitude);
}

/** The wire form. See `fromMinorString` for why this, and not a JSON number. */
export function toMinorString(value: Money): string {
  return toMinorUnits(value).toString();
}

/** The presentation form: always exactly `MINOR_UNIT_EXPONENT` fraction digits. */
export function toDecimalString(value: Money): string {
  const minorUnits = toMinorUnits(value);
  const negative = minorUnits < 0n;
  const magnitude = negative ? -minorUnits : minorUnits;
  const major = (magnitude / MINOR_UNITS_PER_MAJOR).toString();
  const fraction = (magnitude % MINOR_UNITS_PER_MAJOR)
    .toString()
    .padStart(MINOR_UNIT_EXPONENT, '0');

  return `${negative ? '-' : ''}${major}.${fraction}`;
}

/* ---------------------------------------------------------------------------
 * Arithmetic core.
 *
 * `openbooks/no-float-money` bans operators on money-typed expressions
 * everywhere (spec §11, §12). The two functions below are what that ban exists
 * to protect: application code calls them instead of writing `a + b`, which
 * means the operators have to be written once, somewhere, and this is the
 * defined place. The exemption covers these two lines rather than the file, so
 * everything else here — including anything added later — is still checked, and
 * the rest of the module is built from these two primitives.
 *
 * Neither divides nor rounds, so neither can lose a cent.
 * ------------------------------------------------------------------------- */
/* eslint-disable openbooks/no-float-money -- see the note above: this is the single defined
   place where money arithmetic is written, and every other caller routes through it. */

export function add(a: Money, b: Money): Money {
  return fromMinorUnits(a + b);
}

export function subtract(a: Money, b: Money): Money {
  return fromMinorUnits(a - b);
}

/* eslint-enable openbooks/no-float-money */

/**
 * Expressed through `subtract` so the exempted region above stays two lines
 * wide. `-value` would also trip `no-unsafe-unary-minus`, which cannot see that
 * a branded intersection over `bigint` is still a `bigint`.
 */
export function negate(value: Money): Money {
  return subtract(ZERO, value);
}

/** Exact total. Empty input is `ZERO`, so folding an empty invoice is not a special case. */
export function sum(values: Iterable<Money>): Money {
  let total = ZERO;
  for (const value of values) {
    total = add(total, value);
  }
  return total;
}

export function abs(value: Money): Money {
  return isNegative(value) ? negate(value) : value;
}

/** Sort-friendly three-way comparison. */
export function compare(a: Money, b: Money): -1 | 0 | 1 {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

export function equals(a: Money, b: Money): boolean {
  return a === b;
}

export function isZero(value: Money): boolean {
  return value === ZERO;
}

export function isNegative(value: Money): boolean {
  return value < ZERO;
}

export function isPositive(value: Money): boolean {
  return value > ZERO;
}
