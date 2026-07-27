import { z } from 'zod';

import { isOrderedRange } from '../subledger';
import { calendarDateSchema, minorUnitsSchema, pageQueryShape, pageSchema } from '../wire';

import { bankDateRangeShape } from './banking';

/**
 * Reconciliation sessions (OB-075, for OB-082 and OB-083; ROADMAP D-45, D-46,
 * acceptance E5, E6, E7).
 *
 * ## What a session is
 *
 * D-45: a session names a bank account, an end date and the statement's closing
 * balance. Lines are cleared into it until the computed balance equals that figure;
 * finalising records the assertion. It is the moment the books and the bank are
 * stated to have agreed, and it is the whole reason the rest of M4 exists.
 *
 * ## Its lock is not the fiscal period's, and nothing here may conflate them (E7)
 *
 * There is no `periodId` in this file, no period state, and no field that a period
 * close writes. D-45 is explicit about why, and about it being easy to get wrong: "a
 * bank reconciliation and a period close are different assertions on different
 * cadences — one says *the bank agreed with us*, the other says *we are done
 * changing this month*. Coupling them means a single bank account's unreconciled
 * straggler can freeze the whole ledger, or worse, that closing a period silently
 * asserts a reconciliation nobody performed."
 *
 * The two do meet in one place and only one: clearing a line posts a journal, and a
 * journal must land in an open fiscal period (D-17). That is the period lock doing
 * its own job to a posting, not to a session.
 *
 * ## The statement's balance is a claim, not a balance we hold (D-46)
 *
 * `statementClosingBalance` is what the bank says. `bookBalance` is what the ledger
 * account says, computed from journal lines on read like every other balance in this
 * system. The session exists to test one against the other; it stores neither as a
 * fact about the account, which is D-46's "storing both as peers is how a banking
 * module ends up disagreeing with its own general ledger".
 *
 * ## The component ids arrived with OB-084's routes — see `banking.ts`.
 */

export const RECONCILIATION_REASON_MAX_LENGTH = 512;

/**
 * Two states, and the absence of a third is the point.
 *
 * A `reopened` state is the obvious third and would be a second, lossier encoding of
 * what the event log already says: a reopened session is *open*, and how it got
 * there is a fact with an actor and a timestamp on it (E6). One value that means
 * "open, but it has been finalised before" would put the history in an enum, where
 * the second reopen has nowhere to go.
 */
export const RECONCILIATION_SESSION_STATES = ['open', 'finalised'] as const;

export type ReconciliationSessionState = (typeof RECONCILIATION_SESSION_STATES)[number];

export const reconciliationSessionStateSchema = z.enum(RECONCILIATION_SESSION_STATES).meta({
  description:
    'Whether the assertion has been made. A reopened session is `open` again — the history lives ' +
    'in the events, not in a third value.',
});

/**
 * What the session's arithmetic says, all of it **computed on read**.
 *
 * Only `statementClosingBalance` is stored, because only it comes from outside. Every
 * other figure here is derived from journal lines and clearings at the moment it is
 * asked for, which is D-34 and D-46 applied to a reconciliation: a cached
 * reconciliation balance is a number that goes stale the first time a clearing is
 * removed.
 *
 * The three that matter, and how they relate:
 *
 * - `clearedBalance` — the opening balance plus every line cleared into this
 *   session. This is the figure `statementClosingBalance` is tested against, and
 *   `difference` is what is left when it is not.
 * - `bookBalance` — the ledger account's balance at `endDate`, uncleared entries and
 *   all. Reported so that a session which balances still shows what the bank has not
 *   caught up with: a cheque written and not presented is a real entry, and a
 *   reconciliation that hid it would be hiding the money it is about.
 * - `unclearedAmount` — `bookBalance − clearedBalance`, which is exactly those
 *   entries. Zero on an account whose every movement came from the statement.
 */
export const reconciliationBalancesSchema = z
  .strictObject({
    openingBalance: minorUnitsSchema.meta({
      description:
        'The cleared balance this session starts from — the previous session’s cleared balance, or ' +
        'zero for the first one on an account.',
    }),
    clearedBalance: minorUnitsSchema.meta({
      description:
        'Opening balance plus every line cleared into this session. What the statement’s closing ' +
        'balance is tested against.',
    }),
    statementClosingBalance: minorUnitsSchema.meta({
      description:
        'What the bank says the account held at `endDate`. A claim from outside the system (D-46), ' +
        'and the only figure on this object that is stored rather than computed.',
    }),
    difference: minorUnitsSchema.meta({
      description:
        '`statementClosingBalance − clearedBalance`. Must be zero to finalise (E5); anything else ' +
        'is `reconciliation_session_balance_mismatch`, and the number is what tells a user how far ' +
        'off they are.',
    }),
    bookBalance: minorUnitsSchema.meta({
      description:
        'The ledger account’s balance at `endDate`, computed from journal lines (D-46). Reported ' +
        'rather than asserted — it differs from `clearedBalance` by exactly the entries the bank ' +
        'has not shown yet.',
    }),
    unclearedAmount: minorUnitsSchema.meta({
      description:
        '`bookBalance − clearedBalance`: entries in the books that no statement line has cleared. A ' +
        'cheque written and not presented. Zero on an account whose every movement came from a ' +
        'statement.',
    }),
  })
  .meta({
    id: 'ReconciliationBalances',
    description:
      'What the session’s arithmetic says, all computed on read except `statementClosingBalance` ' +
      '(D-34, D-46). `difference` must be zero to finalise (E5).',
  });

