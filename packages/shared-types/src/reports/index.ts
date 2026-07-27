/**
 * The trial balance wire contract (OB-023, A2). Read `reports.ts` for why the
 * difference is reported rather than asserted.
 */
export type { TrialBalanceQueryParams } from './reports';
export { trialBalanceQuerySchema, trialBalanceRowSchema, trialBalanceSchema } from './reports';

/**
 * The query every M2 report takes (OB-041). Read `balances.ts` for why the range
 * has two bounds where the trial balance has one, and for why the core publishes
 * a query and no response.
 */
export { REPORT_FILTER_VALUES_MAX } from './balances';
export type { AccountBalancesQueryParams, ReportDimensionFilter } from './balances';
export {
  accountBalancesQuerySchema,
  reportDimensionFilterSchema,
  reportRangeShape,
  reportSliceShape,
} from './balances';
