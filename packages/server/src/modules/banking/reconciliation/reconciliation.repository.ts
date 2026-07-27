import { BANKING_RESOURCES } from '@openbooks/shared-types';

import type { RequestContext } from '../../../context';
import type { KeysetPage, TenantDatabase } from '../../../db';
import {
  applyKeyset,
  calendarDateKey,
  orgScope as toOrgId,
  tenantDb,
  toKeysetPage,
  uuidKey,
} from '../../../db';
import type { KeysetOrdering } from '../../../db';

/**
 * Data access for reconciliation sessions and their events (OB-082; ROADMAP D-45,
 * D-46, D-50, D-51; acceptance E5, E6, E7, E9).
 *
 * Everything reads and writes through `tenantDb`, so `org_id = ctx.orgId` is on every
 * statement before this file adds a predicate — a cross-org id is a miss, not a leak
 * (E9), and the service's `assertFound` turns the miss into the one 404 it may make.
 *
 * ## Why the session row is the lock, and it is the only thing that can be
 *
 * `reconciliation_sessions` is in the mutable grant list (wave 0), so the app user may
 * take a `SELECT … FOR UPDATE` on it — `selectSessionForUpdate`. That is the whole of
 * how two finalisers of one account serialize: neither `bank_statement_lines` nor
 * `journals` can be locked, because both are append-only and MySQL grants a locking
 * read only to an identity that holds `UPDATE`/`DELETE` (D-14). So the lock is the
 * session row, exactly as the journal sequence counter is its own row for the same
 * reason, and `reconciliation.race.test.ts` proves it under two connections.
 *
 * ## Every figure but the statement's own is computed here on read (D-46)
 *
 * The session stores `statement_closing_balance_minor` and nothing else about money.
 * `openingBalance`, `clearedBalance`, `bookBalance` and the counts are `SUM`s and
 * `COUNT`s taken at the moment they are asked for, which is D-34 and D-46 applied to a
 * reconciliation: a cached reconciliation balance is a number that goes stale the
 * first time a clearing is removed.
 *
 * ## `start_date` is not a column, so it is derived (`deriveStartDate`)
 *
 * `reconciliation_sessions` has an `end_date` and no `start_date`: a session's start is
 * the day after the previous session's `end_date`, or the account's earliest statement
 * line for the first one (`reconciliationSessionSchema.startDate`). Both of those are
 * already stored — sibling sessions' end dates and the lines themselves — so the start
 * is reproducible on every read without a column that could disagree with them.
 */

export const RECONCILIATION_SESSION_RESOURCE = BANKING_RESOURCES.RECONCILIATION_SESSION;
export const BANK_ACCOUNT_RESOURCE = BANKING_RESOURCES.BANK_ACCOUNT;

export function orgScope(ctx: RequestContext): TenantDatabase {
  return tenantDb(toOrgId(ctx.orgId));
}

// ---------------------------------------------------------------------------
// Calendar arithmetic
// ---------------------------------------------------------------------------

const MILLISECONDS_PER_DAY = 86_400_000;

/**
 * The day after a `YYYY-MM-DD` date, in UTC.
 *
 * A calendar date has no timezone — the codegen maps a MySQL `DATE` to `string`
 * (`src/db/migrations/README.md`) precisely so a local-midnight `Date` cannot invent
 * one — so this shifts in UTC, where `+ one day` is exactly one day at every date.
 * Restated here rather than reached for out of `matching/dates.ts`, following that
 * file's own note: a module does not import a sibling's six-line date helper.
 */
export function dayAfter(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined || Number.isNaN(day)) {
    // A stored `DATE` and `calendarDateSchema` have both parsed this already; a
    // malformed value here is a fault in this process, not input.
    throw new Error(`A calendar date was not in YYYY-MM-DD form: ${date}`);
  }
  const shifted = new Date(Date.UTC(year, month - 1, day) + MILLISECONDS_PER_DAY);
  return shifted.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// The session row
// ---------------------------------------------------------------------------

export interface SessionRow {
  readonly id: Buffer;
  readonly bank_account_id: Buffer;
  readonly end_date: string;
  readonly statement_closing_balance_minor: bigint;
  readonly state: 'in_progress' | 'finalised';
  readonly finalised_at: Date | null;
  readonly created_by_user_id: Buffer;
  readonly created_at: Date;
  readonly updated_at: Date;
}

const SESSION_COLUMNS = [
  'id',
  'bank_account_id',
  'end_date',
  'statement_closing_balance_minor',
  'state',
  'finalised_at',
  'created_by_user_id',
  'created_at',
  'updated_at',
] as const;

