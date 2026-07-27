import { z } from 'zod';

import type { AccountType } from '../accounts';
import { NORMAL_BALANCES } from '../accounts';
import { calendarDateSchema, minorUnitsSchema } from '../wire';

import { reportSliceShape } from './balances';

/**
 * The balance sheet wire contract (OB-043; acceptance B2, B3, B6, B7; D-20).
 *
 * A projection over OB-041's `getAccountBalances`, like the P&L next door — see
 * `modules/reports/index.ts` for why one aggregation stands behind all three M2
 * reports. What this file adds is the part the core refuses to decide, plus the one
 * thing no other report has: **two equity lines that are not accounts**.
 *
 * ## The derived earnings lines (D-20)
 *
 * With no year-end closing journal, revenue and expense balances have nowhere to
 * land, so a sheet built from account balances alone does not balance — the
 * difference is the income the ledger has not moved into equity. M2 derives that
 * figure rather than requiring a close, and reports it as `currentYearEarnings`.
 *
 * `priorYearEarnings` is the same quantity for every fiscal year *before* the one
 * containing `asOf`. It exists because D-20's one-line summary describes an org in
 * its first year: in its second, the prior year's income is still sitting in the
 * revenue and expense accounts, and a sheet carrying only the current year's would
 * be out of balance by exactly last year's profit. Splitting the derivation at the
 * fiscal-year boundary is what makes B3 hold for an org of any age, and it is the
 * split the future closing journal will consume — see `balance-sheet.service.ts`.
 *
 * Neither line is an account. An org's own retained-earnings account is an ordinary
 * equity account and is counted in `equity`, once (D-20: "deriving something that
 * also exists as an account is how it gets double-counted").
 *
 * ## Why the amounts are already signed for the side they print on
 *
 * The core states that `balance` there is always `debits - credits` and never
 * flipped, and that the sign convention is one every projection must state for
 * itself. This is the balance sheet's: **every amount below is positive when it is
 * on the side its section belongs to** — assets are `debits - credits`, liabilities
 * and equity are `credits - debits`. That makes B3 an equality between two printed
 * numbers rather than a sum against zero a reader has to re-derive.
 *
 * **The flip keys off `type`, never off `normalBalance`.** Accumulated depreciation
 * is an asset with a credit normal balance; signing by the normal balance would
 * print it as a positive asset and break the equation on exactly the account a
 * maturing chart acquires first. Every ordinary account agrees with both rules, so
 * the mistake is invisible until the first contra account exists.
 *
 * ## Why nothing here carries `.meta({ id })`
 *
 * The transform lifts every schema carrying an `id` out of zod's global registry
 * into `components.schemas` whether a route references it or not, and A10 makes
 * drift in `openapi.json` a build failure. OB-043 ends at the service; routes are
 * OB-045, and the ids land with them.
 */

/**
 * The three account types a balance sheet prints, in the order it prints them.
 *
 * `satisfies` rather than a runtime subset of `ACCOUNT_TYPES`, matching the P&L:
 * the check that these are real account types is worth having, and deriving the
 * list by filtering would make the order of the sections depend on the order of an
 * unrelated constant. Revenue and expense are absent from this list and present in
 * the report — as the two derived lines above.
 */
export const BALANCE_SHEET_ACCOUNT_TYPES = [
  'asset',
  'liability',
  'equity',
] as const satisfies readonly AccountType[];

export type BalanceSheetAccountType = (typeof BALANCE_SHEET_ACCOUNT_TYPES)[number];

export const balanceSheetRowSchema = z
  .strictObject({
    accountId: z.uuid(),
    code: z.string(),
    name: z.string(),
    type: z.enum(BALANCE_SHEET_ACCOUNT_TYPES),
    normalBalance: z.enum(NORMAL_BALANCES),
    parentAccountId: z.uuid().nullable(),
    isActive: z.boolean(),
    amount: minorUnitsSchema.meta({
      description:
        'This account’s own balance as at the report date, signed to its section: a positive ' +
        'asset is held, a positive liability is owed. Descendants are in `subtotal`, not here.',
    }),
    subtotal: minorUnitsSchema.meta({
      description:
        '`amount` plus every descendant’s `amount` (B7). A parent may hold postings of its own, ' +
        'so printing `subtotal` against the parent’s name beside its children double-counts.',
    }),
  })
  .meta({
    description:
      'One account’s line. Rows are in account-code order and nest by `parentAccountId`; the ' +
      'hierarchy is expressed by that pointer rather than by nesting so the shape stays flat.',
  });

