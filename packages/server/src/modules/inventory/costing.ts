/**
 * Weighted-average inventory costing: pure arithmetic, no database and no context
 * (initiative INVENTORY, OB-224; ROADMAP § Milestone INVENTORY).
 *
 * `inventory.repository.ts`'s `selectOnHandFold` is the one place on-hand is
 * computed — a fold over `inventory_movements` — and this file is the one place
 * that fold's two numbers (`qtyMicros`, `valueMinor`) are turned into a costed
 * consumption or a costed addition. Nothing here reads a row, so nothing here
 * needs `useTestDatabase()` to be proven exhaustively, `depreciation.ts`'s own
 * reason for staying pure.
 *
 * ## The unit cost is derived, never stored
 *
 * `value / qty` is a rational and every caller computes it fresh from the two
 * signed running totals the movement log carries. Storing it would mean two
 * numbers can disagree — a movement's own layer cost drifting from what the fold
 * says — and the append-only movement log exists precisely so there is only ever
 * one number to disagree with itself.
 *
 * ## The zero-out invariant — the inventory analogue of `no-float-money`
 *
 * A sale that exactly exhausts on-hand (`saleQtyMicros === qtyMicros`) sweeps the
 * *entire* remaining value into COGS rather than computing `qty × unitCost` and
 * leaving a residual cent stranded on a zero quantity. `openbooks/no-float-money`
 * catches a float where money should be a bigint; there is no lint rule that can
 * catch "on-hand reads zero units and a non-zero dollar value", so the arithmetic
 * itself is written to make that state unreachable rather than merely unlikely.
 *
 * ## Negative on-hand is a backorder accommodation, not a rejection
 *
 * A sale may run an item below zero (allowed with a warning upstream); this module
 * never refuses it. Below zero there is no positive layer to average over, so the
 * cost is an *estimate* — the negative layer's own average when one exists, or the
 * item's `default_cost_minor` per whole unit, or zero when neither is known. Every
 * one of those branches sets `estimated: true`, which is what lets a caller flag
 * the line rather than presenting a guess as a fact. `receiptTrueUp` is the other
 * half: the next receipt that brings on-hand positive again reconciles the
 * estimate against the receipt's real unit cost, in one true-up entry.
 */

export interface OnHand {
  readonly qtyMicros: bigint;
  readonly valueMinor: bigint;
}

export interface SaleCosting {
  readonly cogsValueMinor: bigint;
  readonly valueDeltaMinor: bigint;
  readonly zeroedOut: boolean;
  readonly estimated: boolean;
}

/** Whole units are counted in millionths — `pricing.ts`'s `quantityToMicros` scale. */
const MICROS_PER_UNIT = 1_000_000n;

/**
 * Exact integer division, rounded half-away-from-zero on the magnitude, sign
 * applied from `numer` — `numer`'s own sign, since `denom` is always positive at
 * every call site below (a caller with a negative denominator normalizes it to a
 * positive one, flipping `numer` to match, before reaching here).
 *
 * Round-half-*up* on the unsigned magnitude rather than half-even: this is a cost
 * allocation, not a financial rate, and `tax/compute.ts`'s `DEFAULT_ROUNDING_MODE`
 * argument for the tax split does not apply here — there is no regulator specifying
 * a mode for splitting inventory value, so the simpler, more legible rule is taken.
 */
function roundBigintRational(numer: bigint, denom: bigint): bigint {
  const sign = numer < 0n ? -1n : 1n;
  const magnitude = numer < 0n ? -numer : numer;
  const quotient = magnitude / denom;
  const remainder = magnitude % denom;
  const rounded = remainder * 2n >= denom ? quotient + 1n : quotient;
  return sign * rounded;
}

/**
 * Costs a sale (or a stock adjustment's removal, which is the same consumption
 * shape) of `saleQtyMicros` units — always positive; the caller's movement is the
 * one that negates it.
 *
 * Four cases, in the order they are checked:
 *
 *  1. **Zero-out** (`qtyMicros > 0` and the sale exactly exhausts it): the whole
 *     remaining `valueMinor` is swept into COGS, exactly, rather than
 *     `roundBigintRational`'s own rounding leaving a residual cent on a zero
 *     quantity.
 *  2. **Normal / overshoot** (`qtyMicros > 0`, any `saleQtyMicros`): costed at the
 *     current average, `saleQtyMicros × valueMinor / qtyMicros`. An overshoot
 *     (selling more than is on hand) uses the same average — there is no other
 *     number to use — and is flagged `estimated` because the units past what was
 *     on hand are not yet costed by anything real.
 *  3. **Negative layer** (`qtyMicros < 0`): the existing negative average,
 *     `valueMinor / qtyMicros`, restated with a positive denominator.
 *  4. **No layer at all** (`qtyMicros === 0`): `defaultCostMinor` per whole unit
 *     when the item has one, or zero when it does not — the last-resort estimate
 *     for an item that has never been received.
 *
 * Every case but the first is `estimated`, because only the first is priced
 * against inventory that is actually known to be worth what it says.
 */