export async function selectSessionById(
  db: TenantDatabase,
  id: Buffer,
): Promise<SessionRow | undefined> {
  return db
    .selectFrom('reconciliation_sessions')
    .select(SESSION_COLUMNS)
    .where('id', '=', id)
    .executeTakeFirst();
}

/**
 * The session row, locked for the duration of the transaction.
 *
 * This is the serialization point for finalise and reopen. `reconciliation_sessions`
 * being mutable is what makes the locking read expressible at all (D-14); every other
 * table a finalise touches is append-only and cannot be locked, so two finalisers race
 * on this one row and the loser reads the state the winner left.
 */
export async function selectSessionForUpdate(
  db: TenantDatabase,
  id: Buffer,
): Promise<SessionRow | undefined> {
  return db
    .selectFrom('reconciliation_sessions')
    .select(SESSION_COLUMNS)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
}

export interface BankAccountRow {
  /** The bank account's own ledger account — the frame every balance is computed in. */
  readonly account_id: Buffer;
  readonly is_active: number;
}

export async function selectBankAccount(
  db: TenantDatabase,
  id: Buffer,
): Promise<BankAccountRow | undefined> {
  return db
    .selectFrom('bank_accounts')
    .select(['account_id', 'is_active'])
    .where('id', '=', id)
    .executeTakeFirst();
}

export interface NewSessionRow {
  readonly id: Buffer;
  readonly bankAccountId: Buffer;
  readonly endDate: string;
  readonly statementClosingBalance: bigint;
  readonly createdByUserId: Buffer;
}

export async function insertSession(db: TenantDatabase, row: NewSessionRow): Promise<void> {
  await db
    .insertInto('reconciliation_sessions')
    .values({
      id: row.id,
      bank_account_id: row.bankAccountId,
      end_date: row.endDate,
      statement_closing_balance_minor: row.statementClosingBalance,
      // `state` defaults to 'in_progress' and `open_marker` is generated from it, so a
      // second open session on this account collides on `uq_reconciliation_sessions_open`
      // — surfaced by the service as `bank_account_has_open_session`.
      created_by_user_id: row.createdByUserId,
    })
    .execute();
}

export interface SessionPatch {
  readonly endDate?: string;
  readonly statementClosingBalance?: bigint;
}

export async function updateSessionRow(
  db: TenantDatabase,
  id: Buffer,
  patch: SessionPatch,
): Promise<void> {
  await db
    .updateTable('reconciliation_sessions')
    .set({
      ...(patch.endDate === undefined ? {} : { end_date: patch.endDate }),
      ...(patch.statementClosingBalance === undefined
        ? {}
        : { statement_closing_balance_minor: patch.statementClosingBalance }),
    })
    .where('id', '=', id)
    .execute();
}

/**
 * Marks a session finalised. `finalised_at` and `state` move together — `chk_rs_finalised`
 * refuses one without the other — and setting `state` to 'finalised' recomputes
 * `open_marker` to NULL, which is what frees the account for the next session.
 */
export async function markFinalised(db: TenantDatabase, id: Buffer): Promise<void> {
  await db
    .updateTable('reconciliation_sessions')
    .set({ state: 'finalised', finalised_at: new Date() })
    .where('id', '=', id)
    .execute();
}

/**
 * Marks a session open again (the reopen). `open_marker` recomputes to the bank account
 * id, so if a later session on the account is already open this UPDATE collides on
 * `uq_reconciliation_sessions_open` — the service translates that to
 * `bank_account_has_open_session`.
 */
export async function markReopened(db: TenantDatabase, id: Buffer): Promise<void> {
  await db
    .updateTable('reconciliation_sessions')
    .set({ state: 'in_progress', finalised_at: null })
    .where('id', '=', id)
    .execute();
}

// ---------------------------------------------------------------------------
// Deriving the start date, and the overlap it enforces
// ---------------------------------------------------------------------------

/**
 * The largest `end_date` of another session on this account below `endDate`, or
 * undefined when this is the first. `excludeId` keeps a session from being its own
 * predecessor when the start of an existing session is being derived on read.
 */
export async function selectPriorEndDate(
  db: TenantDatabase,
  bankAccountId: Buffer,
  endDate: string,
  excludeId?: Buffer,
): Promise<string | undefined> {
  let query = db
    .selectFrom('reconciliation_sessions')
    .where('bank_account_id', '=', bankAccountId)
    .where('end_date', '<', endDate);
  if (excludeId !== undefined) query = query.where('id', '<>', excludeId);
  const row = await query.select((eb) => eb.fn.max('end_date').as('max_end')).executeTakeFirst();
  return row?.max_end ?? undefined;
}

