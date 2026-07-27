/**
 * Tax: the rate primitive, the document arithmetic, and the rate list's wire
 * contract (OB-061; ROADMAP D-35).
 *
 * Read `rate.ts` for why a rate is parts per million rather than basis points —
 * 8.875% is the case that decides it — and `compute.ts` for the two rounding
 * points, why a document totals to the sum of its rounded lines, and what C5's
 * "identical journals" does and does not cover.
 */

export type { TaxRate } from './rate';
export {
  MAX_TAX_RATE_UNITS,
  TAX_RATE_DENOMINATOR,
  TAX_RATE_PERCENT_DECIMALS,
  TAX_RATE_UNITS_PER_PERCENT,
  ZERO_TAX_RATE,
  exclusiveTaxRatio,
  inclusiveTaxRatio,
  isZeroTaxRate,
  taxRateFromPercentString,
  taxRateFromUnits,
  taxRateToPercentString,
  taxRateUnits,
} from './rate';

export type { DocumentTotals, Quantity, TaxMode, TaxSplit, TaxableLine } from './compute';
export {
  ONE_QUANTITY,
  QUANTITY_DECIMALS,
  QUANTITY_SCALE,
  TAX_MODES,
  ZERO_SPLIT,
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

export {
  TAX_RATE_APPLICABILITIES,
  TAX_RATE_NAME_MAX_LENGTH,
  TAX_RATE_PERCENT_WIRE_PATTERN,
} from './tax';
export type {
  CreateTaxRateRequest,
  ListTaxRatesQuery,
  TaxRateApplicability,
  TaxRatePage,
  TaxRateResponse,
  UpdateTaxRateRequest,
} from './tax';
export {
  createTaxRateRequestSchema,
  listTaxRatesQuerySchema,
  taxPercentageSchema,
  taxRatePageSchema,
  taxRateSchema,
  updateTaxRateRequestSchema,
} from './tax';
