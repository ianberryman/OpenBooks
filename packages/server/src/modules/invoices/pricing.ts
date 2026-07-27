import type { DocumentTotals, Money, Quantity, TaxMode, TaxRate } from '@openbooks/shared-types';
import {
  computeDocument,
  quantityFromUnits,
  quantityUnits,
  taxRateFromUnits,
} from '@openbooks/shared-types';
import { fromMinorUnits, toMinorUnits } from '@openbooks/shared-types/money';

/**
 * Pricing a document line, which is entirely `shared-types/tax/compute.ts`'s job.
 *
 * There is no arithmetic in this file. D-35 gives the system exactly two rounding
 * points — the line extension and the line's tax — and OB-061 implemented both once,
 * so a second implementation here would be a second answer to "what does this
 * invoice come to", and C5 ("inclusive and exclusive entry post identical journals")
 * would be a claim about two services agreeing rather than about eleven lines of
 * arithmetic. What is here is the *conversions* between what the tables hold and
 * what those functions take, and each one exists because the two disagree about a
 * scale or a type.
 */

/**
 * `ar_document_lines.quantity_micros` is a quantity scaled by 1,000,000 and a
 * `Quantity` is one scaled by 10,000 (`QUANTITY_SCALE`), so the two differ by a
 * factor of a hundred.
 *
 * The column is the wider of the two and the wire contract is the narrower:
 * `quantitySchema` refuses a fifth fraction digit, so nothing this service writes
 * can carry a value the conversion back would lose. Stated as a constant with the
 * inequality written down because the failure of getting it wrong is a quantity
 * that reads back a hundred times too large, which is not a rounding error and is
 * not visible in a total that was computed before the round trip.
 */
const MICROS_PER_QUANTITY_UNIT = 100n;

export function quantityToMicros(quantity: Quantity): bigint {
  return quantityUnits(quantity) * MICROS_PER_QUANTITY_UNIT;
}

/**
 * The inverse, truncating.
 *
 * Truncation is unreachable through this service — every value it writes is a
 * multiple of a hundred micros — and it is truncation rather than a throw because
 * the only way to reach a non-multiple is a row written by something else, and a
 * document that cannot be *read* is worse than one whose sixth decimal place is not
 * shown.
 */
export function quantityFromMicros(micros: bigint): Quantity {
  return quantityFromUnits(micros / MICROS_PER_QUANTITY_UNIT);
}

/**
 * `tax_rates.rate_ppm` as the branded rate.
 *
 * The column is `INT UNSIGNED` parts per million and `TaxRate` is a branded
 * `bigint` in the same unit, so this is a widening plus the bound check every
 * constructor funnels through — a rate above 100% is refused here rather than
 * silently multiplying an invoice by twenty.
 */
export function toTaxRate(ratePpm: number): TaxRate {
  return taxRateFromUnits(BigInt(ratePpm));
}

/** The zero rate an untaxed line is priced at: no rate is not a special case. */
export const NO_TAX_RATE: TaxRate = taxRateFromUnits(0n);

/** One line's pricing inputs, in the units the tax module takes. */
export interface PriceableLine {
  readonly quantity: Quantity;
  readonly unitAmount: Money;
  readonly rate: TaxRate;
}

/**
 * Every line priced and the document totalled, by the shared implementation.
 *
 * A pass-through, kept so that every call site in this module reaches the same
 * function with the same arguments: the totals are the sums of the *rounded* lines
 * and never the rate applied to a sum (D-35), and that property belongs to
 * `computeDocument` rather than to whoever adds up its results.
 */
export function priceDocument(lines: readonly PriceableLine[], mode: TaxMode): DocumentTotals {
  return computeDocument(lines, mode);
}

/** A stored amount column as `Money`. */
export function money(minorUnits: bigint): Money {
  return fromMinorUnits(minorUnits);
}

/** `Money` as the `BIGINT` the column takes. */
export function minor(value: Money): bigint {
  return toMinorUnits(value);
}
