/**
 * The report core (OB-041; spec §2.6, acceptance B2, B4, B6, B7).
 *
 * One aggregation over `journal_lines` that the profit and loss (OB-042), the
 * balance sheet (OB-043) and the general ledger (OB-044) are thin projections of.
 * It is not itself a report and it has no route — transport is OB-045.
 *
 * ## Surface
 *
 * | Operation                                   | Permission     |
 * | ------------------------------------------- | -------------- |
 * | `getAccountBalances(query, ctx, options?)`  | `reports.read` |
 *
 * `(query, ctx)` with the org taken from the context, like every other service:
 * spec §4 forbids an org as a loose parameter, so there is no signature here into
 * which another org's id could be passed. Nothing takes a transaction —
 * `src/db/transaction-scope.ts` propagates one ambiently.
 *
 * The third parameter is the module's own, not a client's: `query` is parsed from
 * a schema published in `shared-types`, and a narrowing no client needs does not
 * belong in a schema every client reads. `AccountBalancesOptions` in
 * `balances.service.ts` carries the argument and the cost.
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
 * // One account, so the aggregation reads one account rather than a whole type.
 * getAccountBalances({ from, to, dimensions, contactId }, ctx, { accountIds: [accountId] })
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
  AccountBalancesOptions,
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

/**
 * The profit and loss (OB-042). A projection over `getAccountBalances`, with no
 * query of its own — read `profit-and-loss.service.ts` for the sign convention,
 * for why it reads `movement` rather than `closing`, and for why M2 ships no
 * comparative period.
 */
export type {
  ProfitAndLoss,
  ProfitAndLossGroup,
  ProfitAndLossQuery,
  ProfitAndLossRow,
  ProfitAndLossSection,
  ProfitAndLossTotals,
} from './profit-and-loss.service';
export { getProfitAndLoss } from './profit-and-loss.service';

export { PROFIT_AND_LOSS_ACCOUNT_TYPES, profitAndLossQuerySchema } from '@openbooks/shared-types';
export type { ProfitAndLossAccountType } from '@openbooks/shared-types';

/**
 * The general ledger and the drill-down (OB-044; B4, B6). The three balances come
 * from `getAccountBalances`; the entries are a keyset-paged list of the lines that
 * moved the account. Read `general-ledger.service.ts` for how a running balance
 * survives paging and for what a client sees when a back-dated entry lands between
 * two page fetches — and `shared-types`' `general-ledger.ts` for what "the other
 * side" means on a journal with more than two lines.
 */
export type { GeneralLedgerQuery } from './general-ledger.service';
export { getGeneralLedger } from './general-ledger.service';

export { GL_COUNTERPARTY_ACCOUNTS_MAX, generalLedgerQuerySchema } from '@openbooks/shared-types';
export type { GeneralLedger, GeneralLedgerEntry } from '@openbooks/shared-types';

/**
 * The balance sheet (OB-043; B2, B3, B6, B7). A projection over
 * `getAccountBalances` reading `closing` for the accounts it prints — and, on the
 * revenue and expense rows of the same call, `opening` and `movement` for the two
 * derived equity lines D-20 requires in place of a year-end closing journal. Read
 * `balance-sheet.service.ts` for why the derivation is split at the fiscal-year
 * boundary, and for the rule that becomes wrong the day a close is built.
 */
export type {
  BalanceSheet,
  BalanceSheetFiscalYear,
  BalanceSheetGroup,
  BalanceSheetQuery,
  BalanceSheetRow,
  BalanceSheetSection,
  BalanceSheetTotals,
} from './balance-sheet.service';
export { getBalanceSheet } from './balance-sheet.service';

export { BALANCE_SHEET_ACCOUNT_TYPES, balanceSheetQuerySchema } from '@openbooks/shared-types';
export type { BalanceSheetAccountType } from '@openbooks/shared-types';

/**
 * The Statement of Cash Flows, indirect method (OB-157; D-88). A projection over two
 * calls to the core — the P&L for net income, `getAccountBalances` again for the
 * cash accounts' movement — read `cash-flow.service.ts` for why the reconciliation
 * is a single honest plug rather than a fabricated operating/investing/financing
 * split.
 */
export type {
  StatementOfCashFlows,
  StatementOfCashFlowsQuery,
  StatementOfCashFlowsRange,
} from './cash-flow.service';
export { getStatementOfCashFlows } from './cash-flow.service';

export { statementOfCashFlowsQuerySchema } from '@openbooks/shared-types';

/**
 * The forward cash-flow projection (OB-158, K6). Not a projection over
 * `getAccountBalances` the way the three reports above are — opening cash is the
 * one figure it borrows from the core; the AR/AP reads underneath it are
 * `aging.repository.ts`'s, restricted to invoices and bills and bucketed by due
 * date rather than by days overdue. Read `cash-flow-projection.service.ts` for why
 * overdue amounts land in the earliest bucket instead of being excluded, and why
 * `includesRecurringCommitments` is always `false` today.
 */
export type { CashFlowProjectionQuery } from './cash-flow-projection.service';
export { getCashFlowProjection } from './cash-flow-projection.service';

export {
  CASH_FLOW_BUCKET_GRANULARITIES,
  cashFlowProjectionQuerySchema,
} from '@openbooks/shared-types';
export type { CashFlowBucketGranularity } from '@openbooks/shared-types';

/**
 * Budget vs actual (OB-182; D-N1…D-N6). A projection over `getAccountBalances`,
 * shaped like the P&L — read `budget-vs-actual.service.ts` for why the period is
 * read directly off `fiscal_periods` rather than through `periods.read`, and for
 * how a stored budget's own signed amount is bucketed to match the actuals side's
 * grouping.
 */
export { getBudgetVsActual } from './budget-vs-actual.service';

/**
 * The audit trail (OB-196; D-98). Not a projection over `getAccountBalances` the
 * way the reports above are — it reads `journals` and `period_close_events`
 * directly and merges them into one newest-first timeline. Read
 * `audit.service.ts` for why it gates on `audit.read` rather than `reports.read`,
 * and `audit.repository.ts` for why its keyset cursor is its own rather than
 * `db/keyset.ts`'s (that helper only ever orders ascending).
 */
export { getAuditReport } from './audit.service';

export { AUDIT_ENTRY_KINDS, auditReportQuerySchema } from '@openbooks/shared-types';
export type {
  AuditActor,
  AuditEntry,
  AuditEntryKind,
  AuditReport,
  AuditReportQueryInput,
  AuditReportQueryParams,
} from '@openbooks/shared-types';