export type ReconciliationBalances = z.infer<typeof reconciliationBalancesSchema>;

/**
 * One thing that happened to a session, append-only (E6).
 *
 * Rows rather than three nullable timestamp columns on the session, because a
 * session can be reopened more than once and a column pair records only the last
 * time. E6 asks for "a record of who and when", and a record that overwrites its
 * predecessor is not one.
 *
 * `reason` is required on a reopen and null on the rest — the sanctioned way to
 * reopen leaves behind why, and "why" is the only thing a later reader cannot
 * reconstruct.
 */
export const RECONCILIATION_EVENT_TYPES = ['opened', 'finalised', 'reopened'] as const;

export type ReconciliationEventType = (typeof RECONCILIATION_EVENT_TYPES)[number];

export const reconciliationEventTypeSchema = z.enum(RECONCILIATION_EVENT_TYPES);

export const reconciliationSessionEventSchema = z
  .strictObject({
    id: z.uuid(),
    sessionId: z.uuid(),
    type: reconciliationEventTypeSchema,
    reason: z.string().nullable().meta({
      description: 'Why, on a reopen. Null on `opened` and `finalised`, which need no explanation.',
    }),
    actorUserId: z.uuid().meta({
      description:
        'Who did it. E6 makes reopening permission-gated *and* recorded; the gate is the service’s ' +
        'and this is the record.',
    }),
    statementClosingBalance: minorUnitsSchema.nullable().meta({
      description:
        'The figure that was asserted, on a `finalised` event. Captured at the moment of the ' +
        'assertion so that a session finalised, reopened, corrected and finalised again shows what ' +
        'each assertion actually claimed.',
    }),
    occurredAt: z.iso.datetime(),
  })
  .meta({
    id: 'ReconciliationSessionEvent',
    description:
      'One thing that happened to a session, append-only (E6). `reason` is required on a reopen and ' +
      'null on the rest — the one part of the record a later reader cannot reconstruct.',
  });

export type ReconciliationSessionEvent = z.infer<typeof reconciliationSessionEventSchema>;

/**
 * A session as the API returns it.
 *
 * No `updatedAt` beside `createdAt` would be wrong here — unlike a statement line, a
 * session genuinely changes while it is open — but note what is still absent: no
 * `periodId`, no `isLocked`, no field a fiscal-period close writes (E7).
 */
