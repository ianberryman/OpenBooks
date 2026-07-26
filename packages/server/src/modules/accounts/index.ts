/**
 * The chart of accounts (OB-018; spec §2.1).
 *
 * Deliberately small. Templates and hierarchy are M2 (ROADMAP, "Explicitly out of
 * M1"); what is here is the CRUD the ledger kernel needs in order to reference an
 * account, plus the two removal rules an accounting system cannot be casual about.
 *
 * ## Surface
 *
 * | Operation                                | Permission        |
 * | ---------------------------------------- | ----------------- |
 * | `createAccount(input, ctx)`              | `accounts.write`  |
 * | `getAccount(id, ctx)`                    | `accounts.read`   |
 * | `listAccounts(query, ctx)`               | `accounts.read`   |
 * | `updateAccount(id, input, ctx)`          | `accounts.write`  |
 * | `deactivateAccount(id, ctx)`             | `accounts.write`  |
 * | `reactivateAccount(id, ctx)`             | `accounts.write`  |
 * | `deleteAccount(id, ctx)`                 | `accounts.write`  |
 *
 * `(input, ctx)` follows plugin-api's `PostingService`, and `ctx` is where the org
 * comes from — spec §4 forbids it as a loose parameter, so there is no signature
 * here into which another org's id could be passed. Nothing takes a transaction:
 * `src/db/transaction-scope.ts` propagates one ambiently, so
 * `withIdempotency(spec, () => createAccount(input, ctx))` joins the claim's
 * transaction without this module knowing a transaction exists.
 *
 * ## `normal_balance` is stored, never derived
 *
 * Migration `0002_ledger` stores it and deliberately does not constrain it against
 * `type`, because contra accounts are real: accumulated depreciation is an `asset`
 * with a `credit` normal balance, as is an allowance for doubtful accounts. This
 * module adds no constraint of its own, and no default either — see
 * `createAccountRequestSchema` for why guessing it would be wrong exactly where it
 * matters.
 *
 * ## Two decisions worth reading before changing anything here
 *
 * **Hard deletion is allowed, for an account with no postings only.** The argument
 * is on `deleteAccount`: an account is configuration rather than a record of what
 * happened, so deleting an unreferenced one restates nothing, while refusing would
 * leave a mistyped code occupying that code permanently (`uq_accounts_org_code`
 * covers inactive rows too). Safety rests on `ON DELETE RESTRICT`, not on the
 * service's check.
 *
 * **`parent_account_id` is not in the API.** The column ships in M1 so that M2 does
 * not have to `ALTER` a table holding every customer's chart, but hierarchy is a
 * set of rules that do not exist yet, and accepting the field now would persist
 * data whose meaning is decided later. The request schemas are `strictObject`s, so
 * sending it is a `validation_failed` naming the field rather than a silent drop —
 * see the decision block in `packages/shared-types/src/accounts/accounts.ts`.
 *
 * A note for whoever implements the M2 hierarchy: the composite foreign key
 * `(org_id, parent_account_id) → accounts (org_id, id)` already makes a cross-org
 * parent unrepresentable, so no application check is needed for *integrity*. One is
 * still needed for the error surface — resolve the parent through `tenantDb` and
 * `assertFound` first, or another org's account id arrives as errno 1452 and
 * becomes a 500 instead of the 404 that A7 requires. Cycles are a separate problem
 * and the schema says nothing about them: a self-referencing foreign key permits
 * `a → b → a`, so that check has to be written.
 */

export type {
  Account,
  AccountList,
  AccountType,
  CreateAccountRequest,
  ListAccountsQuery,
  NormalBalance,
  UpdateAccountRequest,
} from '@openbooks/shared-types';

export {
  createAccount,
  deactivateAccount,
  deleteAccount,
  getAccount,
  listAccounts,
  reactivateAccount,
  updateAccount,
} from './accounts.service';
