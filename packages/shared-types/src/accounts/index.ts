/**
 * The chart-of-accounts wire contract (OB-018, OB-035, OB-039, D-27).
 *
 * Read `accounts.ts` for why `normalBalance` is a required field rather than a
 * default derived from `type`, for why `code` is absent from the update schema,
 * and for the four hierarchy rules that `parentAccountId` carries but no schema
 * can state. `chart-templates.ts` carries the identity of a starter chart and
 * deliberately not its contents (D-23).
 */

export type {
  Account,
  AccountPage,
  AccountType,
  CashBasisRole,
  CreateAccountRequest,
  ListAccountsQuery,
  NormalBalance,
  UpdateAccountRequest,
} from './accounts';
export {
  ACCOUNT_CODE_MAX_LENGTH,
  ACCOUNT_DESCRIPTION_MAX_LENGTH,
  ACCOUNT_MAX_DEPTH,
  ACCOUNT_NAME_MAX_LENGTH,
  ACCOUNT_TYPES,
  CASH_BASIS_ROLES,
  NORMAL_BALANCES,
  accountCashBasisRoleSchema,
  accountPageSchema,
  accountSchema,
  createAccountRequestSchema,
  listAccountsQuerySchema,
  updateAccountRequestSchema,
} from './accounts';
export type {
  AppliedChartTemplate,
  ApplyChartTemplateRequest,
  ChartTemplateId,
  ChartTemplateList,
  ChartTemplateSummary,
} from './chart-templates';
export {
  CHART_TEMPLATE_IDS,
  appliedChartTemplateSchema,
  applyChartTemplateRequestSchema,
  chartTemplateListSchema,
  chartTemplateSummarySchema,
} from './chart-templates';
