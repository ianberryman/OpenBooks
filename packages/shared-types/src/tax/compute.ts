/**
 * The document arithmetic every AR and AP service shares (ROADMAP D-35; C5).
 *
 * Five services fan out in M3 wave 1 and four of them price a document line. This
 * file exists so that they compute it once rather than three times: `allocate.ts`
 * next door was written for the same reason and for the neighbouring problem, and
 * its register applies here — the guarantees are stated, the tests assert them, and
 * the rounding is deliberate rather than incidental.
 *
 * ## The two rounding points, and why there are exactly two
 *
 * A line is a quantity, a unit price, and at most one tax rate (D-35). Getting from
 * those to the three numbers that print on the page — net, tax, gross — crosses a
 * fraction twice, and each crossing is one application of `scale`:
 *
 * 1. **Extension.** `quantity × unitAmount` is rounded to whole minor units. A
 *    quantity carries four decimals, so 0.3333 hours at $150.00 is exact in neither
 *    direction and something has to decide the cent.
 * 2. **Tax.** The rate is applied to that rounded extension, once, and the third
 *    number is derived by addition or subtraction rather than by a second rounding.
 *
 * Tax is taken from the *rounded* extension and not from the exact product, and
 * that is the choice that makes an invoice verifiable: the net is what posts to the
 * revenue account, the tax is what posts to the tax liability account, and the gross
 * is what the customer is asked to pay. Computing tax from an unrounded intermediate
 * would give a page whose own three columns do not add up, which is the defect D-35
 * exists to prevent.
 *
 * ## The document total is the sum of rounded lines, never the rounded sum
 *
 * D-35 states the rule; here is the measurement that shows it is not pedantry.
 * Three lines of $0.10 at 5%: each line's tax is 0.5 cents, rounds half-up to 1, and
 * the document's tax is 3. Rounding the sum instead gives 30 × 5% = 1.5 → 2. The
 * customer who adds the tax column gets 3 and the invoice claims 2, and no amount of
 * explanation makes that an acceptable invoice.
 *
 * The cost, stated because it is the honest half: per-line rounding drifts from the
 * exact rational tax by up to half a cent per line, so a fifty-line document can sit
 * a quarter of a dollar away from "the total times the rate". That drift is the
 * price of a page that adds up, and it is why `allocate` is *not* used here —
 * allocating one rounded document tax across lines would remove the drift and
 * reintroduce the defect above, because a line's tax would then depend on the other
 * lines on the document.
 *
 * ## No rounding-mode parameter
 *
 * `scale` takes one and this file does not pass it. Two services choosing different
 * modes is precisely the divergence this module exists to prevent, and half-up is
 * the mode tax authorities specify (see `DEFAULT_ROUNDING_MODE`). A regime that
 * needs half-even needs it per rate, stored with the rate, and that is a change to
 * the rate rather than an argument at each call site.
 */

import type { Money } from '../money';
import { MoneyParseError, ZERO, add, ratio, scale, subtract, sum } from '../money';

import type { TaxRate } from './rate';
import { exclusiveTaxRatio, inclusiveTaxRatio } from './rate';

declare const quantityBrand: unique symbol;

/**
 * A line quantity, in ten-thousandths of a unit.
 *
 * Four decimals rather than none, because "3 hours" and "0.25 hours" are the same
 * field on the same form, and rather than more, because a quantity with more
 * precision than the price it multiplies is precision nobody entered. Branded, and
 * an integer count for the reason a rate is: `0.1` is not 0.1 in a double, and a
 * quantity is multiplied by money.
 */
export type Quantity = bigint & { readonly [quantityBrand]: 'Quantity' };

export const QUANTITY_DECIMALS = 4;

export const QUANTITY_SCALE = 10_000n;

export const ONE_QUANTITY = QUANTITY_SCALE as Quantity;

/**
 * Signed, because a negative line is how a discount or a returned item is written
 * on an otherwise positive document. Whether a *document* may total negative is a
 * service question with a different answer — a negative invoice is a credit note
 * (D-39) — and not one a quantity can answer.
 */
const QUANTITY_PATTERN = /^(-)?(0|[1-9][0-9]*)(?:\.([0-9]{1,4}))?$/;

export function quantityFromUnits(units: bigint): Quantity {
  return units as Quantity;
}

/** Parses the wire form, `"1"`, `"0.25"`, `"-3.5"`, exactly and without `Number`. */
export function quantityFromString(text: string): Quantity {
  const match = QUANTITY_PATTERN.exec(text);
  if (!match) {
    throw new MoneyParseError(
      `Expected a quantity with at most ${String(QUANTITY_DECIMALS)} fraction digits, received ` +
        `${JSON.stringify(text)}.`,
    );
  }

  const [, sign, whole = '0', fraction = ''] = match;
  const magnitude =
    BigInt(whole) * QUANTITY_SCALE + BigInt(fraction.padEnd(QUANTITY_DECIMALS, '0'));

  return quantityFromUnits(sign === '-' ? -magnitude : magnitude);
}

