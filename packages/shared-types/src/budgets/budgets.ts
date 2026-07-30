import { z } from 'zod';

import { MAX_DIMENSIONS_PER_ORG } from '../dimensions';
import {
  PROFIT_AND_LOSS_ACCOUNT_TYPES,
  reportBasisSchema,
  reportDimensionFilterSchema,
  reportGroupKeySchema,
} from '../reports';
import { calendarDateSchema, minorUnitsSchema } from '../wire';

/**
 * Budgets: budget figures by account (and optional dimension) per period, and the
 * budget-vs-actual report (initiative N, OB-180…184; ROADMAP D-N1…D-N6).
 *
 * A budget posts no journal (D-94). It is a target the report compares against
 * ledger actuals — so the entry surface here is a plain upsert, and the report is a
 * projection over `getAccountBalances` (K/OB-041), the same core the P&L reads. The
 * two response families below mirror that split: `Budget`/`SetBudgetsRequest`/
 * `BudgetList` are the stored figures, and `BudgetVsActual` is the comparison,
 * shaped like `ProfitAndLoss` so the web report view can reuse its section layout.
 *
 * Every money amount is a cents-only string (D-13), like the P&L's, and for the
 * same reason: the sums are exact `bigint` arithmetic to this boundary and a JSON
 * number would surrender it in the client's parser. `variancePercent` is the one
 * field that is a JSON number — it is a ratio, not money, and is null when the
 * budget is zero (there is no percentage of nothing to state).
 */

/** The most budget entries one batch upsert accepts. A period × chart is bounded; this is a sanity cap. */
export const SET_BUDGETS_MAX_ENTRIES = 1000;

/**
 * One stored budget figure (D-N1): an amount for `(account, period, optional
 * dimension-value)`. A null `dimensionValueId` is the account-total budget for the
 * period; a non-null one is a per-slice budget. `dimensionId` and `dimensionValueId`
 * are always both null or both set — the axis a value belongs to travels with it.
 */