export const reconciliationSessionSchema = z
  .strictObject({
    id: z.uuid(),
    bankAccountId: z.uuid(),
    startDate: calendarDateSchema.meta({
      description:
        'The day after the previous session’s `endDate`, or the date of the account’s earliest ' +
        'statement line for the first one. Sessions on an account do not overlap — an overlap would ' +
        'let one line be counted in two assertions, which is `reconciliation_session_overlaps`.',
    }),
    endDate: calendarDateSchema.meta({
      description:
        'The date the statement closes, and the date every balance on this session is computed as ' +
        'at. A line dated after it cannot be cleared into this session.',
    }),
    state: reconciliationSessionStateSchema,
    balances: reconciliationBalancesSchema,
    clearedLineCount: z.int().min(0),
    unclearedLineCount: z
      .int()
      .min(0)
      .meta({
        description:
          'Statement lines in this window with no clearing. Zero is not required to finalise — the ' +
          'balances are what E5 tests — but a non-zero count with a zero `difference` is worth a ' +
          'second look, because it usually means two errors cancelling.',
      }),
    finalisedAt: z.iso.datetime().nullable(),
    events: z.array(reconciliationSessionEventSchema).meta({
      description: 'Every open, finalise and reopen, oldest first. Append-only (E6).',
    }),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({
    id: 'ReconciliationSession',
    description:
      'A reconciliation session as the API returns it — with its event log. No `periodId` and no ' +
      'field a fiscal-period close writes: the session lock is not the period’s (E7).',
  });

export type ReconciliationSession = z.infer<typeof reconciliationSessionSchema>;

/**
 * Opens a session.
 *
 * `startDate` is derived — the day after the previous session's `endDate`, or the
 * account's earliest line for the first one — and is not stored (there is no
 * `start_date` column; a session records only its `end_date`). It is accepted on the
 * request as an *assertion*: a supplied value that disagrees with the derived start is
 * `reconciliation_session_overlaps`, which catches a client that thinks it is opening a
 * window the account has already reconciled past. Omitting it means "carry on from the
 * last one", which is what every session wants.
 *
 * Deliberately not an override: truncating an account's first session to skip years of
 * pre-OpenBooks history is an onboarding concern (it needs an opening balance the
 * ledger cannot supply), and belongs with M7's historical import rather than here.
 * Supplying a later start does not persist one.
 */
export const createReconciliationSessionRequestSchema = z
  .strictObject({
    bankAccountId: z.uuid(),
    startDate: calendarDateSchema.nullish(),
    endDate: calendarDateSchema,
    statementClosingBalance: minorUnitsSchema.meta({
      description: 'What the statement says the account held at `endDate`. The claim being tested.',
    }),
  })
  .refine(
    (input) =>
      input.startDate === undefined || input.startDate === null || input.startDate <= input.endDate,
    { error: 'The session ends before it starts.', path: ['endDate'] },
  )
  .meta({
    id: 'CreateReconciliationSessionRequest',
    description:
      'Opens a session. `startDate` is derived (carry on from the last session) and is accepted ' +
      'only as an assertion — a value disagreeing with the derived start is ' +
      '`reconciliation_session_overlaps`.',
  });

export type CreateReconciliationSessionRequest = z.infer<
  typeof createReconciliationSessionRequestSchema
>;

/**
 * Corrects an open session's own inputs — the two things a person types and can
 * mistype.
 *
 * Both are refused once the session is finalised
 * (`reconciliation_session_already_finalised`): the assertion was made against these
 * figures, and changing them afterwards would change what was asserted without
 * anything recording that it happened. The way back is a reopen, which is
 * permission-gated and leaves an event (E6).
 */
export const updateReconciliationSessionRequestSchema = z
  .strictObject({
    endDate: calendarDateSchema.optional(),
    statementClosingBalance: minorUnitsSchema.optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: 'Supply at least one field to change.',
  })
  .meta({
    id: 'UpdateReconciliationSessionRequest',
    description:
      'Corrects an open session’s own inputs — its end date and the closing balance it is tested ' +
      'against. Both are refused once finalised (`reconciliation_session_already_finalised`); the ' +
      'way back is a reopen.',
  });

export type UpdateReconciliationSessionRequest = z.infer<
  typeof updateReconciliationSessionRequestSchema
>;

/**
 * There is no finalise request schema, and that is deliberate.
 *
 * Finalising takes no fields: the date, the closing balance and the cleared lines
 * are all on the session already, and the actor comes from the session context and
 * never from the request. `invoices.ts` makes the same argument about approval, and
 * the risk is the same one — "a body with nothing in it would invite a field to be
 * added, and the first field anyone would add" here is the one that lets a client
 * finalise against a balance the session was not built from.
 *
 * Reopening is the opposite: it takes exactly one field, and it is required. E6 asks
 * for a record of who and when; who and when are available without asking, and why
 * is not.
 */
export const reopenReconciliationSessionRequestSchema = z
  .strictObject({
    reason: z
      .string()
      .trim()
      .min(1)
      .max(RECONCILIATION_REASON_MAX_LENGTH)
      .meta({
        description:
          'Why this finalised session is being reopened. Required, and kept on the event — the one ' +
          'part of E6’s record that cannot be reconstructed afterwards.',
      }),
  })
  .meta({
    id: 'ReopenReconciliationSessionRequest',
    description:
      'Reopens a finalised session. Takes exactly one field, `reason`, and it is required (E6) — ' +
      'who and when are known without asking; why is not.',
  });

export type ReopenReconciliationSessionRequest = z.infer<
  typeof reopenReconciliationSessionRequestSchema
>;

export const listReconciliationSessionsQuerySchema = z
  .strictObject({
    ...pageQueryShape,
    ...bankDateRangeShape,
    bankAccountId: z.uuid().optional(),
    state: reconciliationSessionStateSchema.optional(),
  })
  .refine(isOrderedRange, { error: 'The range ends before it starts.', path: ['to'] });

/** The *input* type: `limit` carries a `.default()`, so parsed output differs. */
export type ListReconciliationSessionsQuery = z.input<typeof listReconciliationSessionsQuerySchema>;

/**
 * A session in a list: everything except the event log.
 *
 * The events stay off for `invoiceSummarySchema`'s reason — embedding them would
 * make one page's size depend on how many times an org's sessions happen to have
 * been reopened. The balances stay, because a session list that could not show
 * whether each one balanced would be a list nobody could use.
 */
export const reconciliationSessionSummarySchema = reconciliationSessionSchema
  .omit({ events: true })
  .meta({
    id: 'ReconciliationSessionSummary',
    description:
      'A session in a list: everything except the event log, whose length would otherwise decide ' +
      'a page’s size. The balances stay — a list that could not show whether each one balanced ' +
      'would be unusable.',
  });

export type ReconciliationSessionSummary = z.infer<typeof reconciliationSessionSummarySchema>;

/** Ordered by `(end_date, id)` — a statement history is read newest last, by date. */
export const reconciliationSessionPageSchema = pageSchema(reconciliationSessionSummarySchema, {
  id: 'ReconciliationSessionPage',
  description: 'One page of the org’s reconciliation sessions, by end date.',
});

export type ReconciliationSessionPage = z.infer<typeof reconciliationSessionPageSchema>;
