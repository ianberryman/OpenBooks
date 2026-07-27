/**
 * Per-org accounting settings (OB-066a).
 *
 * One setting so far, and it is the one M3 could not do without: which of the org's
 * own accounts is its receivables control account, and which is its payables one.
 *
 * ## Why this exists
 *
 * An approved invoice debits *the* receivables control account and an approved bill
 * credits *the* payables one. C2 — the subledger agreeing with the ledger — and C8
 * — the aging buckets tying to a balance — are statements about those two accounts
 * specifically, and nothing in the M3 schema or in OB-061's wire contracts named
 * them. Three services shipped resolving the account by the code the shipped chart
 * template uses (`1100`, `2010`) and refusing loudly otherwise, which is a
 * reasonable stopgap and an unusable permanent answer: [D-23](#d-23) makes chart
 * templates **opt-in and unenforced**, so an org that declined the template, or
 * renumbered its chart, has no `1100` and simply cannot invoice.
 *
 * A nomination is the smallest thing that closes that. The org names an account it
 * already has; nothing about the chart's numbering is load-bearing any more.
 *
 * ## Why a module of its own, rather than `modules/orgs` or `modules/accounts`
 *
 * The import graph decides it, and dependency-cruiser enforces the decision.
 * Whoever owns this must be reachable from four places — `modules/accounts`, so
 * applying a chart template can nominate what it has just created; and
 * `modules/invoices`, `modules/bills`, `modules/payments`, so approval can resolve
 * it — while importing none of them.
 *
 * `modules/orgs` cannot: it already imports `applyChartTemplate` from
 * `modules/accounts` for the starter chart, so an edge from `accounts` back to it
 * is a cycle, which `no-circular` fails the build on.
 *
 * `modules/accounts` could, and the reason not to is the one
 * `tax-rates.repository.ts` gives for restating `ACCOUNT_RESOURCE` rather than
 * importing it: an edge from `invoices` to `accounts` asserts in the graph that
 * invoicing is *built on* the chart of accounts module, which is not true and which
 * dependency-cruiser would then enforce as though it were. An edge to `settings`
 * asserts that invoicing needs an org setting, which is exactly what is true.
 *
 * The storage decision is argued where it is expressed, in `0005_subledger`: a
 * table with `org_id NOT NULL` rather than two columns on `orgs`, because a control
 * account is a *reference into tenant data* and the composite `(org_id, id)`
 * foreign key every such reference uses is inexpressible on a table that has no
 * `org_id`.
 *
 * ## What changing a nomination means
 *
 * It moves **future** postings and cannot restate a past one. A journal names its
 * accounts by id, and the app user holds no `UPDATE` on `journals` or
 * `journal_lines` (spec §12), so there is no code path that could rewrite history
 * and no grant that would permit one if there were.
 *
 * The consequence that does need saying: while documents posted to the previous
 * account are still outstanding, what the subledger owes is spread across two
 * accounts, and neither alone ties to the aging total. It reconverges as those
 * documents settle. So repointing a control account is a **setup act** — the answer
 * to "we nominated the wrong one" — and not a way to reorganize a chart that is
 * already in use, for which the answer is a journal moving the balance. That is
 * also why the write takes `orgs.write` rather than `accounts.write`: the role that
 * enters documents is not the role that decides the shape of the books.
 *
 * The operation is *not* refused when postings exist. Refusing would strand exactly
 * the org this module exists for — one that nominated the wrong account and has
 * already approved something — with no way to correct the setting at all.
 *
 * ## The refusals, in one place
 *
 * | token                                     | means                                          |
 * | ----------------------------------------- | ---------------------------------------------- |
 * | `receivable_control_account_not_set`      | nothing nominated; nominate one                |
 * | `payable_control_account_not_set`         | the mirror                                     |
 * | `receivable_control_account_unusable`     | nominated, then deactivated or retyped         |
 * | `payable_control_account_unusable`        | the mirror                                     |
 * | `receivable_control_account_wrong_type`   | nomination refused: not an asset account       |
 * | `payable_control_account_wrong_type`      | nomination refused: not a liability account    |
 * | `account_inactive`                        | nomination refused: shared with the tax service |
 *
 * Six tokens where there were three spellings of two facts (`ap_control_account_missing`
 * beside `payable_control_account_missing`, and a `receivable_control_account_missing`
 * meaning two different things depending on which module raised it). One function
 * raises all of them now, so a client branches on a name that means one thing.
 *
 * There are no routes: `/v1` for everything M3 adds is OB-067, and the OpenAPI diff
 * this module implies is `GET`/`PATCH` on the org's accounting settings carrying
 * `ControlAccounts` and `UpdateControlAccountsRequest` from
 * `shared-types/src/orgs/settings.ts`, which deliberately carry no
 * `.meta({ id })` until that route exists.
 */

export type { SubledgerSide } from './control-accounts';
export {
  getControlAccounts,
  nominateControlAccountsIfUnset,
  resolveControlAccount,
  updateControlAccounts,
} from './control-accounts';
