import type {
  CreateReconciliationSessionRequest,
  ListReconciliationSessionsQuery,
  ReconciliationBalances,
  ReconciliationSession,
  ReconciliationSessionEvent,
  ReconciliationSessionPage,
  ReconciliationSessionState,
  ReconciliationSessionSummary,
  ReopenReconciliationSessionRequest,
  UpdateReconciliationSessionRequest,
} from '@openbooks/shared-types';
import {
  BANKING_PRECONDITIONS,
  createReconciliationSessionRequestSchema,
  listReconciliationSessionsQuerySchema,
  reopenReconciliationSessionRequestSchema,
  updateReconciliationSessionRequestSchema,
} from '@openbooks/shared-types';

import { getContext, type RequestContext } from '../../../context';
import {
  bufferToUuid,
  isDuplicateEntryError,
  newUuidBuffer,
  resolvePageLimit,
  tryUuidToBuffer,
} from '../../../db';
import type { TenantDatabase } from '../../../db';
import {
  assertFound,
  InternalError,
  parseInput,
  PreconditionFailedError,
  ValidationError,
} from '../../../errors';
import { requirePermission } from '../../permissions';

import {
  BANK_ACCOUNT_RESOURCE,
  bookBalance,
  clearedInWindow,
  clearedStamped,
  dayAfter,
  deriveStartDate,
  insertEvent,
  insertSession,
  markFinalised,
  markReopened,
  openingBalance,
  orgScope,
  RECONCILIATION_SESSION_RESOURCE as RESOURCE,
  selectBankAccount,
  selectEarliestLineDate,
  selectEvents,
  selectNextEndDate,
  selectPriorEndDate,
  selectSessionById,
  selectSessionForUpdate,
  selectSessionsPage,
  stampMembership,
  unclearedLineCount,
  unstampMembership,
  updateSessionRow,
  type EventRow,
  type SessionFilters,
  type SessionRow,
} from './reconciliation.repository';

/**
 * Reconciliation sessions, and the reopen (OB-082; ROADMAP D-45, D-46, D-50, D-51;
 * acceptance E5, E6, E7, E9).
 *
 * A session names a bank account, an end date and the statement's closing balance;
 * lines are cleared into it until the *cleared* balance equals that figure, and
 * finalising records the assertion. It is the moment the books and the bank are stated
 * to have agreed, and it is the whole reason the rest of M4 exists.
 *
 * ## What finalising asserts, and what it deliberately does not (D-50, E5)
 *
 * Finalising refuses unless `clearedBalance === statementClosingBalance`
 * (`reconciliation_session_balance_mismatch`, with the `difference` telling the user how
 * far off). It asserts the **cleared** balance — the opening balance plus the lines
 * cleared into this session — and *not* the book balance. An unpresented cheque is a
 * real ledger entry the bank has not yet shown, so it widens `bookBalance` and
 * `unclearedAmount` but is a reconciling difference, never a blocker. `bookBalance` is
 * reported for exactly that reason and asserted against nothing.
 *
 * ## The two locks are independent, and nothing here couples them (E7)
 *
 * There is no `periodId`, no fiscal-period read, and no field a period close writes.
 * A reconciliation says "the bank agreed with us"; a period close says "we are done
 * changing this month" — different assertions on different cadences (D-45). The two meet
 * in exactly one place, and it is not here: clearing a line posts a journal that must
 * land in an open period, which is clearing's concern (OB-081), already handled.
 * `reconciliation.independence.test.ts` proves a finalise touches no period state and a
 * locked period touches no session.
 *
 * ## Membership is frozen at finalisation and thawed at reopen (D-51)
 *
 * While a session is open its membership is a date query — the clearings on this account
 * dated in `[startDate, endDate]` that no finalised session has claimed. At finalisation
 * those exact clearings are stamped with the session id (`stampMembership`), snapshotting
 * what the assertion covered so a clearing entered afterwards cannot rewrite it. Reopen
 * un-stamps them (`unstampMembership`) so the corrected session re-gathers its set. This
 * is D-42's argument applied to an assertion, and reopen is the sanctioned, logged way to
 * change what was asserted.
 *
 * ## Serialization is the session row, because it is the only thing that can be (D-14)
 *
 * Two people finalising one account race, and the append-only line and journal tables
 * cannot be locked. So finalise and reopen take the session row `FOR UPDATE`
 * (`selectSessionForUpdate`); the loser blocks until the winner commits and then reads
 * the state the winner left — `already_finalised` for a second finalise. Proven under two
 * real connections in `reconciliation.race.test.ts`, because a sequential simulation would
 * pass against code with no lock at all.
 *
 * ## Permissions this module enforces
 *
 * open, get, list, update and finalise gate on `banking.reconcile`; reopen on
 * `banking.reopen` (E6 — reopening is a distinct, higher authority). Both are latent
 * until this service, exactly as OB-078 took `banking.import` live and OB-080 took
 * `banking.match` live; the permission matrix is reconciled once, elsewhere.
 */

