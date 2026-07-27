import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Money } from '../money';
import { fromMinorUnits, negate, scale, sum, toMinorUnits } from '../money';

import type { Quantity, TaxMode, TaxSplit, TaxableLine } from './compute';
import {
  ONE_QUANTITY,
  QUANTITY_SCALE,
  TAX_MODES,
  addTax,
  computeDocument,
  computeLine,
  extendLine,
  extractTax,
  quantityFromString,
  quantityFromUnits,
  quantityToString,
  quantityUnits,
  splitTax,
} from './compute';
import type { TaxRate } from './rate';
import {
  MAX_TAX_RATE_UNITS,
  TAX_RATE_DENOMINATOR,
  exclusiveTaxRatio,
  taxRateFromPercentString,
  taxRateFromUnits,
  taxRateUnits,
} from './rate';

/**
 * The document arithmetic under generated inputs (OB-061; D-35, C5).
 *
 * Examples prove the arithmetic for the shapes someone thought of, and the two
 * mutations this file is built to catch are both invisible to an obvious example
 * suite: rounding the document total instead of summing rounded lines agrees with
 * the correct answer on any single-line document, and taking tax from the exact
 * product rather than from the rounded extension agrees on every whole quantity.
 * Both are the mistake CLAUDE.md's mutation-testing note describes — identical to
 * correct on the inputs an example writer reaches for first.
 */
const RUNS = 500;

const money = (arb: fc.Arbitrary<bigint>): fc.Arbitrary<Money> => arb.map(fromMinorUnits);

/** Bounded well inside the storable range; the sums below stay far from it. */
const anyAmount = money(fc.bigInt({ min: -1_000_000_000n, max: 1_000_000_000n }));
const positiveAmount = money(fc.bigInt({ min: 1n, max: 1_000_000_000n }));

const anyRate: fc.Arbitrary<TaxRate> = fc
  .bigInt({ min: 0n, max: MAX_TAX_RATE_UNITS })
  .map(taxRateFromUnits);

/**
 * Real rates alongside arbitrary ones. A generator that only draws uniformly over a
 * million units almost never produces 20%, and 20% is where a tie lands.
 */
const namedRate: fc.Arbitrary<TaxRate> = fc
  .constantFrom('0', '5', '7.25', '8.875', '10', '15', '17.5', '20', '25', '50', '100')
  .map(taxRateFromPercentString);

const rate = fc.oneof(anyRate, namedRate);

const anyQuantity: fc.Arbitrary<Quantity> = fc
  .bigInt({ min: -1_000_000n, max: 1_000_000n })
  .map(quantityFromUnits);

const mode: fc.Arbitrary<TaxMode> = fc.constantFrom(...TAX_MODES);

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));

/**
 * A unit price whose tax is exact, paired with the tax-inclusive price of the same
 * unit — the only pairing under which "the same economic invoice" is expressible in
 * both modes, because an inclusive price is still a whole number of cents (D-13).
 * Every net that is a multiple of `1_000_000 / gcd(rate, 1_000_000)` qualifies.
 */
const exactlyPricedUnit = fc
  .tuple(rate, fc.bigInt({ min: 1n, max: 1_000_000n }))
  .map(([lineRate, multiple]) => {
    const units = taxRateUnits(lineRate);
    const step = units === 0n ? 1n : TAX_RATE_DENOMINATOR / gcd(units, TAX_RATE_DENOMINATOR);
    const net = fromMinorUnits(multiple * step);
    return { rate: lineRate, net, gross: addTax(net, lineRate).gross };
  });

const minor = (split: TaxSplit): { net: bigint; tax: bigint; gross: bigint } => ({
  net: toMinorUnits(split.net),
  tax: toMinorUnits(split.tax),
  gross: toMinorUnits(split.gross),
});

const line = (unitAmount: Money, lineRate: TaxRate, quantity = ONE_QUANTITY): TaxableLine => ({
  quantity,
  unitAmount,
  rate: lineRate,
});