export type BalanceSheetRow = z.infer<typeof balanceSheetRowSchema>;

/**
 * One section of the sheet.
 *
 * `rows` carries **every** account of that type in the chart, including ones
 * standing at zero. The trial balance's reason applies — an empty bank account is
 * how someone notices the month's receipts were posted somewhere else — and B6
 * adds a second: that criterion is stated account by account across a sliced
 * report's groups, and a group that dropped its own zero rows would drop a
 * different set in every group, leaving "slices plus unassigned equal the whole"
 * comparing row sets rather than amounts.
 */
export const balanceSheetSectionSchema = z
  .strictObject({
    rows: z.array(balanceSheetRowSchema),
    total: minorUnitsSchema,
  })
  .meta({
    description:
      'Every account of this type in the chart, including those standing at zero, plus the ' +
      'section total. `total` is the sum of every row’s `amount` — not of the `subtotal`s, ' +
      'which would count each parent’s subtree once per level.',
  });

export type BalanceSheetSection = z.infer<typeof balanceSheetSectionSchema>;

/**
 * The bucket key when the sheet is sliced by a dimension axis.
 *
 * `null` is the unassigned bucket, which is always present (D-18): a slice view
 * that omits untagged lines shows a smaller business than exists.
 */
export const balanceSheetGroupKeySchema = z.strictObject({
  dimensionValueId: z.uuid(),
  code: z.string(),
  name: z.string(),
});

/**
 * Every figure the sheet foots on, for one bucket or for the whole report.
 *
 * `difference` is reported rather than asserted, following the trial balance: this
 * report says what the ledger contains, and a non-zero difference is a fact an
 * operator needs to see rather than an exception to swallow.
 *
 * It is only expected to be `"0"` for the report **as a whole**. A single group of
 * a sliced sheet may legitimately be out of balance: tags are per line (D-18), so
 * one journal's debit and credit can carry different values on the same axis, and
 * a bucket then holds one side of an entry. That is a fact about the tagging, not
 * an error, and B6 — the groups summed equal the report unsliced — is the property
 * that keeps it honest.
 */
export const balanceSheetTotalsSchema = z.strictObject({
  assets: minorUnitsSchema,
  liabilities: minorUnitsSchema,
  /** Equity **accounts** only. The two derived lines are separate on purpose (D-20). */
  equity: minorUnitsSchema,
  priorYearEarnings: minorUnitsSchema.meta({
    description:
      'Revenue less expenses for every fiscal year before the one containing `asOf`. Derived, ' +
      'never an account (D-20) — it is what a closing journal would have moved into equity.',
  }),
  currentYearEarnings: minorUnitsSchema.meta({
    description:
      'Revenue less expenses from the start of the fiscal year containing `asOf` up to and ' +
      'including it. Derived, never an account (D-20). Positive is a profit.',
  }),
  liabilitiesAndEquity: minorUnitsSchema.meta({
    description: '`liabilities + equity + priorYearEarnings + currentYearEarnings`.',
  }),
  difference: minorUnitsSchema.meta({
    description:
      '`assets - liabilitiesAndEquity`. `"0"` for the report as a whole (B3); one slice of a ' +
      'grouped report may be non-zero, because tags are per line.',
  }),
});

export type BalanceSheetTotals = z.infer<typeof balanceSheetTotalsSchema>;

export const balanceSheetGroupSchema = z
  .strictObject({
    key: balanceSheetGroupKeySchema.nullable(),
    assets: balanceSheetSectionSchema,
    liabilities: balanceSheetSectionSchema,
    equity: balanceSheetSectionSchema,
    totals: balanceSheetTotalsSchema,
  })
  .meta({
    description:
      'One complete sheet. An unsliced report has exactly one group, whose `key` is null; a ' +
      'sliced one has a group per dimension value plus the unassigned bucket last.',
  });