/** The smallest `end_date` of another session on this account at or above `endDate`. */
export async function selectNextEndDate(
  db: TenantDatabase,
  bankAccountId: Buffer,
  endDate: string,
  excludeId?: Buffer,
): Promise<string | undefined> {
  let query = db
    .selectFrom('reconciliation_sessions')
    .where('bank_account_id', '=', bankAccountId)
    .where('end_date', '>=', endDate);
  if (excludeId !== undefined) query = query.where('id', '<>', excludeId);
  const row = await query.select((eb) => eb.fn.min('end_date').as('min_end')).executeTakeFirst();
  return row?.min_end ?? undefined;
}

/** The account's earliest statement line date — the start of the first session. */
export async function selectEarliestLineDate(
  db: TenantDatabase,
  bankAccountId: Buffer,
): Promise<string | undefined> {
  const row = await db
    .selectFrom('bank_statement_lines')
    .where('bank_account_id', '=', bankAccountId)
    .select((eb) => eb.fn.min('posted_date').as('min_date'))
    .executeTakeFirst();
  return row?.min_date ?? undefined;
}

/**
 * A session's start date: the day after the previous session's `end_date`, else the
 * account's earliest statement line, else `endDate` itself (a first session on an
 * account with no lines yet — a degenerate one-day window, never below its end).
 */
export async function deriveStartDate(
  db: TenantDatabase,
  bankAccountId: Buffer,
  endDate: string,
  excludeId?: Buffer,
): Promise<string> {
  const priorEnd = await selectPriorEndDate(db, bankAccountId, endDate, excludeId);
  if (priorEnd !== undefined) return dayAfter(priorEnd);
  return (await selectEarliestLineDate(db, bankAccountId)) ?? endDate;
}

// ---------------------------------------------------------------------------
// The balances, all computed on read
// ---------------------------------------------------------------------------

export interface WindowTotals {
  readonly sum: bigint;
  readonly count: number;
}

/**
 * The clearings this **open** session gathers by date: on this account, line dated in
 * `[startDate, endDate]`, and claimed by no finalised session.
 *
 * A stamped clearing (`reconciliation_session_id IS NOT NULL`) is only ever stamped by
 * a finalised session (D-51), so "no finalised session has claimed it" is exactly
 * `reconciliation_session_id IS NULL`. The signed `cleared_amount_minor` is summed in
 * the same frame the statement line carries (D-13), so the total needs no conditional.
 */
export async function clearedInWindow(
  db: TenantDatabase,
  bankAccountId: Buffer,
  startDate: string,
  endDate: string,
): Promise<WindowTotals> {
  const row = await db
    .selectFrom('bank_line_clearings')
    .innerJoin('bank_statement_lines', (join) =>
      join
        .onRef('bank_statement_lines.id', '=', 'bank_line_clearings.statement_line_id')
        .onRef('bank_statement_lines.org_id', '=', 'bank_line_clearings.org_id'),
    )
    .where('bank_statement_lines.bank_account_id', '=', bankAccountId)
    .where('bank_statement_lines.posted_date', '>=', startDate)
    .where('bank_statement_lines.posted_date', '<=', endDate)
    .where('bank_line_clearings.reconciliation_session_id', 'is', null)
    .select((eb) => [
      eb.fn
        .coalesce(eb.fn.sum<bigint>('bank_line_clearings.cleared_amount_minor'), eb.lit(0))
        .as('sum'),
      eb.fn.countAll<string | number | bigint>().as('count'),
    ])
    .executeTakeFirst();

  return { sum: BigInt(row?.sum ?? 0), count: Number(row?.count ?? 0) };
}

/**
 * The clearings a **finalised** session claimed, frozen by its stamp (D-51).
 *
 * At finalisation the covered set is stamped onto exactly the window members, so once
 * finalised a session's membership is `reconciliation_session_id = this.id` and no
 * longer a date query — a clearing entered afterwards cannot change what the assertion
 * covered.
 */
export async function clearedStamped(db: TenantDatabase, sessionId: Buffer): Promise<WindowTotals> {
  const row = await db
    .selectFrom('bank_line_clearings')
    .where('reconciliation_session_id', '=', sessionId)
    .select((eb) => [
      eb.fn.coalesce(eb.fn.sum<bigint>('cleared_amount_minor'), eb.lit(0)).as('sum'),
      eb.fn.countAll<string | number | bigint>().as('count'),
    ])
    .executeTakeFirst();

  return { sum: BigInt(row?.sum ?? 0), count: Number(row?.count ?? 0) };
}

