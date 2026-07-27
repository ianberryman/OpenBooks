/**
 * The tax rate primitive (ROADMAP D-35).
 *
 * A rate is a named percentage. It is not money, so `Money` is the wrong type for
 * it — but the argument D-13 makes about money applies unchanged: a rate must not
 * be a float. `0.07` is not 7% in binary floating point, and a rate is *multiplied*
 * rather than added, so the error it carries is scaled by every amount it touches
 * before anyone sees it. `cents / 100` producing `1234.5599999999999` is the
 * visible version of the same defect; a rate makes it invisible.
 *
 * ## The representation, and what it can and cannot express
 *
 * A rate is a branded `bigint` counting **parts per million of the amount** —
 * that is, the numerator of an exact fraction whose denominator is fixed at
 * 1,000,000. 20% is `200000`, 8.875% is `88750`, 0% is `0`.
 *
 * It can express any percentage from 0 to 100 in steps of 0.0001% — four decimal
 * places of a percent. That bound is chosen from the rates that exist rather than
 * for roundness: basis points (0.01%, denominator 10,000) is the obvious answer and
 * it is **wrong**, because 8.875% — New York City's combined sales tax — is 887.5
 * basis points and therefore inexpressible. Four decimals of a percent covers every
 * combined US local rate we could find, including four-decimal ones like 8.0625%,
 * and every VAT/GST rate in use.
 *
 * It cannot express:
 *
 * - **A repeating fraction.** One third is `333333` and is short by a millionth of
 *   the amount, which rounds away below about 500,000 major units. No fixed-scale
 *   representation escapes this; a `Ratio` with a free denominator would, and it
 *   was rejected because the rate has to survive a database column and a column has
 *   a scale.
 * - **A rate above 100%.** `taxRateFromPercentString` refuses one. The cost is real
 *   — some excise regimes exceed the price they are charged on — and the benefit is
 *   that `20` typed into a field expecting a fraction stays a `validation_failed`
 *   instead of a 2,000% invoice. An excise regime of that shape is out of D-35's
 *   scope beside compound and multi-component rates.
 * - **A negative rate.** A refund is a credit note (D-39), not a negative tax, and
 *   the sign of a document's tax comes from the sign of its lines. Barring it here
 *   is what makes "no negative tax on a positive line" a property of the arithmetic
 *   rather than a check somebody has to remember.
 * - **Compound or multi-component rates** (GST+PST), and any jurisdiction rule.
 *   D-35 puts them out of M3 explicitly: they are a subsystem, not a field.
 *
 * ## Why the wire form is a decimal percentage and not the internal integer
 *
 * Money crosses JSON as minor units because a decimal amount would require the
 * reader to know the currency's exponent (D-13). A rate carries no such hidden
 * exponent: a percentage means the same thing to every reader, and `"8.875"` is
 * what the person typed and what their tax authority publishes. `"88750"` would be
 * a number nobody recognises, in a unit this file invented.
 *
 * It is a *string* for D-13's other reason, which does apply: a JSON number is an
 * IEEE-754 double in every mainstream parser, so `7.1` arrives as
 * 7.0999999999999996 and a client that round-trips a rate reformats it. The string
 * is parsed with `BigInt` and never touches `Number`.
 */

import type { Ratio } from '../money';
import { MoneyParseError, ratio } from '../money';

declare const taxRateBrand: unique symbol;

/**
 * A tax rate, as parts per million of the amount it is charged on.
 *
 * Branded for the reason `Money` is: a bare `bigint` alias would let a percentage
 * (`20`), a fraction (`0.2` — already impossible, it is not an integer) and the
 * internal units (`200000`) occupy the same type, and the whole class of tax bug
 * this file exists to prevent starts with two of those being confused. The brand
 * symbol is not exported, so nothing outside this file produces a `TaxRate` except
 * through the constructors below.
 */
export type TaxRate = bigint & { readonly [taxRateBrand]: 'TaxRate' };

/**
 * The fixed denominator. A rate of `units` means `units / 1_000_000` of the amount.
 *
 * One place, so that a widening to more decimals is a change here and nowhere else.
 */
export const TAX_RATE_DENOMINATOR = 1_000_000n;

/** 1% is 10,000 units, which is what makes four decimals of a percent exact. */
export const TAX_RATE_UNITS_PER_PERCENT = 10_000n;

