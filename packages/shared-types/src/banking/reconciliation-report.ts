import { z } from 'zod';

import { calendarDateSchema, minorUnitsSchema } from '../wire';

import { reconciliationBalancesSchema, reconciliationSessionStateSchema } from './reconciliation';

/**
 * The bank reconciliation report (OB-083; ROADMAP D-40, D-46, D-50, D-51, acceptance
 * E7, E9).
 *
 * A session (`reconciliation.ts`) states *that* the books and the bank agree and by how
 * far they do not — `balances.unclearedAmount` is the one number. This report is the
 * document that says *why*: it enumerates the entries that make up that number, so
 * "the ledger and the bank disagree by 1,500" becomes "…because of this cheque, dated
 * the 20th, that has not been presented". A reconciliation report that does not tie to
 * the gap is a list of hopes — the same discipline D-40 imposes on aging, here applied
 * to a bank account rather than a control account.
 *
 * ## The identity the report makes visible, and what ties to it (D-50)
 *
 * D-50 fixed the figure: `unclearedAmount = bookBalance − clearedBalance`, "displayed
 * and explains the gap between the ledger and the bank". This report is that gap,
 * itemised. The identity it ties out, exactly, is
 *
 * ```
 * clearedBalance + Σ reconcilingItems === bookBalance
 * ```
 *
 * i.e. `Σ reconcilingItems === unclearedAmount`. The items are **bank-account ledger
 * movements this session did not clear** — a cheque written and not presented, a
 * deposit in transit, a bank charge posted as a clearing's difference, a straggler
 * cleared into an already-finalised window. Each carries its journal's own signed
 * movement on the bank account, in the same frame the statement line uses
 * (`bankLineAmountSchema`), which is what makes the sum a plain addition with no
 * conditional. This tie is the ticket's C8, and `report.service.test.ts` property-tests
 * it the way OB-071 tied the subledger to its control account.
 *
 * ## Why the uncleared statement lines are a *separate* list, not part of that sum
 *
 * The other half of a bank reconciliation is the statement's side: lines the bank has
 * shown that the books have not caught (a fee not yet coded — rare, usually a backlog).
 * They belong in the report — a document that hid them would hide half of what a
 * reconciler has to act on — but they are `unclearedStatementLines`, not
 * `reconcilingItems`, and deliberately outside the identity above.
 *
 * The reason is the same one `aging.service.ts` gives for stating a gap rather than
 * inventing an arithmetic the data does not support: an uncleared statement line has
 * *no journal* (that is what uncleared means) and *no clearing*, so it moves neither
 * `bookBalance` nor `clearedBalance`, and its contribution to `bookBalance −
 * clearedBalance` is exactly zero. Summing it into `unclearedAmount` would make the
 * report disagree with the figure D-50 defines. It reconciles the *statement* against
 * the cleared books — the `difference` gap, and the `unclearedLineCount` a session
 * already reports — which is a different assertion on the other side of the same page.
 *
 * ## The component ids arrived with OB-084's routes — see `banking.ts`.
 */

/**
 * One bank-account ledger movement the session did not clear.
 *
 * A whole journal, netted onto the bank account: a journal with two lines touching the
 * account (rare, a same-journal transfer) is one item carrying the net, so the item's
 * `amount` is what the account actually moved and the sum stays the ledger's own.
 *
 * `amount` is signed in the bank account's frame — positive is money the ledger shows
 * arriving that the bank has not (a deposit in transit), negative is money the ledger
 * shows leaving that the bank has not (an unpresented cheque). `description` and
 * `reference` are the journal's own, verbatim; a reconciler recognises the entry by
 * them, and they are the only thing that turns a number back into the cheque it is.
 */