export const budgetSchema = z
  .strictObject({
    id: z.uuid(),
    accountId: z.uuid(),
    periodId: z.uuid(),
    dimensionId: z.uuid().nullable().meta({
      description: 'The axis of a per-slice budget, or null for the account-total budget.',
    }),
    dimensionValueId: z.uuid().nullable().meta({
      description: 'The dimension value a per-slice budget targets, or null for the account total.',
    }),
    amount: minorUnitsSchema.meta({
      description:
        'The budgeted amount for this slot, as minor units. May be negative (a contra account).',
    }),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({
    id: 'Budget',
    description:
      'A single budget figure for an account and period, optionally scoped to one dimension ' +
      'value. Posts no journal (D-94) — a target the budget-vs-actual report compares to actuals.',
  });

export type Budget = z.infer<typeof budgetSchema>;

/**
 * One entry of a batch upsert (D-N5). The `dimensionValueId` alone names the slice;
 * the service resolves its axis from `dimension_values`, so a client never sends the
 * axis redundantly. Omitting it targets the account-total slot. "Import" is this
 * array — there is no server CSV parser in v1; a paste/CSV UI sits on top of it.
 */
export const setBudgetEntrySchema = z.strictObject({
  accountId: z.uuid().meta({
    description: 'A P&L account (revenue or expense). Balance-sheet budgeting is deferred (D-N2).',
  }),
  periodId: z.uuid(),
  dimensionValueId: z
    .uuid()
    .optional()
    .meta({
      description:
        'The dimension value this figure is scoped to. Omit for the account-total budget; the ' +
        'service resolves the value’s axis, so the axis is never sent separately.',
    }),
  amount: minorUnitsSchema.meta({
    description: 'The budgeted amount, as minor units. Replaces whatever the slot held before.',
  }),
});

export type SetBudgetEntry = z.infer<typeof setBudgetEntrySchema>;

/**
 * The batch upsert body (OB-181). Each entry replaces the amount in its
 * `(account, period, slice)` slot — `setBudgets` is idempotent per slot, so
 * re-sending the same batch is a no-op rather than an accumulation.
 */
export const setBudgetsRequestSchema = z
  .strictObject({
    entries: z.array(setBudgetEntrySchema).min(1).max(SET_BUDGETS_MAX_ENTRIES),
  })
  .meta({
    id: 'SetBudgetsRequest',
    description:
      'Enters or imports budget figures in one batch (D-N5). Each entry upserts its ' +
      '`(account, period, dimension-value)` slot; a repeated slot within one batch is the last ' +
      'writer. Posts no journal.',
  });

export type SetBudgetsRequest = z.infer<typeof setBudgetsRequestSchema>;

/** A small collection of stored budgets — the result of `setBudgets`, and of `listBudgets`. */
export const budgetListSchema = z
  .strictObject({
    items: z.array(budgetSchema),
  })
  .meta({
    id: 'BudgetList',
    description:
      'A collection of stored budget figures. Not paginated: a period’s budgets are bounded by ' +
      'the chart × its dimension values, and the report — not this list — is the read that scales.',
  });

export type BudgetList = z.infer<typeof budgetListSchema>;

/**
 * The list filter (OB-181). Both bounds are optional; a bare call returns every
 * stored budget the org has. A querystring, so it carries no `id`.
 */
export const listBudgetsQuerySchema = z.strictObject({
  periodId: z.uuid().optional().meta({ description: 'Only budgets for this fiscal period.' }),
  accountId: z.uuid().optional().meta({ description: 'Only budgets for this account.' }),
});

export type ListBudgetsQueryParams = z.infer<typeof listBudgetsQuerySchema>;

/**
 * The budget-vs-actual query (OB-182). `periodId` is required — v1 compares a single
 * period (D-N4); a YTD / range variant is a follow-up. `basis` overrides the org
 * default for this run (D-N3); `dimensions` filter and `groupBy` slice exactly as
 * the P&L's do, and cash basis combined with either is refused by the service (the
 * cash-basis path cannot slice — the same guard the P&L reuses). A service-facing
 * schema: `dimensions` is an array here; the route parses it from url-encoded JSON.
 */
export const budgetVsActualQuerySchema = z
  .strictObject({
    periodId: z.uuid(),
    basis: reportBasisSchema.optional(),
    dimensions: z.array(reportDimensionFilterSchema).max(MAX_DIMENSIONS_PER_ORG).optional(),
    groupBy: z.uuid().optional(),
  })
  .meta({
    description:
      'Budget vs actual for one fiscal period. `basis` overrides the org default; `dimensions` ' +
      'filter and `groupBy` slices. Cash basis with a dimension filter or `groupBy` is refused.',
  });

export type BudgetVsActualQueryParams = z.infer<typeof budgetVsActualQuerySchema>;

/**
 * One account's line on the budget-vs-actual report.
 *
 * `budget`, `actual` and `variance` are all signed to the account's P&L section, the
 * P&L's own convention (`profitAndLossRowSchema`): a positive revenue actual is
 * money earned, a positive expense actual is money spent. `variance = budget −
 * actual` in those signed terms, so a positive variance is favourable for revenue
 * (earned more than planned) and for expense (spent less than planned).
 * `variancePercent` is `variance / budget × 100`, or null when the budget is zero.
 */
export const budgetVsActualRowSchema = z
  .strictObject({
    accountId: z.uuid(),
    code: z.string(),
    name: z.string(),
    type: z.enum(PROFIT_AND_LOSS_ACCOUNT_TYPES),
    budget: minorUnitsSchema,
    actual: minorUnitsSchema,
    variance: minorUnitsSchema.meta({ description: '`budget − actual`, signed to the section.' }),
    variancePercent: z.number().nullable().meta({
      description: '`variance / budget × 100`, or null when the budget is zero.',
    }),
  })
  .meta({
    id: 'BudgetVsActualRow',
    description:
      'One account’s budget, actual and variance for the period. Amounts are signed to the P&L ' +
      'section the same way `ProfitAndLossRow`’s are.',
  });

export type BudgetVsActualRow = z.infer<typeof budgetVsActualRowSchema>;

/** The three totals a section, group or the whole report rolls up. */
const varianceTripletShape = {
  budget: minorUnitsSchema,
  actual: minorUnitsSchema,
  variance: minorUnitsSchema,
};

export const budgetVsActualSectionSchema = z
  .strictObject({
    rows: z.array(budgetVsActualRowSchema),
    ...varianceTripletShape,
  })
  .meta({
    id: 'BudgetVsActualSection',
    description:
      'Every account of one section (revenue or expense) with its budget, actual and variance, ' +
      'plus the section totals. Rows include accounts with no budget and no activity, at zero.',
  });

export type BudgetVsActualSection = z.infer<typeof budgetVsActualSectionSchema>;

export const budgetVsActualGroupSchema = z
  .strictObject({
    key: reportGroupKeySchema.nullable(),
    revenue: budgetVsActualSectionSchema,
    expenses: budgetVsActualSectionSchema,
    netIncome: z.strictObject(varianceTripletShape).meta({
      description: '`revenue − expenses` for each of budget, actual and variance.',
    }),
  })
  .meta({
    id: 'BudgetVsActualGroup',
    description:
      'One complete budget-vs-actual statement. An unsliced report has exactly one group whose ' +
      '`key` is null; a `groupBy` report has a group per dimension value plus the unassigned bucket.',
  });

export type BudgetVsActualGroup = z.infer<typeof budgetVsActualGroupSchema>;

export const budgetVsActualTotalsSchema = z
  .strictObject({
    revenue: z.strictObject(varianceTripletShape),
    expenses: z.strictObject(varianceTripletShape),
    netIncome: z.strictObject(varianceTripletShape),
  })
  .meta({ id: 'BudgetVsActualTotals' });

export type BudgetVsActualTotals = z.infer<typeof budgetVsActualTotalsSchema>;

export const budgetVsActualSchema = z
  .strictObject({
    period: z
      .strictObject({
        id: z.uuid(),
        name: z.string(),
        startDate: calendarDateSchema,
        endDate: calendarDateSchema,
      })
      .meta({ description: 'The fiscal period compared, resolved from `periodId`.' }),
    basis: reportBasisSchema.meta({
      description: 'Which basis produced the actuals (D-N3) — the request’s, or the org default.',
    }),
    groupBy: z.uuid().nullable(),
    groups: z.array(budgetVsActualGroupSchema),
    totals: budgetVsActualTotalsSchema.meta({
      description: 'Every group summed. Equal to the same report run without `groupBy`.',
    }),
  })
  .meta({
    id: 'BudgetVsActual',
    description:
      'Budget vs actual for one fiscal period (OB-182): budgeted figures compared to ledger ' +
      'actuals on the org’s basis, with per-account and section variance. Amounts are signed to ' +
      'their P&L section; a positive variance is favourable.',
  });

export type BudgetVsActual = z.infer<typeof budgetVsActualSchema>;