export type BalanceSheetGroup = z.infer<typeof balanceSheetGroupSchema>;

/**
 * The fiscal year the earnings derivation was scoped to, echoed back.
 *
 * Reported rather than left implicit because it is a *resolved* value: the year's
 * start month is a per-org setting (D-17), so two orgs reading a sheet as at the
 * same date have current-year earnings measured over different windows. A reader
 * who cannot see which window was used cannot check the number, and "which year is
 * this org in" is precisely the input that is easy to get wrong.
 */
export const balanceSheetFiscalYearSchema = z
  .strictObject({
    /** The calendar year the fiscal year *starts* in — the convention `fiscalYearSpan` states. */
    year: z.int(),
    startMonth: z.int().min(1).max(12),
    startDate: calendarDateSchema,
    /** Inclusive, and after `asOf` whenever the sheet is drawn mid-year. */
    endDate: calendarDateSchema,
  })
  .meta({
    description:
      'The fiscal year containing `asOf`, resolved from the org’s fiscal-year start month. ' +
      '`year` names the calendar year the fiscal year starts in.',
  });

export const balanceSheetSchema = z
  .strictObject({
    asOf: calendarDateSchema,
    fiscalYear: balanceSheetFiscalYearSchema,
    /**
     * Stated on the response, not accepted on the query. D-22 defers cash basis to
     * M3 because it needs a payment date to key on, and names the failure it
     * avoids: accrual figures printed under a cash-basis heading are a number
     * someone might file. This is the field M3 widens rather than adds.
     */
    basis: z.literal('accrual'),
    groupBy: z.uuid().nullable(),
    groups: z.array(balanceSheetGroupSchema),
    totals: balanceSheetTotalsSchema.meta({
      description:
        'Every group summed, including the unassigned bucket. Equal to the same sheet run ' +
        'without `groupBy` (B6), and the totals B3 is stated over.',
    }),
  })
  .meta({
    description:
      'Assets, liabilities and equity as at a date, with hierarchy subtotals and the two derived ' +
      'earnings lines that make the sheet balance without a closing journal (D-20). Amounts are ' +
      'signed to their section, so `totals.assets` equals `totals.liabilitiesAndEquity`.',
  });

export type BalanceSheet = z.infer<typeof balanceSheetSchema>;

/**
 * The query: the core's slice, and a single date.
 *
 * **`asOf` is required**, where the trial balance's is optional. A balance sheet is
 * a position at a point in time, and this report cannot read an omitted date as
 * "everything to date": the fiscal year the earnings derivation is scoped to is
 * resolved *from the report date* (D-17, D-20), so an omitted one would have to
 * come from the process clock — and the same request would then return different
 * numbers on either side of a year end, for a reason nothing in the request
 * records.
 *
 * `types` from `reportSliceShape` is deliberately absent, for a sharper reason than
 * the P&L's. Which accounts a balance sheet shows is what makes it a balance sheet,
 * *and* the derived earnings lines are computed from the revenue and expense
 * accounts a `types` filter would remove — so a caller-chosen type list could only
 * produce a sheet that does not balance. `strictObject` refuses the field rather
 * than ignoring it.
 *
 * No cross-field refinement: a single date cannot be inverted, and the repeated-axis
 * rule lives on `reportDimensionFilterSchema`'s own array in the core's query, which
 * this report's service applies by handing the filters straight to it.
 */
export const balanceSheetQuerySchema = z
  .strictObject({
    asOf: calendarDateSchema,
    contactId: reportSliceShape.contactId,
    dimensions: reportSliceShape.dimensions,
    groupBy: reportSliceShape.groupBy,
  })
  .meta({
    description:
      'The position as at `asOf`, with the same contact and dimension filters every M2 report ' +
      'takes. Current-year earnings is derived over the fiscal year containing `asOf`.',
  });

export type BalanceSheetQueryParams = z.infer<typeof balanceSheetQuerySchema>;
