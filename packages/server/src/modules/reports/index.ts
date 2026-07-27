/**
 * The report core (OB-041; spec §2.6, acceptance B2, B4, B6, B7).
 *
 * One aggregation over `journal_lines` that the profit and loss (OB-042), the
 * balance sheet (OB-043) and the general ledger (OB-044) are thin projections of.
 * It is not itself a report and it has no route — transport is OB-045.
 *
 * ## Surface
 *
 * | Operation                          | Permission    |
 * | ---------------------------------- | ------------- |
 * | `getAccountBalances(query, ctx)`   | `reports.read` |
 *
 * `(query, ctx)` with the org taken from the context, like every other service:
 * spec §4 forbids an org as a loose parameter, so there is no signature here into
 * which another org's id could be passed. Nothing takes a transaction —
 * `src/db/transaction-scope.ts` propagates one ambiently.
 *
 * ## What it returns, and why it is shaped like that
 *
 * Per account, three amounts rather than one:
 *
 *  - **opening** — postings strictly before `from`.
 *  - **movement** — postings inside `[from, to]`, both bounds inclusive.
 *  - **closing** — opening + movement, i.e. everything up to and including `to`.
 *
 * That is one mechanism with three uses, which is the whole of this ticket. M1's
 * trial balance took a single `asOf` upper bound; a P&L needs "this period", a
 * balance sheet needs "as at", and a general ledger needs "between these dates,
 * and what the account already held". Once the range has a lower bound, all three
 * are the same query and the differences are which third of the decomposition the
 * report prints:
 *
 * ```ts
 * // OB-042 — a P&L for a quarter: movement, revenue and expense only.
 * getAccountBalances({ from: '2026-01-01', to: '2026-03-31', types: ['revenue', 'expense'] }, ctx)
 *
 * // OB-043 — a balance sheet as at a date, with the fiscal year as the range.
 * // `closing` is the balance-sheet figure; `movement` on the revenue and expense
 * // accounts of that same call is the current-year earnings D-20 requires to be
 * // derived rather than closed into an account. One call answers both, so the
 * // derivation never has to reach around this module for a second range.
 * getAccountBalances({ from: '2026-01-01', to: '2026-03-31' }, ctx)
 *
 * // OB-044 — a general ledger range: `opening` is the brought-forward balance the
 * // entries run on from, and `opening + movement = closing` is acceptance B4.
 * getAccountBalances({ from, to, dimensions, contactId }, ctx)
 * ```
 *
 * Omitting `from` means the ledger's beginning, so `opening` is zero and `closing`
 * is the cumulative balance — which is exactly what `asOf` meant, and is how the
 * trial balance is reproduced through this core.
 *
 * ## Grouping, and the bucket that is not optional
 *
 * `groupBy` names one dimension axis. The result is a bucket per value the window
 * contains **plus an unassigned bucket that is always present**, and every bucket
 * carries a row for every account in the chart. Acceptance B6 is that the buckets
 * summed — including the unassigned one — equal the same report ungrouped, and
 * D-18 is explicit about why the unassigned bucket cannot be dropped: a slice view
 * that silently omits untagged lines shows a smaller business than exists, and it
 * does it most on the accounts nobody remembered to tag.
 *
 * Filters and grouping treat `journal_line_dimensions` differently, and the
 * difference is the cost D-18 accepted: a filter is an `EXISTS` semi-join, which
 * cannot multiply a line by the number of axes it carries, while grouping is a
 * single `LEFT JOIN` pinned to one axis, which cannot either. The argument is at
 * the top of `balances.repository.ts`.
 *
 * ## Subtotals
 *
 * Each bucket also comes as a forest over `parent_account_id`, every node carrying
 * its own row and the subtotal of its subtree (B7). A parent may hold postings of
 * its own, so the two are separate numbers and a report that printed the subtotal
 * against the parent's own name would double-count. See `tree.ts`.
 *
 * ## What it deliberately does not do
 *
 * No balance cache and no denormalized totals (spec §2.6) — correctness first, and
 * the trial balance stays the oracle every property in OB-053 checks against.
 * `test/properties/report-trial-balance.test.ts` already checks it here, by
 * deriving a trial balance through this core and asserting it equals
 * `getTrialBalance` exactly over generated ledgers.
 *
 * No drafts, ever. A draft has not happened (D-19), so nothing in this module
 * names `journal_drafts`.
 *
 * No presentation. Whether a revenue account prints as a positive number, which
 * accounts a statement shows, and how a subtotal is labelled are decisions
 * belonging to the report that makes them — and the sign convention in particular
 * is one every projection needs to state for itself, since `balance` here is
 * always `debits - credits` and never flipped to an account's normal side.
 */

export type { AccountBalance, BalanceAmounts } from './amounts';
export {
  addAccountBalance,
  addAmounts,
  amountsOf,
  balanceOf,
  isZeroBalance,
  sumAccountBalances,
  ZERO_ACCOUNT_BALANCE,
  ZERO_AMOUNTS,
} from './amounts';

export type {
  AccountBalances,
  AccountBalancesQuery,
  ReportGroup,
  ReportGroupKey,
  ReportRange,
} from './balances.service';
export { getAccountBalances } from './balances.service';

export type { AccountBalanceNode, AccountBalanceRow } from './tree';
export { buildAccountTree } from './tree';

export { REPORT_FILTER_VALUES_MAX } from '@openbooks/shared-types';
export type { ReportDimensionFilter } from '@openbooks/shared-types';
export {
  accountBalancesQuerySchema,
  reportDimensionFilterSchema,
  reportRangeShape,
  reportSliceShape,
} from '@openbooks/shared-types';
