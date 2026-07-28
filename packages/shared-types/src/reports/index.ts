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

/**
 * The bucket key every grouped report shares (OB-045). Read `groups.ts` for why it
 * is one component rather than the three identical copies OB-042, OB-043 and
 * OB-044 each declared.
 */
export type { ReportGroupKey } from './groups';
export { reportGroupKeySchema, reportGroupKeyShape } from './groups';

/**
 * The balance sheet (OB-043). Read `balance-sheet.ts` for why every amount is
 * already signed for the side it prints on, and for why the two derived earnings
 * lines are separate from the equity accounts (D-20).
 */
export { BALANCE_SHEET_ACCOUNT_TYPES } from './balance-sheet';
export type {
  BalanceSheet,
  BalanceSheetAccountType,
  BalanceSheetGroup,
  BalanceSheetQueryParams,
  BalanceSheetRow,
  BalanceSheetSection,
  BalanceSheetTotals,
} from './balance-sheet';
export {
  balanceSheetFiscalYearSchema,
  balanceSheetGroupSchema,
  balanceSheetQuerySchema,
  balanceSheetRowSchema,
  balanceSheetSchema,
  balanceSheetSectionSchema,
  balanceSheetTotalsSchema,
} from './balance-sheet';

/**
 * The profit and loss (OB-042, B2). Read `profit-and-loss.ts` for the sign
 * convention — amounts are signed to their section rather than left as
 * `debits - credits` — and for why every account of the type appears even at zero.
 */
export { PROFIT_AND_LOSS_ACCOUNT_TYPES, REPORT_BASES } from './profit-and-loss';
export type {
  ProfitAndLossAccountType,
  ProfitAndLossQueryParams,
  ReportBasis,
  ReportReviewFlag,
} from './profit-and-loss';
export {
  profitAndLossGroupSchema,
  profitAndLossQuerySchema,
  profitAndLossRowSchema,
  profitAndLossSchema,
  profitAndLossSectionSchema,
  profitAndLossTotalsSchema,
  reportBasisSchema,
  reviewFlagSchema,
} from './profit-and-loss';

/**
 * The general ledger (OB-044). Read `general-ledger.ts` for what "the other side"
 * means on a journal with more than two lines, and for why the three balances ride
 * on every page rather than only on the first.
 */
export { GL_COUNTERPARTY_ACCOUNTS_MAX } from './general-ledger';
export type {
  GeneralLedger,
  GeneralLedgerEntry,
  GeneralLedgerQueryInput,
  GeneralLedgerQueryParams,
} from './general-ledger';
export {
  generalLedgerCounterpartySchema,
  generalLedgerEntrySchema,
  generalLedgerQuerySchema,
  generalLedgerSchema,
  generalLedgerTagSchema,
} from './general-ledger';

/**
 * The Statement of Cash Flows, indirect method (OB-157; D-88). Read `cash-flow.ts`
 * for why it reports one honest reconciling line rather than a fabricated
 * operating/investing/financing split, and for which accounts count as cash.
 */
export type { StatementOfCashFlows, StatementOfCashFlowsQueryParams } from './cash-flow';
export { statementOfCashFlowsQuerySchema, statementOfCashFlowsSchema } from './cash-flow';

/**
 * The forward cash-flow projection (OB-158, K6). Read `cash-flow-projection.ts`
 * for why `asOf` defaults to today rather than being required the way aging's is,
 * for why overdue amounts land in the earliest bucket instead of being excluded,
 * and for why `includesRecurringCommitments` is always `false` today.
 */
export {
  CASH_FLOW_BUCKET_GRANULARITIES,
  CASH_FLOW_PROJECTION_GRANULARITY_DEFAULT,
  CASH_FLOW_PROJECTION_HORIZON_DEFAULT,
  CASH_FLOW_PROJECTION_HORIZON_MAX,
} from './cash-flow-projection';
export type {
  CashFlowBucketGranularity,
  CashFlowProjection,
  CashFlowProjectionBucket,
  CashFlowProjectionQueryParams,
} from './cash-flow-projection';
export {
  cashFlowBucketGranularitySchema,
  cashFlowProjectionBucketSchema,
  cashFlowProjectionQuerySchema,
  cashFlowProjectionSchema,
} from './cash-flow-projection';
