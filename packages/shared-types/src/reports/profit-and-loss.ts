import { z } from 'zod';

import type { AccountType } from '../accounts';
import { NORMAL_BALANCES } from '../accounts';
import { calendarDateSchema, minorUnitsSchema } from '../wire';

import { reportRangeShape, reportSliceShape } from './balances';
import { reportGroupKeySchema } from './groups';

/**
 * The profit and loss wire contract (OB-042; acceptance B2, B6, B7).
 *
 * A projection over OB-041's `getAccountBalances` and not a second aggregation —
 * see `modules/reports/index.ts` for why there is exactly one query behind all
 * three M2 reports. What this file adds is the part the core deliberately refuses
 * to decide: which accounts a statement shows, which way its numbers point, and
 * what the bottom line is called.
 *
 * Every amount is a cents-only string (D-13), like the trial balance's, and for
 * the same reason: the sums are exact `bigint` arithmetic all the way to this
 * boundary, and a JSON number would surrender that in the client's parser.
 *
 * ## The `id`s
 *
 * `GET /v1/reports/profit-and-loss` is OB-045's, so the response schemas below now
 * carry the ids OB-042 deliberately withheld — the rule at the top of
 * `accounts/accounts.ts` is that an `id` goes on a body or response schema a route
 * references, and until the route existed these would have published components
 * nothing could reach. `profitAndLossQuerySchema` still carries none, and must not:
 * a querystring is emitted as individual `parameters`, so a component for it would
 * be referenced by nothing.
 *
 * The bucket key is `reportGroupKeySchema` and no longer a copy of it. See
 * `groups.ts` for why three identical components would have been a worse artifact
 * than one.
 */

/**
 * The two account types a P&L is made of.
 *
 * `satisfies` rather than a subset derived from `ACCOUNT_TYPES` at runtime: the
 * check that these are real account types is worth having, and a filter over the
 * full list would make the *order* of the sections depend on the order of an
 * unrelated constant.
 */
export const PROFIT_AND_LOSS_ACCOUNT_TYPES = [
  'revenue',
  'expense',
] as const satisfies readonly AccountType[];

export type ProfitAndLossAccountType = (typeof PROFIT_AND_LOSS_ACCOUNT_TYPES)[number];

/**
 * The statement's query: the core's range and slice, minus `types`.
 *
 * `types` is omitted rather than defaulted because a P&L *is* revenue and expense
 * — a caller who sent `types: ['asset']` would either be silently ignored or be
 * handed a balance sheet under a P&L heading, and `strictObject` refuses the field
 * instead of choosing between those.
 *
 * No `basis`. D-22 makes M2 accrual-only, and a parameter whose single accepted
 * value is the only behaviour is a knob that does nothing — worse than its
 * absence, since it implies the other setting exists somewhere.
 *
 * ## Why there are no cross-field refinements here
 *
 * `accountBalancesQuerySchema` refines two things — an inverted range, and two
 * filters naming the same axis — and this schema deliberately does not restate
 * them. The service hands its parsed query straight to `getAccountBalances`, which
 * parses again against that schema, so both rules are enforced on every path and
 * with the core's own messages. Restating them here would put the same rule in two
 * places that can disagree, and buy nothing on the wire: a zod refinement emits
 * nothing into JSON Schema, so the published artifact is identical either way.
 */
export const profitAndLossQuerySchema = z
  .strictObject({
    ...reportRangeShape,
    contactId: reportSliceShape.contactId,
    dimensions: reportSliceShape.dimensions,
    groupBy: reportSliceShape.groupBy,
  })
  .meta({
    description:
      'Inclusive date bounds for the period, optional contact and dimension filters, and an ' +
      'optional axis to slice by. Omitting `from` runs the statement from the ledger’s ' +
      'beginning; omitting `to` includes every posting to date. There is no `types` filter — a ' +
      'profit and loss is revenue and expense by definition.',
  });

export type ProfitAndLossQueryParams = z.infer<typeof profitAndLossQuerySchema>;

/**
 * One account's line on the statement.
 *
 * ## The sign convention, which is the decision this report exists to make
 *
 * The core's `balance` is `debits - credits` and is never flipped to an account's
 * normal side. Printed raw, a revenue account that had a good month shows a
 * negative number, which is the opposite of what every reader of a P&L expects.
 *
 * So both amounts here are **signed to their section's own side**: revenue is
 * positive when the org earned money, expense is positive when the org spent it,
 * and `netIncome = revenue.total - expenses.total` is positive for a profit. The
 * flip is `credits - debits` for a revenue row and `debits - credits` for an
 * expense row.
 *
 * **The flip keys off `type`, never off `normalBalance`**, and the difference is
 * not cosmetic. A contra-revenue account — sales discounts, returns — has
 * `type: 'revenue'` and `normalBalance: 'debit'`. Signing by the normal balance
 * would print it positive and *add* it to the revenue total; signing by the type
 * prints it negative and subtracts it, which is what a discount does to revenue.
 * Every ordinary chart agrees with both rules, so the mistake is invisible until
 * an org has its first contra account.
 */
