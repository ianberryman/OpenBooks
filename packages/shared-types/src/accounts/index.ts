/**
 * The chart-of-accounts wire contract (OB-018).
 *
 * Read `accounts.ts` for why `normalBalance` is a required field rather than a
 * default derived from `type`, and for why no schema here mentions
 * `parentAccountId`.
 */

export type {
  Account,
  AccountList,
  AccountType,
  CreateAccountRequest,
  ListAccountsQuery,
  NormalBalance,
  UpdateAccountRequest,
} from './accounts';
export {
  ACCOUNT_CODE_MAX_LENGTH,
  ACCOUNT_DESCRIPTION_MAX_LENGTH,
  ACCOUNT_NAME_MAX_LENGTH,
  ACCOUNT_TYPES,
  NORMAL_BALANCES,
  accountListSchema,
  accountSchema,
  createAccountRequestSchema,
  listAccountsQuerySchema,
  updateAccountRequestSchema,
} from './accounts';
