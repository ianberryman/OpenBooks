/**
 * Lossless proportional splitting (spec §11: "discount + tax allocation sums
 * exactly with no lost cents").
 *
 * The naive split — round each share independently — loses or invents cents
 * whenever the amount does not divide by the weights, and those cents surface
 * later as an unbalanced journal. `allocate` instead hands out the truncated
 * shares and then distributes the leftover minor units one at a time, largest
 * fractional remainder first.
 */

import type { Money } from './money';
import { ZERO, fromMinorUnits, toMinorUnits } from './money';

interface Share {
  readonly index: number;
  readonly whole: bigint;
  readonly remainder: bigint;
}

/**
 * Splits `amount` across `weights` proportionally.
 *
 * Guarantees, all of which the tests assert:
 *
 * 1. **Exactness.** `sum(allocate(a, w))` equals `a` — always, for every amount
 *    and weight vector. Nothing is lost and nothing is created.
 * 2. **Determinism.** Leftover minor units go to the largest fractional
 *    remainder, and ties break toward the lower index. The same inputs always
 *    produce the same output, so two services computing the same split agree.
 * 3. **Sign mirroring.** `allocate(negate(a), w)` is `allocate(a, w)` with every
 *    part negated, because the split is computed on the magnitude. A reversal
 *    therefore cancels its original line for line (spec §2.2, roadmap D-02).
 * 4. **Zero weights get zero.** A weight of `0n` never receives a leftover
 *    unit, so an untaxed line stays untaxed.
 *
 * Weights are `bigint` because they are usually themselves money (line
 * subtotals). Any non-negative integer scale works; only the proportions matter.
 */
export function allocate(amount: Money, weights: readonly bigint[]): Money[] {
  if (weights.length === 0) {
    throw new RangeError('allocate requires at least one weight.');
  }

  let totalWeight = 0n;
  for (const weight of weights) {
    if (weight < 0n) {
      throw new RangeError(`allocate weights must be non-negative, received ${String(weight)}.`);
    }
    totalWeight += weight;
  }

  const minorUnits = toMinorUnits(amount);

  if (totalWeight === 0n) {
    // Splitting nothing across nothing is well defined; splitting something is not.
    if (minorUnits !== 0n) {
      throw new RangeError('allocate cannot split a non-zero amount across zero total weight.');
    }
    return weights.map(() => ZERO);
  }

  const negative = minorUnits < 0n;
  const magnitude = negative ? -minorUnits : minorUnits;

  const shares: Share[] = weights.map((weight, index) => {
    const scaled = magnitude * weight;
    return { index, whole: scaled / totalWeight, remainder: scaled % totalWeight };
  });

  const distributed = shares.reduce((total, share) => total + share.whole, 0n);
  // Truncation loses strictly fewer than one unit per share, so this fits a number.
  const leftover = Number(magnitude - distributed);

  const bumped = new Set(
    [...shares]
      .sort((a, b) => compareShares(a, b))
      .slice(0, leftover)
      .map((share) => share.index),
  );

  return shares.map((share) => {
    const whole = bumped.has(share.index) ? share.whole + 1n : share.whole;
    return fromMinorUnits(negative ? -whole : whole);
  });
}

/** Splits an amount into `parts` equal shares, leftover cents to the earliest parts. */
export function allocateEvenly(amount: Money, parts: number): Money[] {
  if (!Number.isInteger(parts) || parts < 1) {
    throw new RangeError(`allocateEvenly requires a positive integer, received ${String(parts)}.`);
  }
  return allocate(
    amount,
    Array.from({ length: parts }, () => 1n),
  );
}

/** Largest remainder first, lower index first on a tie. */
function compareShares(a: Share, b: Share): number {
  if (a.remainder === b.remainder) return a.index - b.index;
  return a.remainder > b.remainder ? -1 : 1;
}
