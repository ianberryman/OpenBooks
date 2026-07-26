/**
 * The fiscal-period wire contract (OB-023). Read `periods.ts` for why a period is
 * named by year and month rather than by a date range, and how these shapes are held
 * to the service's own.
 */
export type {
  CreateFiscalPeriodRequest,
  GenerateFiscalYearRequest,
  ListFiscalPeriodsQuery,
  PeriodStatusWire,
} from './periods';
export {
  createFiscalPeriodRequestSchema,
  fiscalPeriodListSchema,
  fiscalPeriodSchema,
  generateFiscalYearRequestSchema,
  generatedFiscalYearSchema,
  listFiscalPeriodsQuerySchema,
  PERIOD_STATUSES,
} from './periods';