export function costSale(
  onHand: OnHand,
  saleQtyMicros: bigint,
  defaultCostMinor: bigint | null,
): SaleCosting {
  const qtyMicros = onHand.qtyMicros;
  const valueMinor = onHand.valueMinor;

  if (qtyMicros > 0n && saleQtyMicros === qtyMicros) {
    return {
      cogsValueMinor: valueMinor,
      valueDeltaMinor: -valueMinor,
      zeroedOut: true,
      estimated: false,
    };
  }

  if (qtyMicros > 0n) {
    const cogsValueMinor = roundBigintRational(saleQtyMicros * valueMinor, qtyMicros);
    return {
      cogsValueMinor,
      valueDeltaMinor: -cogsValueMinor,
      zeroedOut: false,
      estimated: saleQtyMicros > qtyMicros,
    };
  }

  if (qtyMicros < 0n) {
    // valueMinor / qtyMicros restated with a positive denominator: both negated,
    // an equivalent fraction, so `roundBigintRational`'s positive-denominator
    // contract holds regardless of `valueMinor`'s own sign.
    const cogsValueMinor = roundBigintRational(saleQtyMicros * -valueMinor, -qtyMicros);
    return { cogsValueMinor, valueDeltaMinor: -cogsValueMinor, zeroedOut: false, estimated: true };
  }

  if (defaultCostMinor === null) {
    return { cogsValueMinor: 0n, valueDeltaMinor: 0n, zeroedOut: false, estimated: true };
  }

  const cogsValueMinor = roundBigintRational(saleQtyMicros * defaultCostMinor, MICROS_PER_UNIT);
  return { cogsValueMinor, valueDeltaMinor: -cogsValueMinor, zeroedOut: false, estimated: true };
}

/**
 * The value of *adding* `additionQtyMicros` units — a stock adjustment's found
 * stock, or any other positive quantity delta that is not a receipt (a receipt
 * carries its own real value; nothing here is reached for one). Valued at the
 * current average when a positive layer exists, or at `defaultCostMinor` per
 * whole unit when it does not, `costSale`'s own no-layer fallback restated for an
 * addition instead of a consumption. Never `estimated`-flagged: unlike a sale that
 * outruns its layer, an addition never draws on a cost it does not have — it
 * either prices against a real average or against the item's own nominated
 * default, and both are as authoritative as a value can be without a receipt.
 */
export function costAddition(
  onHand: OnHand,
  additionQtyMicros: bigint,
  defaultCostMinor: bigint | null,
): bigint {
  if (onHand.qtyMicros > 0n) {
    return roundBigintRational(additionQtyMicros * onHand.valueMinor, onHand.qtyMicros);
  }
  if (defaultCostMinor === null) return 0n;
  return roundBigintRational(additionQtyMicros * defaultCostMinor, MICROS_PER_UNIT);
}

/**
 * The moving-average unit cost, minor units per whole unit, rounded for display
 * only — never stored (the header note above). `null` when on-hand quantity is
 * zero, where there is no meaningful average to show.
 */
export function deriveUnitCost(onHand: OnHand): bigint | null {
  if (onHand.qtyMicros === 0n) return null;

  const numerator = onHand.valueMinor * MICROS_PER_UNIT;
  const denominator = onHand.qtyMicros;
  return denominator < 0n
    ? roundBigintRational(-numerator, -denominator)
    : roundBigintRational(numerator, denominator);
}

export interface ReceiptTrueUp {
  readonly valueDeltaMinor: bigint;
}

/**
 * Reconciles a negative-inventory estimate against a receipt's real cost.
 *
 * Only fires when `preOnHand.qtyMicros < 0` — a plain receipt into a non-negative
 * balance needs no true-up, because nothing before it was ever a guess. When it
 * does fire and the receipt is large enough to bring on-hand back to positive
 * (`newQty > 0`), the units that remain are revalued at *this receipt's own* unit
 * cost (`receiptValueMinor / receiptQtyMicros`) rather than left at whatever the
 * earlier estimated sales assumed. `trueUpDelta` is the difference between that
 * target value and what a plain receipt posting would have left on hand
 * (`preOnHand.valueMinor + receiptValueMinor`); the caller posts `|trueUpDelta|`
 * between the inventory-asset and COGS accounts and appends a `true_up` movement
 * carrying it. A receipt that does not bring on-hand positive (`newQty <= 0`)
 * leaves the balance still estimated, so there is nothing yet to true up.
 */
export function receiptTrueUp(
  preOnHand: OnHand,
  receiptQtyMicros: bigint,
  receiptValueMinor: bigint,
): ReceiptTrueUp | null {
  if (preOnHand.qtyMicros >= 0n) return null;

  const newQty = preOnHand.qtyMicros + receiptQtyMicros;
  // `< 0n`, not `<= 0n`: a receipt that lands on-hand *exactly* at zero must still
  // true up, because the zero-out invariant demands zero value there and the estimated
  // negative layer plus this receipt's real cost does not generally sum to it. At
  // `newQty === 0` the target is `round(0 · cost / qty) = 0`, so the true-up sweeps the
  // residual to zero — the same sweep `costSale`'s exact-exhaustion branch performs on
  // the way down. Only a receipt that leaves on-hand still negative has nothing yet to
  // reconcile.
  if (newQty < 0n) return null;

  const targetValue = roundBigintRational(newQty * receiptValueMinor, receiptQtyMicros);
  const trueUpDelta = targetValue - (preOnHand.valueMinor + receiptValueMinor);
  return { valueDeltaMinor: trueUpDelta };
}
