/**
 * The chart of accounts (OB-018, OB-035, OB-039; spec §2.1).
 *
 * The CRUD the ledger kernel needs in order to reference an account, the two
 * removal rules an accounting system cannot be casual about, the hierarchy
 * `parent_account_id` had been holding a column for since M1 (OB-035), and the
 * opt-in starter charts (OB-039).
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
 * | `listChartTemplates(ctx)`                | `accounts.read`   |
 * | `applyChartTemplate(input, ctx)`         | `accounts.write`  |
 *
 * `listAccounts` returns one bounded page and an opaque cursor, not the whole
 * chart. It is keyset-paginated (D-21) over `(code, id)`, which OB-031 could not
 * use and D-27 made possible by fixing an account's code at creation — see
 * `ACCOUNT_KEYSET` in `accounts.repository.ts`.
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
 * ## Three decisions worth reading before changing anything here
 *
 * **Hard deletion is allowed, for an account with no postings and no children.**
 * The argument is on `deleteAccount`: an account is configuration rather than a
 * record of what happened, so deleting an unreferenced one restates nothing, while
 * refusing would leave a mistyped code occupying that code permanently
 * (`uq_accounts_org_code` covers inactive rows too). Safety rests on `ON DELETE
 * RESTRICT`, not on the service's check.
 *
 * **A code is immutable once created (D-27).** It is the reference other things
 * cite, and it is also the list's sort key — a keyset over a mutable column drops
 * rows silently. `code` is therefore absent from `updateAccountRequestSchema`,
 * which is a `strictObject`, so sending it is a `validation_failed` naming the
 * field. `name` and `description` stay mutable.
 *
 * **Hierarchy is three rules, and none of them is in the schema.** The composite
 * foreign key `(org_id, parent_account_id) → accounts (org_id, id)` makes a
 * cross-org parent unrepresentable, so nothing above the database does integrity
 * work — but it permits `a → b → a`, says nothing about depth, and says nothing
 * about type. Those live in `hierarchy.ts`, together with the reason the parent is
 * resolved through `tenantDb` and `assertFound` before any statement names it:
 * otherwise another org's id arrives as errno 1452 and becomes a 500 instead of
 * the 404 that A7 requires.
 *
 * **A starter chart is opt-in and is a copy (D-23).** `applyChartTemplate` writes
 * through `createAccount`, one account at a time, in one transaction — so the
 * hierarchy rules, the code-uniqueness conflict and the shared zod schema apply to
 * a shipped chart exactly as they apply to a hand-typed one, and there is no second
 * write path for a template to bypass. Nothing records which template an org used,
 * because a stored template id is the start of the upgrade path D-23 declines to
 * have. Applying to an org that already holds one of the codes refuses the whole
 * application and names every collision; the argument is on `applyChartTemplate`.
 *
 * One question the M1 note listed is deliberately still open: **deactivating a
 * parent does not deactivate its children.** Nothing here needs an answer — an
 * inactive account keeps its postings and its place in the tree — and the question
 * is really "what does a subtotal do with an inactive parent", which belongs with
 * the reports that compute one (OB-039, OB-043).
 */

export { ACCOUNT_MAX_DEPTH, CHART_TEMPLATE_IDS } from '@openbooks/shared-types';
export type {
  Account,
  AccountPage,
  AccountType,
  AppliedChartTemplate,
  ApplyChartTemplateRequest,
  ChartTemplateId,
  ChartTemplateSummary,
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

export type { ChartTemplate, ChartTemplateAccount } from './chart-templates';
export { CHART_TEMPLATES } from './chart-templates';
export { applyChartTemplate, listChartTemplates } from './chart-templates.service';