// ---------------------------------------------------------------------------
// State mapping — the DB enum and the wire enum disagree by design
// ---------------------------------------------------------------------------

/**
 * `reconciliation_sessions.state` is `('in_progress','finalised')`; the wire contract's
 * is `('open','finalised')`. The two name the same two states — a reopened session is
 * `open` again, with the history in the events (`reconciliationSessionStateSchema`) — so
 * this is the one translation between them.
 */
function dbStateToWire(state: SessionRow['state']): ReconciliationSessionState {
  return state === 'finalised' ? 'finalised' : 'open';
}

function wireStateToDb(state: ReconciliationSessionState): SessionRow['state'] {
  return state === 'finalised' ? 'finalised' : 'in_progress';
}

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

export async function createReconciliationSession(
  input: CreateReconciliationSessionRequest,
  ctx: RequestContext = getContext('createReconciliationSession()'),
): Promise<ReconciliationSession> {
  await requirePermission(ctx, 'banking.reconcile');

  const request = parseInput(createReconciliationSessionRequestSchema, input);
  const author = requireReconcilingUser(ctx);
  const bankAccountId = assertFound(tryUuidToBuffer(request.bankAccountId), BANK_ACCOUNT_RESOURCE);

  return orgScope(ctx).transaction(async (trx) => {
    assertFound(await selectBankAccount(trx, bankAccountId), BANK_ACCOUNT_RESOURCE);

    // A session reconciles forward: its end date must fall after every session already
    // on the account. An end date on or before an existing one would re-assert a window
    // a prior session already covered (D-45) — `reconciliation_session_overlaps`.
    const priorEnd = await selectPriorEndDate(trx, bankAccountId, request.endDate);
    if ((await selectNextEndDate(trx, bankAccountId, request.endDate)) !== undefined) {
      throw overlaps();
    }

    const derivedStart =
      priorEnd !== undefined
        ? dayAfter(priorEnd)
        : ((await selectEarliestLineDate(trx, bankAccountId)) ?? request.endDate);

    // `startDate` has no column to be stored in, so a supplied one is a validation
    // assertion rather than an override: it must equal the derived start, or the window
    // disagrees with a prior session's boundary (`createReconciliationSessionRequestSchema`).
    if (
      request.startDate !== undefined &&
      request.startDate !== null &&
      request.startDate !== derivedStart
    ) {
      throw overlaps();
    }

    const id = newUuidBuffer();
    try {
      await insertSession(trx, {
        id,
        bankAccountId,
        endDate: request.endDate,
        statementClosingBalance: BigInt(request.statementClosingBalance),
        createdByUserId: author,
      });
    } catch (error: unknown) {
      // `uq_reconciliation_sessions_open` on the generated `open_marker`: a second open
      // session on this account. One open reconciliation per account, or two people
      // clear the same lines into different assertions.
      if (isDuplicateEntryError(error)) throw hasOpenSession();
      throw error;
    }

    return readSession(trx, assertFoundAfterWrite(await selectSessionById(trx, id)));
  });
}

