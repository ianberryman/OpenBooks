/**
 * The chart-of-accounts wire contract (OB-018, OB-035, D-27).
 *
 * Read `accounts.ts` for why `normalBalance` is a required field rather than a
 * default derived from `type`, for why `code` is absent from the update schema,
 * and for the four hierarchy rules that `parentAccountId` carries but no schema
 * can state.
 */

export type {
  Account,
  AccountPage,
  AccountType,
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
  NORMAL_BALANCES,
  accountPageSchema,
  accountSchema,
  createAccountRequestSchema,
  listAccountsQuerySchema,
  updateAccountRequestSchema,
} from './accounts';
