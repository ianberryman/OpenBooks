import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  costAddition,
  costSale,
  deriveUnitCost,
  receiptTrueUp,
} from '../../src/modules/inventory/costing';
import type { OnHand } from '../../src/modules/inventory/costing';

/**
 * The weighted-average costing arithmetic (OB-224), proven exhaustively because it is
 * pure — no database, `depreciation.test.ts`'s reason for the same treatment.
 *
 * The load-bearing property is the **zero-out invariant**: an item whose on-hand
 * quantity reaches exactly zero must have exactly zero value, or the inventory-asset
 * account never clears and the subledger drifts by the stranded residual cents. It is
 * the inventory analogue of `no-float-money`, and it is asserted here two ways — as a
 * unit fact about the one call that must sweep, and as a property over a random walk
 * of receipts and sales that must never leave value on a zero quantity.
 */

const MICROS = 1_000_000n;

describe('costSale', () => {
  it('sweeps the entire remaining value when a sale exactly exhausts on-hand', () => {
    // 3 units carried at 1000 total; sell all 3. The average is 333.33…, and
    // 3 × round(333) would leave a cent behind. The sweep takes the whole 1000.
    const result = costSale({ qtyMicros: 3n * MICROS, valueMinor: 1000n }, 3n * MICROS, null);

    expect(result.cogsValueMinor).toBe(1000n);
    expect(result.valueDeltaMinor).toBe(-1000n);
    expect(result.zeroedOut).toBe(true);
    expect(result.estimated).toBe(false);
  });

  it('costs a partial sale at the current moving average', () => {
    // 10 units at 2500 (250 each); sell 4 → 1000.
    const result = costSale({ qtyMicros: 10n * MICROS, valueMinor: 2500n }, 4n * MICROS, null);

    expect(result.cogsValueMinor).toBe(1000n);
    expect(result.valueDeltaMinor).toBe(-1000n);
    expect(result.zeroedOut).toBe(false);
    expect(result.estimated).toBe(false);
  });

  it('flags an overshoot — a sale beyond on-hand — as estimated', () => {
    const result = costSale({ qtyMicros: 2n * MICROS, valueMinor: 500n }, 5n * MICROS, null);

    // Costed at the current average (250) across all 5 units: 1250.
    expect(result.cogsValueMinor).toBe(1250n);
    expect(result.estimated).toBe(true);
  });

  it('costs a sale into a negative layer at the negative layer’s own average', () => {
    // On hand -4 units at -1000 (a 250 average carried as a credit). Sell 2 more.
    const result = costSale({ qtyMicros: -4n * MICROS, valueMinor: -1000n }, 2n * MICROS, null);

    expect(result.cogsValueMinor).toBe(500n);
    expect(result.valueDeltaMinor).toBe(-500n);
    expect(result.estimated).toBe(true);
  });

  it('falls back to the default cost when the item has never held stock', () => {
    const result = costSale({ qtyMicros: 0n, valueMinor: 0n }, 3n * MICROS, 250n);

    expect(result.cogsValueMinor).toBe(750n);
    expect(result.estimated).toBe(true);
  });

  it('costs at zero when there is no layer and no default', () => {
    const result = costSale({ qtyMicros: 0n, valueMinor: 0n }, 3n * MICROS, null);

    expect(result.cogsValueMinor).toBe(0n);
    expect(result.estimated).toBe(true);
  });
});