// ---------------------------------------------------------------------------
// Get / list
// ---------------------------------------------------------------------------

export async function getReconciliationSession(
  sessionId: string,
  ctx: RequestContext = getContext('getReconciliationSession()'),
): Promise<ReconciliationSession> {
  await requirePermission(ctx, 'banking.reconcile');

  const db = orgScope(ctx);
  const idBytes = assertFound(tryUuidToBuffer(sessionId), RESOURCE);
  const session = assertFound(await selectSessionById(db, idBytes), RESOURCE);
  return readSession(db, session);
}

/**
 * One page of the org's sessions in `(end_date, id)` order — a statement history read
 * by date, newest last (`reconciliationSessionPageSchema`). A malformed `bankAccountId`
 * filter answers with an empty page rather than a 404, matching `listBankRules`: an id
 * that resolves to nothing filters to nothing (E9).
 */
export async function listReconciliationSessions(
  query: ListReconciliationSessionsQuery,
  ctx: RequestContext = getContext('listReconciliationSessions()'),
): Promise<ReconciliationSessionPage> {
  await requirePermission(ctx, 'banking.reconcile');

  const filters = parseInput(listReconciliationSessionsQuerySchema, query);
  if (filters.bankAccountId !== undefined && tryUuidToBuffer(filters.bankAccountId) === undefined) {
    return { items: [], nextCursor: null };
  }

  const db = orgScope(ctx);
  const sessionFilters: SessionFilters = {
    ...(filters.bankAccountId === undefined
      ? {}
      : { bankAccountId: tryUuidToBuffer(filters.bankAccountId) }),
    ...(filters.state === undefined ? {} : { state: wireStateToDb(filters.state) }),
    ...(filters.from === undefined ? {} : { from: filters.from }),
    ...(filters.to === undefined ? {} : { to: filters.to }),
    ...(filters.cursor === undefined ? {} : { cursor: filters.cursor }),
  };

  const page = await selectSessionsPage(db, sessionFilters, resolvePageLimit(filters.limit));

  const items: ReconciliationSessionSummary[] = [];
  for (const row of page.rows) items.push(await toSummary(db, row));
  return { items, nextCursor: page.nextCursor };
}

// ---------------------------------------------------------------------------
// Update — the two inputs a person types, while open only
// ---------------------------------------------------------------------------

export async function updateReconciliationSession(
  sessionId: string,
  input: UpdateReconciliationSessionRequest,
  ctx: RequestContext = getContext('updateReconciliationSession()'),
): Promise<ReconciliationSession> {
  await requirePermission(ctx, 'banking.reconcile');

  const request = parseInput(updateReconciliationSessionRequestSchema, input);
  const idBytes = assertFound(tryUuidToBuffer(sessionId), RESOURCE);

  return orgScope(ctx).transaction(async (trx) => {
    const session = assertFound(await selectSessionForUpdate(trx, idBytes), RESOURCE);
    if (session.state === 'finalised') throw alreadyFinalised();

    if (request.endDate !== undefined && request.endDate !== session.end_date) {
      // A moved end date must keep the session between its neighbours — after the prior
      // session's end, before any later one's — or it overlaps an already-asserted window.
      const priorEnd = await selectPriorEndDate(
        trx,
        session.bank_account_id,
        request.endDate,
        session.id,
      );
      if (
        (await selectNextEndDate(trx, session.bank_account_id, request.endDate, session.id)) !==
        undefined
      ) {
        throw overlaps();
      }
      const derivedStart =
        priorEnd !== undefined
          ? dayAfter(priorEnd)
          : ((await selectEarliestLineDate(trx, session.bank_account_id)) ?? request.endDate);
      if (derivedStart > request.endDate) throw overlaps();
    }

    await updateSessionRow(trx, session.id, {
      ...(request.endDate === undefined ? {} : { endDate: request.endDate }),
      ...(request.statementClosingBalance === undefined
        ? {}
        : { statementClosingBalance: BigInt(request.statementClosingBalance) }),
    });

    return readSession(trx, assertFoundAfterWrite(await selectSessionById(trx, session.id)));
  });
}

