/**
 * Budgets (initiative N, OB-180…184; ROADMAP D-N1…D-N6).
 *
 * An org enters or imports budget figures by account, period and optional
 * dimension value (`setBudgets`, OB-181) — a plain upsert per `(account,
 * period, dimension-value)` slot that posts no journal (D-94). `listBudgets`
 * and `deleteBudget` round out the entry surface; the budget-vs-actual report
 * (OB-182) that compares these figures to ledger actuals lives in
 * `modules/reports`, projected over the same `getAccountBalances` the P&L reads.
 *
 * There are no routes here: `/v1` for this initiative is registered by
 * `transport/routes/budgets.ts`. What is exported below is the service surface
 * an HTTP handler, an MCP tool, or the workflow engine (spec §12) all reach
 * identically.
 */

export { deleteBudget, listBudgets, setBudgets } from './budgets.service';

export { BUDGET_RESOURCE } from './budgets.repository';
