import { BANKING_RESOURCES } from '@openbooks/shared-types';

import type { RequestContext } from '../../../context';
import type { TenantDatabase } from '../../../db';
import { orgScope as toOrgId, tenantDb } from '../../../db';
import type { SubledgerSide } from '../../settings';

/**
 * Data access for `bank_line_clearings` and the rows a clearing reads to make its
 * decision (OB-081; ROADMAP D-43, D-16, acceptance E3, E4).
 *
 * Everything goes through `tenantDb`, so `org_id = ctx.orgId` is on every statement
 * before this file adds a predicate — a cross-org id is a miss, not a leak (E9), and
 * `assertFound` in the service turns the miss into the one 404 it may produce.
 *
 * ## What is append-only here, and why nothing locks it
 *
 * `bank_statement_lines` and `journals` are append-only at the grant level: the app
 * user holds no `UPDATE`/`DELETE` on them, and MySQL requires exactly those for a
 * `SELECT … FOR UPDATE` — so there is **no `forUpdate()` anywhere in this file**, and
 * there must not be, for the reason the journal sequence counter is its own table
 * (D-14). Two clearings racing the same line or the same journal are serialized
 * instead by the unique keys `uq_blc_line` and `uq_blc_journal` on insert: the loser
 * blocks on the key until the winner commits, then takes the duplicate-entry error the
 * service translates. That is the same shape `reverseJournal` relies on for
 * `uq_journals_org_reverses`, and it is proven with two real connections in
 * `clearing.race.test.ts`.
 *
 * `bank_line_clearings` itself is mutable (wave 0): un-matching is a delete, not a
 * reversing row, because a clearing posts no journal (the argument is `ar_allocations`').
 */

export const BANK_LINE_CLEARING_RESOURCE = BANKING_RESOURCES.BANK_LINE_CLEARING;
export const STATEMENT_LINE_RESOURCE = BANKING_RESOURCES.BANK_STATEMENT_LINE;
export const BANK_ACCOUNT_RESOURCE = BANKING_RESOURCES.BANK_ACCOUNT;

/**
 * The token a `link_entry` to an unknown journal answers with (A7, E9).
 *
 * Restated rather than imported from the ledger for `refusals.ts`'s reason: a
 * cross-org or nonexistent journal is the same 404 the ledger gives one, and the
 * token is `'journal'` in both places so a client branches on one spelling.
 */
export const JOURNAL_RESOURCE = 'journal';

/** The subledger document a `allocate_document` clearing settles (A7, E9). */
export const DOCUMENT_RESOURCE = 'document';

export function orgScope(ctx: RequestContext): TenantDatabase {
  return tenantDb(toOrgId(ctx.orgId));
}

// ---------------------------------------------------------------------------
// The statement line and its bank account
// ---------------------------------------------------------------------------

export interface StatementLineRow {
  readonly id: Buffer;
  readonly bank_account_id: Buffer;
  readonly posted_date: string;
  readonly amount_minor: bigint;
}

export async function selectStatementLine(
  db: TenantDatabase,
  id: Buffer,
): Promise<StatementLineRow | undefined> {
  return db
    .selectFrom('bank_statement_lines')
    .select(['id', 'bank_account_id', 'posted_date', 'amount_minor'])
    .where('id', '=', id)
    .executeTakeFirst();
}