// ---------------------------------------------------------------------------
// Finalise — the assertion (D-50, E5)
// ---------------------------------------------------------------------------

export async function finaliseReconciliationSession(
  sessionId: string,
  ctx: RequestContext = getContext('finaliseReconciliationSession()'),
): Promise<ReconciliationSession> {
  await requirePermission(ctx, 'banking.reconcile');

  const author = requireReconcilingUser(ctx);
  const idBytes = assertFound(tryUuidToBuffer(sessionId), RESOURCE);

  return orgScope(ctx).transaction(async (trx) => {
    // The lock. A second finaliser blocks here until this transaction commits, then
    // reads the `finalised` state below (D-14).
    const session = assertFound(await selectSessionForUpdate(trx, idBytes), RESOURCE);
    if (session.state === 'finalised') throw alreadyFinalised();

    const startDate = await deriveStartDate(
      trx,
      session.bank_account_id,
      session.end_date,
      session.id,
    );
    const clearedBalance =
      (await openingBalance(trx, session.bank_account_id, startDate)) +
      (await clearedInWindow(trx, session.bank_account_id, startDate, session.end_date)).sum;

    const statementClosing = session.statement_closing_balance_minor;
    const difference = statementClosing - clearedBalance;
    // D-50: the cleared balance, not the book balance. An unpresented cheque is in the
    // book balance and not this one, so it does not block.
    if (difference !== 0n) throw balanceMismatch(difference);

    // Freeze the covered set before flipping the state, so the stamp names exactly the
    // window this assertion measured (D-51).
    await stampMembership(trx, session.bank_account_id, startDate, session.end_date, session.id);
    await markFinalised(trx, session.id);
    await insertEvent(trx, {
      id: newUuidBuffer(),
      sessionId: session.id,
      type: 'finalised',
      assertedBalance: statementClosing,
      reason: null,
      createdByUserId: author,
    });

    return readSession(trx, assertFoundAfterWrite(await selectSessionById(trx, session.id)));
  });
}

// ---------------------------------------------------------------------------
// Reopen — permission-gated, logged, and it thaws membership (E6, D-51)
// ---------------------------------------------------------------------------

export async function reopenReconciliationSession(
  sessionId: string,
  input: ReopenReconciliationSessionRequest,
  ctx: RequestContext = getContext('reopenReconciliationSession()'),
): Promise<ReconciliationSession> {
  await requirePermission(ctx, 'banking.reopen');

  const request = parseInput(reopenReconciliationSessionRequestSchema, input);
  const author = requireReconcilingUser(ctx);
  const idBytes = assertFound(tryUuidToBuffer(sessionId), RESOURCE);

  return orgScope(ctx).transaction(async (trx) => {
    const session = assertFound(await selectSessionForUpdate(trx, idBytes), RESOURCE);
    if (session.state !== 'finalised') throw notFinalised();

    try {
      await markReopened(trx, session.id);
    } catch (error: unknown) {
      // Reopening makes this session open again; if a later session on the account is
      // already open, `open_marker` collides. One open per account still holds.
      if (isDuplicateEntryError(error)) throw hasOpenSession();
      throw error;
    }
    await unstampMembership(trx, session.id);
    await insertEvent(trx, {
      id: newUuidBuffer(),
      sessionId: session.id,
      type: 'reopened',
      assertedBalance: null,
      reason: request.reason,
      createdByUserId: author,
    });

    return readSession(trx, assertFoundAfterWrite(await selectSessionById(trx, session.id)));
  });
}

// ---------------------------------------------------------------------------
// Reading a session back — every figure computed here (D-46)
// ---------------------------------------------------------------------------