describe('a split always adds up', () => {
  it('holds `net + tax === gross` in both modes, for every amount and rate', () => {
    fc.assert(
      fc.property(anyAmount, rate, mode, (amount, taxRate, taxMode) => {
        const split = minor(splitTax(amount, taxRate, taxMode));
        expect(split.net + split.tax).toBe(split.gross);
      }),
      { numRuns: RUNS },
    );
  });

  it('preserves the amount the user typed, whichever end it was typed from', () => {
    fc.assert(
      fc.property(anyAmount, rate, (amount, taxRate) => {
        // Inclusive entry is a price list: the gross is the number on it, and it
        // must survive the split to the cent.
        expect(toMinorUnits(extractTax(amount, taxRate).gross)).toBe(toMinorUnits(amount));
        // Exclusive entry is a rate card: the net is the number on it.
        expect(toMinorUnits(addTax(amount, taxRate).net)).toBe(toMinorUnits(amount));
      }),
      { numRuns: RUNS },
    );
  });
});

describe('the page is verifiable from its own columns', () => {
  /**
   * The tax on a line is the rate applied to **the net that is printed beside it**,
   * not to the exact product behind it. A reader with a calculator must be able to
   * reproduce the tax column from the net column.
   *
   * This is the property that pins rounding point 2 to rounding point 1's *output*.
   * Taking tax from the unrounded `quantity × unitAmount` instead passes every
   * example with a whole quantity, every round-trip, every sign property and the
   * document-total properties — it was written as a mutation and survived all of
   * them — because it differs only when the extension itself rounds. Without this
   * assertion the suite has nothing to say about a fractional-quantity line, which
   * is exactly the line a services business invoices all day.
   */
  it('derives a line’s tax from the line’s own net, not from the exact product', () => {
    fc.assert(
      fc.property(anyAmount, anyQuantity, rate, (unit, quantity, r) => {
        const split = computeLine(line(unit, r, quantity), 'exclusive');
        expect(toMinorUnits(split.tax)).toBe(toMinorUnits(scale(split.net, exclusiveTaxRatio(r))));
      }),
      { numRuns: RUNS },
    );
  });

  it('derives an inclusive line’s net by subtraction, so the printed gross is exact', () => {
    fc.assert(
      fc.property(anyAmount, anyQuantity, rate, (unit, quantity, r) => {
        const split = computeLine(line(unit, r, quantity), 'inclusive');
        expect(toMinorUnits(split.gross)).toBe(toMinorUnits(extendLine(quantity, unit)));
        expect(toMinorUnits(split.net)).toBe(toMinorUnits(split.gross) - toMinorUnits(split.tax));
      }),
      { numRuns: RUNS },
    );
  });
});