/** How many fraction digits a percentage may carry on the wire. */
export const TAX_RATE_PERCENT_DECIMALS = 4;

/** 100%, the largest rate this system accepts. See the file header for why. */
export const MAX_TAX_RATE_UNITS = TAX_RATE_DENOMINATOR;

export const ZERO_TAX_RATE = 0n as TaxRate;

/**
 * Optional integer part with no leading zeros, and at most
 * `TAX_RATE_PERCENT_DECIMALS` fraction digits. Deliberately strict in the same way
 * `MINOR_UNITS_PATTERN` is: `"08"`, `".5"`, `"20%"`, `"1e2"` and `"-5"` are all a
 * producer's bug, and a fifth fraction digit is refused rather than rounded —
 * rounding happens in one place (`scale`), and parsing is not it.
 */
const PERCENT_PATTERN = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,4}))?$/;

/**
 * The primitive constructor every other constructor funnels through, so the bounds
 * are checked on every route a rate takes into the system.
 */
export function taxRateFromUnits(units: bigint): TaxRate {
  if (units < 0n || units > MAX_TAX_RATE_UNITS) {
    throw new MoneyParseError(
      `A tax rate must be between 0% and 100%, received ${units.toString()} parts per million.`,
    );
  }
  return units as TaxRate;
}

/**
 * Parses the wire form: a decimal percentage such as `"8.875"`.
 *
 * `MoneyParseError` rather than a second error class, matching
 * `ratioFromDecimalString` next door, which already throws it for a malformed rate.
 * The transport maps that one class to a 400; a parallel `TaxRateParseError` would
 * need a parallel mapping and would say nothing the message does not.
 */
export function taxRateFromPercentString(text: string): TaxRate {
  const match = PERCENT_PATTERN.exec(text);
  if (!match) {
    throw new MoneyParseError(
      `Expected a percentage with at most ${String(TAX_RATE_PERCENT_DECIMALS)} fraction digits ` +
        `and no sign, received ${JSON.stringify(text)}.`,
    );
  }

  const [, whole = '0', fraction = ''] = match;
  const units =
    BigInt(whole) * TAX_RATE_UNITS_PER_PERCENT +
    BigInt(fraction.padEnd(TAX_RATE_PERCENT_DECIMALS, '0'));

  return taxRateFromUnits(units);
}

/**
 * The canonical wire form: no trailing zeros, no trailing point, so a rate has
 * exactly one spelling and two clients comparing rates as strings agree.
 */
export function taxRateToPercentString(rate: TaxRate): string {
  const whole = rate / TAX_RATE_UNITS_PER_PERCENT;
  const fraction = (rate % TAX_RATE_UNITS_PER_PERCENT)
    .toString()
    .padStart(TAX_RATE_PERCENT_DECIMALS, '0')
    .replace(/0+$/, '');

  return fraction === '' ? whole.toString() : `${whole.toString()}.${fraction}`;
}

/** Widens a `TaxRate` back to the `bigint` it is at runtime. */
export function taxRateUnits(rate: TaxRate): bigint {
  return rate;
}

export function isZeroTaxRate(rate: TaxRate): boolean {
  return rate === ZERO_TAX_RATE;
}

/**
 * The factor that turns a tax-exclusive amount into its tax: `rate / 1`.
 *
 * An exact `Ratio` so that `scale` — the one function in this repo that rounds —
 * is what applies it, at the one point D-35 names.
 */
export function exclusiveTaxRatio(rate: TaxRate): Ratio {
  return ratio(rate, TAX_RATE_DENOMINATOR);
}

/**
 * The factor that turns a tax-*inclusive* amount into its tax: `rate / (1 + rate)`.
 *
 * The algebra is worth writing down, because the way this goes wrong is to divide
 * by `1 + rate` and round twice. With a gross `G` and a rate `r`, the net is
 * `G / (1 + r)` and the tax is `G − G/(1 + r)` = `G · r / (1 + r)`. Expressed as one
 * ratio it is a single multiplication with a single rounding, and the net is then
 * `G − tax` by subtraction — which is exact, so `net + tax === gross` holds for
 * every input rather than for most of them. Rounding the net independently would
 * lose that, and the customer adding up the page is the one who would find it.
 */
export function inclusiveTaxRatio(rate: TaxRate): Ratio {
  return ratio(rate, TAX_RATE_DENOMINATOR + rate);
}