interface SessionFigures {
  readonly openingBalance: bigint;
  readonly clearedBalance: bigint;
  readonly statementClosingBalance: bigint;
  readonly difference: bigint;
  readonly bookBalance: bigint;
  readonly unclearedAmount: bigint;
  readonly clearedLineCount: number;
  readonly unclearedLineCount: number;
}

/**
 * The eight computed numbers. `clearedBalance` is the opening balance plus the session's
 * members — the frozen stamped set once finalised, the date window while open (D-51) —
 * and `bookBalance` is the ledger account at `endDate`. `unclearedAmount` is their
 * difference: exactly the entries the bank has not caught up with.
 */
async function computeFigures(
  db: TenantDatabase,
  session: SessionRow,
  startDate: string,
): Promise<SessionFigures> {
  const bankAccount = assertFound(
    await selectBankAccount(db, session.bank_account_id),
    BANK_ACCOUNT_RESOURCE,
  );

  const opening = await openingBalance(db, session.bank_account_id, startDate);
  const members =
    session.state === 'finalised'
      ? await clearedStamped(db, session.id)
      : await clearedInWindow(db, session.bank_account_id, startDate, session.end_date);

  const clearedBalance = opening + members.sum;
  const book = await bookBalance(db, bankAccount.account_id, session.end_date);
  const statementClosing = session.statement_closing_balance_minor;

  return {
    openingBalance: opening,
    clearedBalance,
    statementClosingBalance: statementClosing,
    difference: statementClosing - clearedBalance,
    bookBalance: book,
    unclearedAmount: book - clearedBalance,
    clearedLineCount: members.count,
    unclearedLineCount: await unclearedLineCount(
      db,
      session.bank_account_id,
      startDate,
      session.end_date,
    ),
  };
}

function toBalances(figures: SessionFigures): ReconciliationBalances {
  return {
    openingBalance: figures.openingBalance.toString(),
    clearedBalance: figures.clearedBalance.toString(),
    statementClosingBalance: figures.statementClosingBalance.toString(),
    difference: figures.difference.toString(),
    bookBalance: figures.bookBalance.toString(),
    unclearedAmount: figures.unclearedAmount.toString(),
  };
}

async function toSummary(
  db: TenantDatabase,
  session: SessionRow,
): Promise<ReconciliationSessionSummary> {
  const startDate = await deriveStartDate(
    db,
    session.bank_account_id,
    session.end_date,
    session.id,
  );
  const figures = await computeFigures(db, session, startDate);
  return {
    id: bufferToUuid(session.id),
    bankAccountId: bufferToUuid(session.bank_account_id),
    startDate,
    endDate: session.end_date,
    state: dbStateToWire(session.state),
    balances: toBalances(figures),
    clearedLineCount: figures.clearedLineCount,
    unclearedLineCount: figures.unclearedLineCount,
    finalisedAt: session.finalised_at === null ? null : session.finalised_at.toISOString(),
    createdAt: session.created_at.toISOString(),
    updatedAt: session.updated_at.toISOString(),
  };
}

async function readSession(
  db: TenantDatabase,
  session: SessionRow,
): Promise<ReconciliationSession> {
  const summary = await toSummary(db, session);
  const events = await selectEvents(db, session.id);
  return { ...summary, events: toWireEvents(session, events) };
}

/**
 * The event log, oldest first, with the `opened` event synthesized from the session's
 * own creation.
 *
 * The database's `reconciliation_session_events.event_type` is `('finalised','reopened')`
 * — there is no `opened` row, because the open is fully described by the session's
 * `created_at` and `created_by_user_id` and D-38 derives a fact it need not store. The
 * wire contract's event log opens with it (`reconciliationSessionSchema.events`), so it
 * is reconstructed here rather than persisted. Its id is the session's — a stable UUID,
 * distinct from every stored event's, identifying the one open this log can ever have.
 */