export interface BankAccountRow {
  /** The bank account's own ledger account — the near side of every clearing (D-46). */
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

// ---------------------------------------------------------------------------
// The entry a link_entry points at
// ---------------------------------------------------------------------------

/** Does a journal with this id exist in this org? (Existence, for the 404.) */
export async function journalExists(db: TenantDatabase, journalId: Buffer): Promise<boolean> {
  const row = await db
    .selectFrom('journals')
    .select('id')
    .where('id', '=', journalId)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * A journal's net movement on one ledger account, signed the way a statement line is.
 *
 * `SUM(debit) − SUM(credit)` over the journal's lines that name the bank account —
 * positive when the journal put money into the account, which is the same frame the
 * line's own signed amount uses (`bank_statement_lines.amount_minor`). That is what
 * makes E4 an equation with no conditional: `clearedAmount` for a `link_entry` is
 * exactly this number.
 */
export async function journalBankMovement(
  db: TenantDatabase,
  journalId: Buffer,
  bankLedgerAccountId: Buffer,
): Promise<bigint> {
  const row = await db
    .selectFrom('journal_lines')
    .select((eb) => [
      eb.fn.coalesce(eb.fn.sum<bigint>('debit_minor'), eb.lit(0)).as('debits'),
      eb.fn.coalesce(eb.fn.sum<bigint>('credit_minor'), eb.lit(0)).as('credits'),
    ])
    .where('journal_id', '=', journalId)
    .where('account_id', '=', bankLedgerAccountId)
    .executeTakeFirst();

  if (row === undefined) return 0n;
  return BigInt(row.debits) - BigInt(row.credits);
}

/** The contact a subledger document belongs to — the payment's contact (C4). */
export async function selectDocumentContactId(
  db: TenantDatabase,
  side: SubledgerSide,
  documentId: Buffer,
): Promise<Buffer | undefined> {
  const row =
    side === 'receivable'
      ? await db
          .selectFrom('ar_documents')
          .select('contact_id')
          .where('id', '=', documentId)
          .executeTakeFirst()
      : await db
          .selectFrom('ap_documents')
          .select('contact_id')
          .where('id', '=', documentId)
          .executeTakeFirst();
  return row?.contact_id;
}

// ---------------------------------------------------------------------------
// The clearing row
// ---------------------------------------------------------------------------

export interface ClearingRow {
  readonly id: Buffer;
  readonly statement_line_id: Buffer;
  readonly method: 'post_entry' | 'link_entry' | 'allocate_document';
  readonly cleared_journal_id: Buffer;
  readonly payment_id: Buffer | null;
  readonly reconciliation_session_id: Buffer | null;
  readonly cleared_amount_minor: bigint;
  readonly difference_amount_minor: bigint;
  readonly difference_account_id: Buffer | null;
  readonly difference_journal_id: Buffer | null;
  readonly created_by_user_id: Buffer;
  readonly created_at: Date;
}

const CLEARING_COLUMNS = [
  'id',
  'statement_line_id',
  'method',
  'cleared_journal_id',
  'payment_id',
  'reconciliation_session_id',
  'cleared_amount_minor',
  'difference_amount_minor',
  'difference_account_id',
  'difference_journal_id',
  'created_by_user_id',
  'created_at',
] as const;

export async function selectClearingByLine(
  db: TenantDatabase,
  lineId: Buffer,
): Promise<ClearingRow | undefined> {
  return db
    .selectFrom('bank_line_clearings')
    .select(CLEARING_COLUMNS)
    .where('statement_line_id', '=', lineId)
    .executeTakeFirst();
}

/** The id of the clearing that already carries this journal, if one does. */
export async function selectClearingIdByJournal(
  db: TenantDatabase,
  journalId: Buffer,
): Promise<Buffer | undefined> {
  const row = await db
    .selectFrom('bank_line_clearings')
    .select('id')
    .where('cleared_journal_id', '=', journalId)
    .executeTakeFirst();
  return row?.id;
}

export interface NewClearingRow {
  readonly id: Buffer;
  readonly statementLineId: Buffer;
  readonly method: 'post_entry' | 'link_entry' | 'allocate_document';
  readonly clearedJournalId: Buffer;
  readonly paymentId: Buffer | null;
  readonly clearedAmountMinor: bigint;
  readonly differenceAmountMinor: bigint;
  readonly differenceAccountId: Buffer | null;
  readonly differenceJournalId: Buffer | null;
  readonly createdByUserId: Buffer;
}

export async function insertClearing(db: TenantDatabase, row: NewClearingRow): Promise<void> {
  await db
    .insertInto('bank_line_clearings')
    .values({
      id: row.id,
      statement_line_id: row.statementLineId,
      method: row.method,
      cleared_journal_id: row.clearedJournalId,
      payment_id: row.paymentId,
      // Clearing outside a session — the ordinary case on the matching screen. A
      // finalised session counts a clearing by date, not by this column (D-45, the
      // membership note in `0006_banking`), so a NULL here is included by date.
      reconciliation_session_id: null,
      cleared_amount_minor: row.clearedAmountMinor,
      difference_amount_minor: row.differenceAmountMinor,
      difference_account_id: row.differenceAccountId,
      difference_journal_id: row.differenceJournalId,
      created_by_user_id: row.createdByUserId,
    })
    .execute();
}

export async function deleteClearing(db: TenantDatabase, id: Buffer): Promise<void> {
  await db.deleteFrom('bank_line_clearings').where('id', '=', id).execute();
}

// Whether a finalised session counts a clearing is read from the clearing's own
// `reconciliation_session_id` stamp (D-51), which `selectClearingByLine` already
// returns — a finalising session stamps its members and a reopen unstamps them, so
// the stamp is the membership. There is deliberately no date-range query here: it
// would refuse undoing a straggler cleared into an already-finalised window that the
// assertion never counted. The undo refusal lives in `clearing.service.ts`.