describe('receiptTrueUp', () => {
  it('is null for a plain receipt into a non-negative balance', () => {
    expect(
      receiptTrueUp({ qtyMicros: 5n * MICROS, valueMinor: 1000n }, 3n * MICROS, 900n),
    ).toBeNull();
    expect(receiptTrueUp({ qtyMicros: 0n, valueMinor: 0n }, 3n * MICROS, 900n)).toBeNull();
  });

  it('is null while a receipt does not yet bring on-hand positive', () => {
    // On hand -10, receive 4 → still -6: nothing to reconcile yet.
    expect(
      receiptTrueUp({ qtyMicros: -10n * MICROS, valueMinor: -2500n }, 4n * MICROS, 1000n),
    ).toBeNull();
  });

  it('revalues the surviving units at the receipt’s real cost when on-hand goes positive', () => {
    // On hand -2 at -500 (estimated at 250). Receive 6 at 1800 (300 each). New qty +4;
    // those 4 should be worth 4 × 300 = 1200. A plain receipt would leave -500 + 1800 =
    // 1300, so the true-up removes 100.
    const trueUp = receiptTrueUp(
      { qtyMicros: -2n * MICROS, valueMinor: -500n },
      6n * MICROS,
      1800n,
    );

    expect(trueUp).not.toBeNull();
    expect(trueUp?.valueDeltaMinor).toBe(-100n);
  });

  it('sweeps to exactly zero when a receipt covers the shortfall precisely at a new cost', () => {
    // On hand -3 estimated at -900 (300 each). Receive exactly 3 at 1200 (400 each) →
    // new qty 0, so value must be swept to exactly 0. A plain receipt would leave
    // -900 + 1200 = 300 stranded on a zero quantity; the true-up removes it.
    const pre: OnHand = { qtyMicros: -3n * MICROS, valueMinor: -900n };
    const trueUp = receiptTrueUp(pre, 3n * MICROS, 1200n);

    expect(trueUp?.valueDeltaMinor).toBe(-300n);
    // The fold after applying the receipt and the true-up: -900 + 1200 - 300 = 0.
    expect(pre.valueMinor + 1200n + (trueUp?.valueDeltaMinor ?? 0n)).toBe(0n);
  });
});

describe('deriveUnitCost', () => {
  it('is null on a zero quantity', () => {
    expect(deriveUnitCost({ qtyMicros: 0n, valueMinor: 0n })).toBeNull();
  });

  it('is value per whole unit', () => {
    expect(deriveUnitCost({ qtyMicros: 4n * MICROS, valueMinor: 1000n })).toBe(250n);
  });
});

/**
 * The property the whole module exists to guarantee: over any interleaving of
 * receipts and sales, the fold never leaves value stranded on a zero quantity, and a
 * sale never costs more than the value on hand plus what a fresh estimate adds.
 */
describe('the zero-out invariant holds over a random walk', () => {
  it('leaves exactly zero value whenever on-hand quantity returns to zero', () => {
    const step = fc.record({
      kind: fc.constantFrom<'receipt' | 'sale'>('receipt', 'sale'),
      units: fc.integer({ min: 1, max: 20 }),
      // Receipt cost in cents; only read for a receipt.
      cost: fc.integer({ min: 0, max: 5000 }),
    });

    fc.assert(
      fc.property(fc.array(step, { minLength: 1, maxLength: 40 }), (steps) => {
        let hand: OnHand = { qtyMicros: 0n, valueMinor: 0n };

        for (const s of steps) {
          const units = BigInt(s.units) * MICROS;
          if (s.kind === 'receipt') {
            const value = BigInt(s.cost);
            const trueUp = receiptTrueUp(hand, units, value);
            hand = {
              qtyMicros: hand.qtyMicros + units,
              valueMinor: hand.valueMinor + value + (trueUp?.valueDeltaMinor ?? 0n),
            };
          } else {
            const costing = costSale(hand, units, null);
            hand = {
              qtyMicros: hand.qtyMicros - units,
              valueMinor: hand.valueMinor + costing.valueDeltaMinor,
            };
          }

          // The invariant: a zero quantity carries exactly zero value.
          if (hand.qtyMicros === 0n) expect(hand.valueMinor).toBe(0n);
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe('costAddition', () => {
  it('values found stock at the current average', () => {
    expect(costAddition({ qtyMicros: 4n * MICROS, valueMinor: 1000n }, 2n * MICROS, null)).toBe(
      500n,
    );
  });

  it('values found stock at the default when no layer exists', () => {
    expect(costAddition({ qtyMicros: 0n, valueMinor: 0n }, 2n * MICROS, 300n)).toBe(600n);
  });
});