describe('extraction and addition round-trip (C5)', () => {
  /**
   * The property C5 rests on, and it is exact rather than approximate. With
   * `t = round(N·r)` and `G = N + t`, extraction computes `G·r/(1+r) = t + δ/(1+r)`
   * where `δ = N·r − t` and `|δ| ≤ ½`; dividing by `1 + r ≥ 1` cannot push it back
   * across a rounding boundary, so extraction returns exactly `t` and therefore
   * exactly `N`. The generated runs are what say the implementation matches the
   * algebra.
   */
  it('recovers the exclusive net and tax from the gross it produced', () => {
    fc.assert(
      fc.property(anyAmount, rate, (net, taxRate) => {
        const added = addTax(net, taxRate);
        expect(minor(extractTax(added.gross, taxRate))).toEqual(minor(added));
      }),
      { numRuns: RUNS },
    );
  });

  it('is idempotent: extracting an already-extracted gross changes nothing', () => {
    fc.assert(
      fc.property(anyAmount, rate, (gross, taxRate) => {
        const once = extractTax(gross, taxRate);
        expect(minor(extractTax(once.gross, taxRate))).toEqual(minor(once));
      }),
      { numRuns: RUNS },
    );
  });

  /**
   * The other direction is **not** exact, and pretending otherwise is how a tax
   * model acquires a phantom cent. Take a gross of 7 at 50%: extraction gives tax 2
   * and net 5, but 5 with 50% added is tax 3 and gross 8. The two are not the same
   * economic invoice — nobody with a 50% rate ever charged 7 — and C5 pairs its two
   * entry modes through the direction above, which is the one that is exact.
   */
  it('does not claim the reverse round-trip, and here is the counterexample', () => {
    const half = taxRateFromPercentString('50');
    const extracted = extractTax(fromMinorUnits(7n), half);
    expect(minor(extracted)).toEqual({ net: 5n, tax: 2n, gross: 7n });
    expect(minor(addTax(extracted.net, half))).toEqual({ net: 5n, tax: 3n, gross: 8n });
  });

  it('produces identical documents from inclusive and exclusive entry of the same invoice', () => {
    fc.assert(
      fc.property(fc.array(positiveAmount, { minLength: 1, maxLength: 12 }), rate, (nets, r) => {
        const exclusive = computeDocument(
          nets.map((net) => line(net, r)),
          'exclusive',
        );
        // The same invoice as a price list: each line's tax-inclusive unit price is
        // the gross the exclusive entry produced.
        const inclusive = computeDocument(
          exclusive.lines.map((split) => line(split.gross, r)),
          'inclusive',
        );

        expect(inclusive.lines.map(minor)).toEqual(exclusive.lines.map(minor));
        expect(minor(inclusive.totals)).toEqual(minor(exclusive.totals));
      }),
      { numRuns: RUNS },
    );
  });

  /**
   * C5 with a quantity, which holds exactly when the extension does — here
   * 3 × 4.00 at 25% against 3 × 5.00 inclusive.
   */
  it('agrees across modes on a multi-unit line whose inclusive price is exact', () => {
    const quarter = taxRateFromPercentString('25');
    const three = quantityFromString('3');
    const exclusive = computeLine(line(fromMinorUnits(400n), quarter, three), 'exclusive');
    const inclusive = computeLine(line(fromMinorUnits(500n), quarter, three), 'inclusive');

    expect(minor(exclusive)).toEqual({ net: 1200n, tax: 300n, gross: 1500n });
    expect(minor(inclusive)).toEqual(minor(exclusive));
  });

  /**
   * And the limit of that agreement, measured rather than assumed.
   *
   * With a fractional quantity the two modes round *different rationals* — one
   * rounds `q·u` and then its tax, the other rounds `q·u(1+r)` — so they may land a
   * cent apart even when the inclusive unit price is exact. 0.3333 × 7 at 100%
   * extends to 2.3331 → 2 net, 2 tax, 4 gross; entered inclusive at 14 a unit it
   * extends to 4.6662 → 5 gross, 3 tax, 2 net. The bound is `½(1 + r) + ½ ≤ 2`
   * cents, asserted below over units whose inclusive price is exact.
   *
   * It is intrinsic rather than a defect of this implementation: no ordering of the
   * two roundings makes two different products round to the same integer. So
   * OB-071's C5 suite pairs its two entries on lines whose extension is exact —
   * every quantity of 1, which is also every line a price list produces.
   */
  it('diverges by at most two cents when the extension itself rounds', () => {
    const full = taxRateFromPercentString('100');
    const third = quantityFromString('0.3333');
    const exclusive = computeLine(line(fromMinorUnits(7n), full, third), 'exclusive');
    const inclusive = computeLine(line(fromMinorUnits(14n), full, third), 'inclusive');

    expect(minor(exclusive)).toEqual({ net: 2n, tax: 2n, gross: 4n });
    expect(minor(inclusive)).toEqual({ net: 2n, tax: 3n, gross: 5n });

    fc.assert(
      fc.property(exactlyPricedUnit, anyQuantity, (priced, quantity) => {
        const excl = computeLine(line(priced.net, priced.rate, quantity), 'exclusive');
        const incl = computeLine(line(priced.gross, priced.rate, quantity), 'inclusive');
        const drift = toMinorUnits(incl.gross) - toMinorUnits(excl.gross);
        expect(drift <= 2n && drift >= -2n).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });

  /**
   * The other half of that finding, and the one a service has to know: when the
   * inclusive unit price is **not** exactly representable, the two entries are not
   * the same invoice at all, and the gap grows with the quantity rather than
   * staying inside a cent. `u(1+r)` is rounded to a whole cent before the quantity
   * multiplies it, so half a cent of unit price becomes `q/2` cents of document.
   *
   * A user entering 6.0458 units at a 17.5% inclusive price cannot express the
   * exclusive invoice of the same goods, because the price they would have to type
   * is not a number of cents. That is a limit of money being cents (D-13) and not
   * of the tax arithmetic — and it is why a screen that offers to switch a document
   * between modes must reprice it rather than convert it.
   */
  it('grows with the quantity when the inclusive unit price is not representable', () => {
    fc.assert(
      fc.property(positiveAmount, anyQuantity, rate, (unit, quantity, r) => {
        const excl = computeLine(line(unit, r, quantity), 'exclusive');
        const incl = computeLine(line(addTax(unit, r).gross, r, quantity), 'inclusive');
        const drift = toMinorUnits(incl.gross) - toMinorUnits(excl.gross);
        const magnitude = drift < 0n ? -drift : drift;
        const units = quantityUnits(quantity);
        // |drift| ≤ |q|/2 + 2, multiplied out by 2 × QUANTITY_SCALE to stay integral.
        const bound = (units < 0n ? -units : units) + 4n * QUANTITY_SCALE;
        expect(magnitude * 2n * QUANTITY_SCALE <= bound).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });
});

describe('signs', () => {
  it('never puts a negative tax on a positive line, in either mode', () => {
    fc.assert(
      fc.property(positiveAmount, rate, mode, (amount, taxRate, taxMode) => {
        const split = minor(splitTax(amount, taxRate, taxMode));
        expect(split.tax >= 0n).toBe(true);
        // And never more tax than there is line: an inclusive split cannot make the
        // net negative, which is what a naive `gross / (1 - r)` would do.
        expect(split.net >= 0n).toBe(true);
        expect(split.tax <= split.gross).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });

  it('mirrors exactly, so a credit note cancels its invoice line for line', () => {
    fc.assert(
      fc.property(anyAmount, rate, mode, (amount, taxRate, taxMode) => {
        const forward = minor(splitTax(amount, taxRate, taxMode));
        const mirrored = minor(splitTax(negate(amount), taxRate, taxMode));
        expect(mirrored).toEqual({
          net: -forward.net,
          tax: -forward.tax,
          gross: -forward.gross,
        });
      }),
      { numRuns: RUNS },
    );
  });

  it('leaves a zero rate alone', () => {
    fc.assert(
      fc.property(anyAmount, mode, (amount, taxMode) => {
        const split = minor(splitTax(amount, taxRateFromUnits(0n), taxMode));
        expect(split.tax).toBe(0n);
        expect(split.net).toBe(split.gross);
      }),
      { numRuns: RUNS },
    );
  });
});

describe('a document totals to the sum of its rounded lines (D-35)', () => {
  /**
   * The rule itself. Three lines of $0.10 at 5%: each is half a cent of tax, each
   * rounds to 1, and the document's tax is 3 — while the same document's total
   * times the rate is 1.5, which rounds to 2. A customer adding the tax column gets
   * 3, so 3 is what the invoice must say.
   */
  it('adds up the way the customer adds up the page', () => {
    const five = taxRateFromPercentString('5');
    const document = computeDocument(
      [10n, 10n, 10n].map((cents) => line(fromMinorUnits(cents), five)),
      'exclusive',
    );

    expect(document.lines.map((split) => toMinorUnits(split.tax))).toEqual([1n, 1n, 1n]);
    expect(toMinorUnits(document.totals.tax)).toBe(3n);
    // The forbidden model, for contrast.
    expect(toMinorUnits(scale(fromMinorUnits(30n), exclusiveTaxRatio(five)))).toBe(2n);
  });

  it('sums the rounded lines exactly, in all three columns', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(anyAmount, rate, anyQuantity), { maxLength: 20 }),
        mode,
        (rows, taxMode) => {
          const document = computeDocument(
            rows.map(([unit, r, quantity]) => line(unit, r, quantity)),
            taxMode,
          );

          expect(toMinorUnits(document.totals.net)).toBe(
            toMinorUnits(sum(document.lines.map((split) => split.net))),
          );
          expect(toMinorUnits(document.totals.tax)).toBe(
            toMinorUnits(sum(document.lines.map((split) => split.tax))),
          );
          expect(toMinorUnits(document.totals.gross)).toBe(
            toMinorUnits(sum(document.lines.map((split) => split.gross))),
          );
          // The invariant survives aggregation without being re-derived.
          expect(toMinorUnits(document.totals.net) + toMinorUnits(document.totals.tax)).toBe(
            toMinorUnits(document.totals.gross),
          );
        },
      ),
      { numRuns: RUNS },
    );
  });

  /**
   * How far the sum of rounded lines may sit from the rate applied to the whole.
   *
   * Half a cent per line, and no less: each line's rounding is independent, so `n`
   * lines drift by up to `n/2`. That is the accepted cost of D-35's rule — the
   * alternative, allocating one rounded document tax across the lines with
   * `allocate`, removes the drift and makes a line's tax depend on the other lines
   * on the document, which is the defect the rule exists to prevent.
   *
   * Stated per line rather than per document because a per-document constant would
   * be false: with 20 lines the observed drift reaches several cents, and a test
   * asserting one cent would fail on real invoices rather than on a bug.
   */
  it('drifts from the rounded sum by at most half a cent per line', () => {
    fc.assert(
      fc.property(
        fc.array(positiveAmount, { minLength: 1, maxLength: 20 }),
        rate,
        (nets, taxRate) => {
          const document = computeDocument(
            nets.map((net) => line(net, taxRate)),
            'exclusive',
          );
          const roundedSum = scale(sum(nets), exclusiveTaxRatio(taxRate));

          const drift = toMinorUnits(document.totals.tax) - toMinorUnits(roundedSum);
          // Each line rounds by up to ½ and the rounded sum by up to ½ more, so the
          // bound is (n + 1)/2 — doubled here to stay in integers.
          const bound = BigInt(nets.length) + 1n;
          expect(drift * 2n <= bound && drift * -2n <= bound).toBe(true);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('totals an empty document to zero rather than failing', () => {
    const document = computeDocument([], 'inclusive');
    expect(minor(document.totals)).toEqual({ net: 0n, tax: 0n, gross: 0n });
    expect(document.lines).toEqual([]);
  });
});

describe('quantity', () => {
  it('parses and formats canonically', () => {
    expect(quantityToString(quantityFromString('1'))).toBe('1');
    expect(quantityToString(quantityFromString('0.2500'))).toBe('0.25');
    expect(quantityToString(quantityFromString('-3.5'))).toBe('-3.5');
    expect(quantityToString(quantityFromString('0'))).toBe('0');
    expect(quantityFromString('1')).toBe(ONE_QUANTITY);
  });

  it('refuses anything that is not a canonical quantity', () => {
    for (const text of ['', '01', '.5', '1.', '1.00001', '1e3', '+1', ' 1']) {
      expect(() => quantityFromString(text)).toThrow();
    }
  });

  it('round-trips every representable quantity', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }), (units) => {
        const quantity = quantityFromUnits(units);
        expect(quantityFromString(quantityToString(quantity))).toBe(quantity);
      }),
      { numRuns: RUNS },
    );
  });

  it('extends exactly when it can, and rounds once when it cannot', () => {
    expect(toMinorUnits(extendLine(quantityFromString('3'), fromMinorUnits(400n)))).toBe(1200n);
    expect(toMinorUnits(extendLine(quantityFromString('0.5'), fromMinorUnits(7n)))).toBe(4n);
    expect(toMinorUnits(extendLine(quantityFromString('0'), fromMinorUnits(999n)))).toBe(0n);
    expect(toMinorUnits(extendLine(quantityFromString('-2'), fromMinorUnits(150n)))).toBe(-300n);
  });

  it('extends a whole quantity without rounding at all', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -1000n, max: 1000n }),
        money(fc.bigInt({ min: -100_000n, max: 100_000n })),
        (whole, unit) => {
          const quantity = quantityFromUnits(whole * QUANTITY_SCALE);
          expect(toMinorUnits(extendLine(quantity, unit))).toBe(whole * toMinorUnits(unit));
        },
      ),
      { numRuns: RUNS },
    );
  });
});