function toWireEvents(
  session: SessionRow,
  rows: readonly EventRow[],
): ReconciliationSessionEvent[] {
  const sessionUuid = bufferToUuid(session.id);
  const opened: ReconciliationSessionEvent = {
    id: sessionUuid,
    sessionId: sessionUuid,
    type: 'opened',
    reason: null,
    actorUserId: bufferToUuid(session.created_by_user_id),
    statementClosingBalance: null,
    occurredAt: session.created_at.toISOString(),
  };

  return [
    opened,
    ...rows.map((row) => ({
      id: bufferToUuid(row.id),
      sessionId: sessionUuid,
      type: row.event_type,
      reason: row.reason,
      actorUserId: bufferToUuid(row.created_by_user_id),
      statementClosingBalance:
        row.asserted_balance_minor === null ? null : row.asserted_balance_minor.toString(),
      occurredAt: row.created_at.toISOString(),
    })),
  ];
}

// ---------------------------------------------------------------------------
// Refusals and the recording user
// ---------------------------------------------------------------------------

function overlaps(): PreconditionFailedError {
  return new PreconditionFailedError(
    BANKING_PRECONDITIONS.RECONCILIATION_SESSION_OVERLAPS,
    'This session’s date window overlaps one already on the account. Sessions reconcile forward ' +
      'and do not overlap — an overlap would let one line be counted in two assertions (D-45). ' +
      'Its end date must fall after every existing session on this account.',
  );
}

function hasOpenSession(): PreconditionFailedError {
  return new PreconditionFailedError(
    BANKING_PRECONDITIONS.BANK_ACCOUNT_HAS_OPEN_SESSION,
    'This bank account already has a reconciliation session open. Finalise or reopen it before ' +
      'opening another — two open reconciliations on one account is two people clearing the same ' +
      'lines into different assertions.',
  );
}

function alreadyFinalised(): PreconditionFailedError {
  return new PreconditionFailedError(
    BANKING_PRECONDITIONS.RECONCILIATION_SESSION_ALREADY_FINALISED,
    'This session has been finalised, so its inputs can no longer be changed: the assertion was ' +
      'made against them. Reopen it first — reopening is permission-gated and leaves an event (E6).',
  );
}

function notFinalised(): PreconditionFailedError {
  return new PreconditionFailedError(
    BANKING_PRECONDITIONS.RECONCILIATION_SESSION_NOT_FINALISED,
    'This session is open, so there is nothing to reopen. Reopening is what turns a finalised ' +
      'session back into an open one.',
  );
}

function balanceMismatch(difference: bigint): PreconditionFailedError {
  return new PreconditionFailedError(
    BANKING_PRECONDITIONS.RECONCILIATION_SESSION_BALANCE_MISMATCH,
    `The cleared balance does not equal the statement’s closing balance: the difference is ` +
      `${difference.toString()} minor units (statement minus cleared). Finalising asserts that the ` +
      'two agree (E5). Clear the outstanding lines, or correct the closing balance, until the ' +
      'difference is zero. An unpresented cheque is *not* what this is — that is a reconciling ' +
      'difference in the book balance, not the cleared one, and it does not block.',
  );
}

/**
 * The user a session and its events are recorded by.
 *
 * `reconciliation_sessions.created_by_user_id` and `reconciliation_session_events`'
 * author are both `NOT NULL` references to `users`, so a caller with no user identity —
 * an automation acting outside a member session — has nothing to record as the person
 * who opened, finalised or reopened. `requireClearingUser` in clearing refuses the same
 * way for the same reason.
 */
function requireReconcilingUser(ctx: RequestContext): Buffer {
  const userId = ctx.userId === null ? undefined : tryUuidToBuffer(ctx.userId);
  if (userId === undefined) {
    throw new ValidationError('A reconciliation is performed by a user.', [
      {
        path: 'actor',
        message:
          'This caller has no user identity, so it cannot open, finalise or reopen a ' +
          'reconciliation. Each is a decision a person is recorded as making (E6).',
      },
    ]);
  }
  return userId;
}

function assertFoundAfterWrite(row: SessionRow | undefined): SessionRow {
  if (row === undefined) {
    throw new InternalError(
      'The reconciliation session just written could not be read back in its transaction.',
    );
  }
  return row;
}
