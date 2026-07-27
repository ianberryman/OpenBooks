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
  balanceSheetGroupKeySchema,
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
export { PROFIT_AND_LOSS_ACCOUNT_TYPES } from './profit-and-loss';
export type { ProfitAndLossAccountType, ProfitAndLossQueryParams } from './profit-and-loss';
export {
  profitAndLossGroupKeySchema,
  profitAndLossGroupSchema,
  profitAndLossQuerySchema,
  profitAndLossRowSchema,
  profitAndLossSchema,
  profitAndLossSectionSchema,
  profitAndLossTotalsSchema,
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