export const reconcilingItemSchema = z
  .strictObject({
    journalId: z.uuid().meta({
      description:
        'The journal whose net movement on the bank account this item is. One item per journal, ' +
        'so a client can open the entry the report is pointing at.',
    }),
    date: calendarDateSchema.meta({
      description:
        'The journal’s entry date — the date the ledger moved, and the date `bookBalance` counts it ' +
        'under (D-46). At or before the session’s `endDate` by construction.',
    }),
    amount: minorUnitsSchema.meta({
      description:
        'The journal’s signed net movement on the bank account, in the account’s frame: positive ' +
        'is money the books show in that the bank has not (a deposit in transit), negative is money ' +
        'the books show out that the bank has not (an unpresented cheque).',
    }),
    description: z.string().nullable().meta({
      description: 'The journal’s memo, verbatim, or null. How a reconciler recognises the entry.',
    }),
    reference: z.string().nullable().meta({
      description: 'The journal’s own reference, or null.',
    }),
  })
  .meta({
    id: 'ReconcilingItem',
    description:
      'One bank-account ledger movement the session did not clear — a cheque not presented, a ' +
      'deposit in transit. Signed in the account’s frame; the items sum to `unclearedAmount` (D-50).',
  });

export type ReconcilingItem = z.infer<typeof reconcilingItemSchema>;

/**
 * One statement line the bank has shown that the books have not caught.
 *
 * A line in the session's window carrying no clearing at all. Reported so the backlog
 * is visible, and outside `reconcilingItems` for the reason the file header gives: it
 * has no journal, so it is not part of the `unclearedAmount` identity — it is the
 * statement's side of the reconciliation, the one a session already counts in
 * `unclearedLineCount`.
 */
export const unclearedStatementLineSchema = z
  .strictObject({
    lineId: z.uuid(),
    date: calendarDateSchema.meta({
      description: 'The line’s `postedDate` — the date the bank’s own balance moved on (D-45).',
    }),
    amount: minorUnitsSchema.meta({
      description: 'What the bank moved, signed, in the line’s frame (`bankLineAmountSchema`).',
    }),
    description: z.string().meta({
      description: 'The bank’s narrative for the line, verbatim.',
    }),
    reference: z.string().nullable().meta({
      description: 'The bank’s own transaction identifier, where it supplied one.',
    }),
  })
  .meta({
    id: 'UnclearedStatementLine',
    description:
      'One statement line the bank has shown that the books have not caught. Reported so the ' +
      'backlog is visible, but outside `unclearedAmount` — it has no journal, so it moves neither ' +
      'balance in it.',
  });

export type UnclearedStatementLine = z.infer<typeof unclearedStatementLineSchema>;

/**
 * The reconciliation report for one session, as the API returns it.
 *
 * `balances` is the session's own (`reconciliationBalancesSchema`, computed on read,
 * D-46) so the report and the session can never disagree about the figure being
 * explained. The two lists are the explanation: `reconcilingItems` ties to
 * `balances.unclearedAmount` exactly (the file header's identity), and
 * `unclearedStatementLines` is the statement-side backlog shown alongside.
 *
 * Built from a finalised session, the report reflects that session's frozen membership
 * (D-51): `clearedBalance` and which entries count as reconciling are taken from the
 * stamp, not re-derived by date, so the report of a past reconciliation reads the same
 * tomorrow as it did the day it was made — reproducibility in the sense D-40 requires
 * and D-32 warned is easy to lose.
 */
export const reconciliationReportSchema = z
  .strictObject({
    sessionId: z.uuid(),
    bankAccountId: z.uuid(),
    startDate: calendarDateSchema,
    endDate: calendarDateSchema.meta({
      description: 'The date every figure and every item on this report is computed as at.',
    }),
    state: reconciliationSessionStateSchema,
    balances: reconciliationBalancesSchema,
    reconcilingItems: z.array(reconcilingItemSchema).meta({
      description:
        'The bank-account ledger movements this session did not clear, oldest first. Their signed ' +
        'amounts sum to `balances.unclearedAmount` exactly: `clearedBalance + Σ items === ' +
        'bookBalance` (D-50).',
    }),
    unclearedStatementLines: z.array(unclearedStatementLineSchema).meta({
      description:
        'Statement lines in the window the books have not caught, oldest first. The other half of ' +
        'the reconciliation — shown, but not part of `unclearedAmount`, because a line with no ' +
        'journal moves neither balance in it.',
    }),
  })
  .meta({
    id: 'ReconciliationReport',
    description:
      'The reconciliation report for one session: the gap between the ledger and the bank, ' +
      'itemised. `reconcilingItems` ties to `balances.unclearedAmount` exactly (D-50).',
  });

export type ReconciliationReport = z.infer<typeof reconciliationReportSchema>;