/**
 * The opening balance: every clearing on this account already claimed by a finalised
 * session whose window closed before this one starts.
 *
 * By induction this equals the previous session's `clearedBalance` — its opening plus
 * its stamped clearings, telescoping back to zero on the first session. A stamped
 * clearing is a member of the finalised session that stamped it, whose window ends at
 * or before that session's `end_date`; a prior session's window is entirely before
 * `startDate`, so "stamped and dated before `startDate`" is exactly "belongs to a
 * prior finalised session" and needs no join back to the sessions table.
 */
export async function openingBalance(
  db: TenantDatabase,
  bankAccountId: Buffer,
  startDate: string,
): Promise<bigint> {
  const row = await db
    .selectFrom('bank_line_clearings')
    .innerJoin('bank_statement_lines', (join) =>
      join
        .onRef('bank_statement_lines.id', '=', 'bank_line_clearings.statement_line_id')
        .onRef('bank_statement_lines.org_id', '=', 'bank_line_clearings.org_id'),
    )
    .where('bank_statement_lines.bank_account_id', '=', bankAccountId)
    .where('bank_statement_lines.posted_date', '<', startDate)
    .where('bank_line_clearings.reconciliation_session_id', 'is not', null)
    .select((eb) =>
      eb.fn
        .coalesce(eb.fn.sum<bigint>('bank_line_clearings.cleared_amount_minor'), eb.lit(0))
        .as('sum'),
    )
    .executeTakeFirst();

  return BigInt(row?.sum ?? 0);
}

/**
 * The ledger account's balance at `endDate`, in the statement's frame (D-46).
 *
 * `SUM(debit) − SUM(credit)` over the bank ledger account's journal lines up to and
 * including `endDate` — positive when money is in the account, the same frame a
 * statement line's signed amount uses and the same one `journalBankMovement` computes a
 * clearing in. That shared frame is what makes `unclearedAmount = bookBalance −
 * clearedBalance` a plain subtraction. Reported, never asserted: an unpresented cheque
 * is a real entry the bank has not shown, and finalising tests the *cleared* balance,
 * not this one (D-50).
 */
export async function bookBalance(
  db: TenantDatabase,
  bankLedgerAccountId: Buffer,
  endDate: string,
): Promise<bigint> {
  const row = await db
    .selectFrom('journal_lines')
    .innerJoin('journals', (join) =>
      join
        .onRef('journals.id', '=', 'journal_lines.journal_id')
        .onRef('journals.org_id', '=', 'journal_lines.org_id'),
    )
    .where('journal_lines.account_id', '=', bankLedgerAccountId)
    .where('journals.entry_date', '<=', endDate)
    .select((eb) => [
      eb.fn.coalesce(eb.fn.sum<bigint>('journal_lines.debit_minor'), eb.lit(0)).as('debits'),
      eb.fn.coalesce(eb.fn.sum<bigint>('journal_lines.credit_minor'), eb.lit(0)).as('credits'),
    ])
    .executeTakeFirst();

  return BigInt(row?.debits ?? 0) - BigInt(row?.credits ?? 0);
}

/**
 * Statement lines in `[startDate, endDate]` on this account carrying no clearing at all
 * — the "second look" count (`reconciliationSessionSchema.unclearedLineCount`). A
 * left join to clearings and a NULL test, so a line with no matching clearing row is
 * the one counted.
 */
export async function unclearedLineCount(
  db: TenantDatabase,
  bankAccountId: Buffer,
  startDate: string,
  endDate: string,
): Promise<number> {
  const row = await db
    .selectFrom('bank_statement_lines')
    .leftJoin('bank_line_clearings', (join) =>
      join
        .onRef('bank_line_clearings.statement_line_id', '=', 'bank_statement_lines.id')
        .onRef('bank_line_clearings.org_id', '=', 'bank_statement_lines.org_id'),
    )
    .where('bank_statement_lines.bank_account_id', '=', bankAccountId)
    .where('bank_statement_lines.posted_date', '>=', startDate)
    .where('bank_statement_lines.posted_date', '<=', endDate)
    .where('bank_line_clearings.id', 'is', null)
    .select((eb) => eb.fn.countAll<string | number | bigint>().as('count'))
    .executeTakeFirst();

  return Number(row?.count ?? 0);
}

// ---------------------------------------------------------------------------
// The membership stamp (D-51)
// ---------------------------------------------------------------------------

