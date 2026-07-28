import { z } from 'zod';

import { calendarDateSchema, minorUnitsSchema } from '../wire';

import { reportRangeShape } from './balances';
import { reportBasisSchema } from './profit-and-loss';

/**
 * The Statement of Cash Flows wire contract, indirect method (OB-157; D-88).
 *
 * ## Scoped to what the ledger gives deterministically
 *
 * A textbook indirect SCF splits its reconciliation into operating, investing and
 * financing adjustments — depreciation added back, a change in receivables, a loan
 * draw. None of those are derivable here without a fixed-asset register and a
 * classification of every balance-sheet account into one of the three activities,
 * neither of which exists yet. Rather than fabricate a split this report cannot
 * stand behind, it reports three honest figures and lets the difference say what it
 * is: `netIncome` (from the P&L core, on the requested or org-default basis),
 * `netChangeInCash` (the literal movement of the org's cash accounts, always read
 * accrual — cash moving is a fact, not a recognition choice), and `adjustments`,
 * which is defined as whatever is left so the two other figures reconcile. The
 * categorized split is a later increment; see `cash-flow.service.ts`.
 *
 * ## Which accounts are "cash"
 *
 * Every account named by `bank_accounts.account_id`, plus every account an operator
 * has flagged `accounts.cash_basis_role = 'cash'` — the same hint OB-154's transform
 * reads, restated here because a cash flow statement and a cash-basis P&L are asking
 * the same question ("which accounts are cash") for two different reports. An org
 * with neither is an honest empty statement (every figure `"0"`), not an error.
 *
 * ## Query shape
 *
 * Mirrors `profitAndLossQuerySchema`: the shared range, and an optional `basis`
 * override for `netIncome`. No `contactId`, no `dimensions`, no `groupBy` — this
 * statement is whole-org by construction, the same restriction `assertCashBasisSupported`
 * puts on a cash-basis P&L, and for the same reason: the cash-accounts filter has no
 * contact or dimension to slice by, so a filter here would apply to only one of the
 * two figures being reconciled.
 */
export const statementOfCashFlowsQuerySchema = z
  .strictObject({
    ...reportRangeShape,
    // Overrides the org's `default_reporting_basis` for `netIncome` only (K1). The
    // cash movement itself is not basis-dependent — see the file comment.
    basis: reportBasisSchema.optional(),
  })
  .meta({
    description:
      'Inclusive date bounds for the period and an optional basis override for net income. ' +
      'Omitting `from` runs from the ledger’s beginning; omitting `to` includes every posting ' +
      'to date. There is no contact, dimension or `groupBy` filter — the statement is ' +
      'whole-org by construction.',
  });

export type StatementOfCashFlowsQueryParams = z.infer<typeof statementOfCashFlowsQuerySchema>;

export const statementOfCashFlowsSchema = z
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
    /** Which basis produced `netIncome` (K1, D-87) — the request's, or the org's default. */
    basis: reportBasisSchema,
    netIncome: minorUnitsSchema.meta({
      description: 'The period’s net income (the P&L core’s `totals.netIncome`), on `basis`.',
    }),
    openingCash: minorUnitsSchema.meta({
      description: 'The cash accounts’ combined balance strictly before `range.from`.',
    }),
    closingCash: minorUnitsSchema.meta({
      description:
        '`openingCash + netChangeInCash`, i.e. the cash accounts’ balance at `range.to`.',
    }),
    netChangeInCash: minorUnitsSchema.meta({
      description:
        'The cash accounts’ combined movement inside the period, both bounds inclusive. Always ' +
        'read accrual: which account moved cash is a fact, not a recognition choice.',
    }),
    adjustments: minorUnitsSchema.meta({
      description:
        '`netChangeInCash - netIncome`: a single "adjustments to reconcile net income to net ' +
        'cash" line standing in for the non-cash and working-capital changes a categorized ' +
        'operating/investing/financing split would otherwise itemise. That split needs a ' +
        'fixed-asset register and a per-account activity classification this increment does ' +
        'not have; reporting one honest plug figure is preferred over a fabricated breakdown.',
    }),
    reconciles: z.boolean().meta({
      description:
        '`openingCash + netChangeInCash === closingCash` and `netIncome + adjustments === ' +
        'netChangeInCash`. True by construction — `adjustments` is defined as the figure that ' +
        'makes the second equality hold, and the first is `balanceOf`’s own invariant — so this ' +
        'is a live check rather than a literal, following the trial balance’s convention of ' +
        'reporting an invariant rather than asserting it inside a read.',
    }),
  })
  .meta({
    id: 'StatementOfCashFlows',
    description:
      'The Statement of Cash Flows, indirect method, scoped to what the ledger gives ' +
      'deterministically: net income, the literal change in the org’s cash accounts, and the ' +
      'difference between them as a single reconciling line. No categorized ' +
      'operating/investing/financing split — see `adjustments`.',
  });

export type StatementOfCashFlows = z.infer<typeof statementOfCashFlowsSchema>;
