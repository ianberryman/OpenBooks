/**
 * The single rounding point (spec §11: "rounding applied once at a defined
 * point, deterministic").
 *
 * Every other money operation in this package is exact: `add`, `subtract`,
 * `sum` and `negate` cannot lose a cent, and `allocate` is lossless by
 * construction. Rounding only becomes necessary when an exact amount is
 * multiplied by a fraction — a tax rate, a discount percentage, a proration —
 * and `scale` is the one function that does that. If a calculation appears to
 * need rounding anywhere else, it is expressing a ratio and should be routed
 * through `scale` instead.
 *
 * The corollary matters as much as the rule: apply `scale` once per amount, not
 * once per intermediate step. Rounding a per-line tax and then rounding the
 * summed total rounds twice and the two results disagree by cents. Define the
 * point (per line, or on the total) and round there only.
 */

import type { Money } from './money';
import { MoneyParseError, fromMinorUnits, toMinorUnits } from './money';

/**
 * - `half-up` — ties go away from zero (0.5 → 1, −0.5 → −1).
 * - `half-even` — ties go to the even neighbour (0.5 → 0, 1.5 → 2).
 */
export type RoundingMode = 'half-up' | 'half-even';

/**
 * `half-up` is the default because tax authorities specify it, so matching it
 * keeps computed tax equal to the tax on the filing. Both modes here are
 * symmetric about zero — `round(−x) === −round(x)` — which is the property the
 * ledger actually depends on: a reversal (spec §2.2, roadmap D-02) must be the
 * exact mirror of the original, and a mode like "half ceiling" would leave a
 * cent behind on reversal. `half-even` is offered for callers that need to
 * avoid upward bias when rounding many amounts, since its ties cancel.
 */
export const DEFAULT_ROUNDING_MODE: RoundingMode = 'half-up';

/** An exact rational factor. Rates are never floats, for the same reason money is not. */
export interface Ratio {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

/** The numerator may be negative (a credit); the denominator must be positive. */
export function ratio(numerator: bigint, denominator: bigint): Ratio {
  if (denominator <= 0n) {
    throw new RangeError(`Ratio denominator must be positive, received ${String(denominator)}.`);
  }
  return { numerator, denominator };
}

/**
 * Parses a rate such as `"0.0825"` into 825/10000 exactly.
 *
 * Unlike money, a rate has no fixed number of decimals, so the denominator is
 * derived from the input's precision rather than fixed at a currency exponent.
 */
export function ratioFromDecimalString(text: string): Ratio {
  const match = /^(-)?([0-9]+)(?:\.([0-9]+))?$/.exec(text);
  if (!match) {
    throw new MoneyParseError(`Expected a decimal rate, received ${JSON.stringify(text)}.`);
  }

  const [, sign, whole = '0', fraction = ''] = match;
  const numerator = BigInt(`${whole}${fraction}`);
  const denominator = 10n ** BigInt(fraction.length);

  return ratio(sign === '-' ? -numerator : numerator, denominator);
}

/**
 * Multiplies an amount by an exact ratio and rounds the result to whole minor
 * units. This is the only function in the package that rounds.
 */
export function scale(
  amount: Money,
  factor: Ratio,
  mode: RoundingMode = DEFAULT_ROUNDING_MODE,
): Money {
  return fromMinorUnits(
    divideRounded(toMinorUnits(amount) * factor.numerator, factor.denominator, mode),
  );
}

/**
 * Rounded integer division on plain `bigint`.
 *
 * Works on magnitudes and reapplies the sign at the end, which is what makes
 * both modes symmetric about zero regardless of how the host language happens
 * to truncate negative division.
 */
function divideRounded(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const absNumerator = numerator < 0n ? -numerator : numerator;
  const absDenominator = denominator < 0n ? -denominator : denominator;

  const quotient = absNumerator / absDenominator;
  const twiceRemainder = (absNumerator % absDenominator) * 2n;

  let rounded = quotient;
  if (twiceRemainder > absDenominator) {
    rounded = quotient + 1n;
  } else if (twiceRemainder === absDenominator) {
    // Exact tie: away from zero, or up only when that lands on an even quotient.
    rounded = mode === 'half-up' ? quotient + 1n : quotient + (quotient % 2n);
  }

  return negative ? -rounded : rounded;
}