/**
 * Freezes a finalising session's membership: stamps `reconciliation_session_id` onto
 * exactly the window members it just asserted over — this account, line dated in
 * `[startDate, endDate]`, not already claimed.
 *
 * `reconciliation_session_id` is the only column this service updates on
 * `bank_line_clearings` (D-51), which is mutable (wave 0) precisely so this UPDATE is
 * permitted. The window is expressed as a scoped sub-select on the lines, so the org
 * predicate `tenantDb` adds is on both the UPDATE and the sub-select.
 */
export async function stampMembership(
  db: TenantDatabase,
  bankAccountId: Buffer,
  startDate: string,
  endDate: string,
  sessionId: Buffer,
): Promise<void> {
  const windowLines = db
    .selectFrom('bank_statement_lines')
    .select('id')
    .where('bank_account_id', '=', bankAccountId)
    .where('posted_date', '>=', startDate)
    .where('posted_date', '<=', endDate);

  await db
    .updateTable('bank_line_clearings')
    .set({ reconciliation_session_id: sessionId })
    .where('reconciliation_session_id', 'is', null)
    .where('statement_line_id', 'in', windowLines)
    .execute();
}

/**
 * Un-freezes a reopened session's membership: sets `reconciliation_session_id` back to
 * NULL on the clearings this session had stamped, so the corrected session re-gathers
 * its set by date the way an open session does (D-51). This is D-42's argument applied
 * to an assertion — a record whose meaning can be rewritten records nothing, and the
 * logged reopen is the sanctioned way to change it.
 */
export async function unstampMembership(db: TenantDatabase, sessionId: Buffer): Promise<void> {
  await db
    .updateTable('bank_line_clearings')
    .set({ reconciliation_session_id: null })
    .where('reconciliation_session_id', '=', sessionId)
    .execute();
}

// ---------------------------------------------------------------------------
// Events (E6)
// ---------------------------------------------------------------------------

export interface EventRow {
  readonly id: Buffer;
  readonly event_type: 'finalised' | 'reopened';
  readonly asserted_balance_minor: bigint | null;
  readonly reason: string | null;
  readonly created_by_user_id: Buffer;
  readonly created_at: Date;
}

/** A session's events oldest-first, matching `idx_rse_org_session` (E6). */
export async function selectEvents(
  db: TenantDatabase,
  sessionId: Buffer,
): Promise<readonly EventRow[]> {
  return db
    .selectFrom('reconciliation_session_events')
    .select([
      'id',
      'event_type',
      'asserted_balance_minor',
      'reason',
      'created_by_user_id',
      'created_at',
    ])
    .where('session_id', '=', sessionId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
}

export interface NewEventRow {
  readonly id: Buffer;
  readonly sessionId: Buffer;
  readonly type: 'finalised' | 'reopened';
  readonly assertedBalance: bigint | null;
  readonly reason: string | null;
  readonly createdByUserId: Buffer;
}

/**
 * Appends one event. `chk_rse_balance` pairs the shape to the type — a finalise carries
 * the figure it asserted and no reason, a reopen carries a reason and no figure — so a
 * row built in the wrong shape is refused by the database, not only by this code.
 */
export async function insertEvent(db: TenantDatabase, row: NewEventRow): Promise<void> {
  await db
    .insertInto('reconciliation_session_events')
    .values({
      id: row.id,
      session_id: row.sessionId,
      event_type: row.type,
      asserted_balance_minor: row.assertedBalance,
      reason: row.reason,
      created_by_user_id: row.createdByUserId,
    })
    .execute();
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

const SESSION_KEYSET: KeysetOrdering<SessionRow> = [
  calendarDateKey('reconciliation_sessions.end_date', (row) => row.end_date),
  uuidKey('reconciliation_sessions.id', (row) => row.id),
];

export interface SessionFilters {
  readonly bankAccountId?: Buffer | undefined;
  readonly state?: 'in_progress' | 'finalised' | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly cursor?: string | undefined;
}

/** One page of the org's sessions, `(end_date, id)` — a statement history read by date. */
export async function selectSessionsPage(
  db: TenantDatabase,
  filters: SessionFilters,
  limit: number,
): Promise<KeysetPage<SessionRow>> {
  let query = db.selectFrom('reconciliation_sessions').select(SESSION_COLUMNS);

  if (filters.bankAccountId !== undefined) {
    query = query.where('bank_account_id', '=', filters.bankAccountId);
  }
  if (filters.state !== undefined) query = query.where('state', '=', filters.state);
  if (filters.from !== undefined) query = query.where('end_date', '>=', filters.from);
  if (filters.to !== undefined) query = query.where('end_date', '<=', filters.to);

  const rows = await applyKeyset(query, SESSION_KEYSET, limit, filters.cursor).execute();
  return toKeysetPage(rows, SESSION_KEYSET, limit);
}