export const profitAndLossRowSchema = z
  .strictObject({
    accountId: z.uuid(),
    code: z.string(),
    name: z.string(),
    type: z.enum(PROFIT_AND_LOSS_ACCOUNT_TYPES),
    normalBalance: z.enum(NORMAL_BALANCES),
    parentAccountId: z.uuid().nullable(),
    isActive: z.boolean(),
    amount: minorUnitsSchema.meta({
      description:
        'This account’s own postings in the period, signed to its section: positive revenue ' +
        'means earned, positive expense means spent. Descendants are in `subtotal`, not here.',
    }),
    subtotal: minorUnitsSchema.meta({
      description:
        '`amount` plus every descendant’s `amount` (B7). A parent may hold postings of its own, ' +
        'so printing `subtotal` against the parent’s name beside its children double-counts.',
    }),
  })
  .meta({
    id: 'ProfitAndLossRow',
    description:
      'One account’s line. Rows are in account-code order and nest by `parentAccountId`; the ' +
      'hierarchy is expressed by that pointer rather than by nesting so the shape stays flat.',
  });

/**
 * A section of the statement.
 *
 * `rows` carries **every** account of that type in the chart, including ones with
 * no postings in the period. That follows the trial balance's rule for the same
 * first reason — an empty revenue account is how someone notices the month's sales
 * were posted somewhere else — but it is decided here by a second reason the trial
 * balance did not have: B6 is stated account by account across a sliced report's
 * groups, and a group that dropped its own zero rows would drop a *different* set
 * in every group. "Slices plus unassigned equal the whole" would then be comparing
 * row sets rather than amounts, and could not be checked at all.
 *
 * The counter-argument is real — a chart carries accounts that are simply
 * irrelevant this month — and its answer is the hierarchy: irrelevant detail rolls
 * into a parent's `subtotal`, and collapsing that parent is a rendering decision,
 * made where the rendering is.
 */
export const profitAndLossSectionSchema = z
  .strictObject({
    rows: z.array(profitAndLossRowSchema),
    total: minorUnitsSchema,
  })
  .meta({
    id: 'ProfitAndLossSection',
    description:
      'Every account of this type in the chart, including those with no postings in the ' +
      'period, plus the section total. `total` is the sum of every row’s `amount` — not of ' +
      'the `subtotal`s, which would count each parent’s subtree once per level.',
  });

export const profitAndLossGroupSchema = z
  .strictObject({
    key: reportGroupKeySchema.nullable(),
    revenue: profitAndLossSectionSchema,
    expenses: profitAndLossSectionSchema,
    netIncome: minorUnitsSchema.meta({
      description: '`revenue.total - expenses.total`. Positive is a profit.',
    }),
  })
  .meta({
    id: 'ProfitAndLossGroup',
    description:
      'One complete statement. An unsliced report has exactly one group, whose `key` is null; a ' +
      'sliced one has a group per dimension value in the period plus the unassigned bucket last.',
  });

export const profitAndLossTotalsSchema = z
  .strictObject({
    revenue: minorUnitsSchema,
    expenses: minorUnitsSchema,
    netIncome: minorUnitsSchema,
  })
  .meta({ id: 'ProfitAndLossTotals' });

export const profitAndLossSchema = z
  .strictObject({
    range: z
      .strictObject({
        from: calendarDateSchema.nullable(),
        to: calendarDateSchema.nullable(),
      })
      .meta({
        description:
          'The bounds that were applied, both inclusive. `from` is null when the statement runs ' +
          'from the ledger’s beginning, `to` when every posting to date is in.',
      }),
    /**
     * Stated on the response, not accepted on the query. D-22 defers cash basis to
     * M3 because it needs a payment date to key on, and names the failure it is
     * avoiding: accrual figures printed under a cash-basis heading are a number
     * someone might file. Saying which basis produced these numbers is what makes
     * that misreading impossible rather than merely unlikely, and it is the field
     * M3 widens rather than adds.
     */
    basis: z.literal('accrual'),
    groupBy: z.uuid().nullable(),
    groups: z.array(profitAndLossGroupSchema),
    totals: profitAndLossTotalsSchema.meta({
      description:
        'Every group summed, including the unassigned bucket. Equal to the same statement run ' +
        'without `groupBy` (B6).',
    }),
  })
  .meta({
    id: 'ProfitAndLoss',
    description:
      'Revenue and expense over a date range, with hierarchy subtotals and net income. Amounts ' +
      'are signed to their section — positive revenue is earned, positive expense is spent — ' +
      'and no comparative period is included; run the report twice to compare two ranges.',
  });
