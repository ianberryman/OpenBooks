/**
 * Budgets (initiative N, OB-180…184; ROADMAP D-N1…D-N6; `/v1` routes OB-183).
 *
 * `budgets.ts` is the whole of it: the stored figure and its batch upsert, the list
 * filter, and the budget-vs-actual report — shaped like `ProfitAndLoss` so the web
 * report view reuses its section layout. Every response schema carries a
 * `.meta({ id })`; the two querystrings carry none, since a querystring is emitted
 * as individual parameters.
 */

export { SET_BUDGETS_MAX_ENTRIES } from './budgets';
export {
  budgetListSchema,
  budgetSchema,
  budgetVsActualGroupSchema,
  budgetVsActualQuerySchema,
  budgetVsActualRowSchema,
  budgetVsActualSchema,
  budgetVsActualSectionSchema,
  budgetVsActualTotalsSchema,
  listBudgetsQuerySchema,
  setBudgetEntrySchema,
  setBudgetsRequestSchema,
} from './budgets';
export type {
  Budget,
  BudgetList,
  BudgetVsActual,
  BudgetVsActualGroup,
  BudgetVsActualQueryParams,
  BudgetVsActualRow,
  BudgetVsActualSection,
  BudgetVsActualTotals,
  ListBudgetsQueryParams,
  SetBudgetEntry,
  SetBudgetsRequest,
} from './budgets';