/** The canonical wire form: no trailing zeros, so a quantity has one spelling. */
export function quantityToString(quantity: Quantity): string {
  // Widened first, as `toDecimalString` does: negating the branded type trips
  // `no-unsafe-unary-minus`, which cannot see that a branded intersection over
  // `bigint` is still a `bigint`.
  const units = quantityUnits(quantity);
  const negative = units < 0n;
  const magnitude = negative ? -units : units;
  const whole = magnitude / QUANTITY_SCALE;
  const fraction = (magnitude % QUANTITY_SCALE)
    .toString()
    .padStart(QUANTITY_DECIMALS, '0')
    .replace(/0+$/, '');

  const digits = fraction === '' ? whole.toString() : `${whole.toString()}.${fraction}`;
  return negative ? `-${digits}` : digits;
}

export function quantityUnits(quantity: Quantity): bigint {
  return quantity;
}

/**
 * Whether a document's unit prices already include tax (D-35).
 *
 * This is the field that decides what `unitAmount` *means*, which is why every
 * document declares it and no line does: a document whose lines disagreed about
 * whether the prices include tax is a document nobody can total, and letting a line
 * override it would make that expressible.
 */
export const TAX_MODES = ['exclusive', 'inclusive'] as const;

export type TaxMode = (typeof TAX_MODES)[number];

/**
 * The three numbers a line or a document prints. `net + tax === gross` always —
 * exactly, for every input, because whichever of net and gross was computed, the
 * other is derived from it by addition or subtraction and never by a second
 * rounding.
 */
export interface TaxSplit {
  /** What posts to the income or expense account. */
  readonly net: Money;
  /** What posts to the rate's tax liability account. */
  readonly tax: Money;
  /** What the counterparty is asked to pay. `net + tax`. */
  readonly gross: Money;
}

/**
 * The exclusive path: an amount that does not yet include tax, plus its tax.
 *
 * One rounding, on the tax. Negative amounts mirror exactly — `addTax(negate(a))`
 * is `addTax(a)` negated in all three fields — because `scale`'s modes are
 * symmetric about zero, which is what makes a credit note the exact mirror of the
 * invoice it credits (D-39) and a void the exact mirror of its document (D-38).
 */
export function addTax(net: Money, rate: TaxRate): TaxSplit {
  const tax = scale(net, exclusiveTaxRatio(rate));
  return { net, tax, gross: add(net, tax) };
}

/**
 * The inclusive path: an amount that already includes tax, split back apart.
 *
 * One rounding, on the tax, using `rate / (1 + rate)` — see `inclusiveTaxRatio` for
 * why that is one multiplication rather than a division and a subtraction. The net
 * is `gross − tax`, so the gross the user typed is preserved to the cent: an
 * inclusive invoice always totals to the number on the price list, which is the
 * entire reason someone enters prices that way.
 */
export function extractTax(gross: Money, rate: TaxRate): TaxSplit {
  const tax = scale(gross, inclusiveTaxRatio(rate));
  return { net: subtract(gross, tax), tax, gross };
}

/**
 * Applies whichever path the document declared. This is the dispatch C5 turns on:
 * both modes reach the same two functions, so "identical journals" is a property of
 * eleven lines of arithmetic rather than of two independently written services.
 */
export function splitTax(amount: Money, rate: TaxRate, mode: TaxMode): TaxSplit {
  return mode === 'inclusive' ? extractTax(amount, rate) : addTax(amount, rate);
}

/** The pricing inputs of one line. `rate` is the line's single rate (D-35). */
export interface TaxableLine {
  readonly quantity: Quantity;
  readonly unitAmount: Money;
  readonly rate: TaxRate;
}

/**
 * `quantity × unitAmount`, rounded once (rounding point 1 of the two named above).
 *
 * Exported because the extension is a number the client shows before any tax
 * exists, and because a service that needs it should not re-derive the scaling.
 */
export function extendLine(quantity: Quantity, unitAmount: Money): Money {
  return scale(unitAmount, ratio(quantityUnits(quantity), QUANTITY_SCALE));
}

/**
 * One line, priced end to end.
 *
 * In `exclusive` mode the extension is the net and tax is added; in `inclusive`
 * mode the extension is the gross and tax is extracted. Nothing else differs, which
 * is what C5 depends on.
 */
export function computeLine(line: TaxableLine, mode: TaxMode): TaxSplit {
  return splitTax(extendLine(line.quantity, line.unitAmount), line.rate, mode);
}

/** Per-line splits, and the document totals that are their sums. */
export interface DocumentTotals {
  readonly lines: readonly TaxSplit[];
  readonly totals: TaxSplit;
}

/**
 * Prices a document: every line, then the totals as the sums of the rounded lines.
 *
 * The three sums are taken independently and the result still satisfies
 * `net + tax === gross`, because summation is exact — the invariant survives
 * aggregation without anything having to re-derive it.
 *
 * An empty document totals to zero rather than failing, so a draft with no lines is
 * an ordinary case and not a special one (`sum` is `ZERO` over nothing).
 */
export function computeDocument(lines: readonly TaxableLine[], mode: TaxMode): DocumentTotals {
  const computed = lines.map((line) => computeLine(line, mode));

  return {
    lines: computed,
    totals: {
      net: sum(computed.map((line) => line.net)),
      tax: sum(computed.map((line) => line.tax)),
      gross: sum(computed.map((line) => line.gross)),
    },
  };
}

/** The zero split, for a document with nothing on it. */
export const ZERO_SPLIT: TaxSplit = { net: ZERO, tax: ZERO, gross: ZERO };
