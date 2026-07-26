import type { Insertable } from 'kysely';

import type { DB, OrgId, TenantDatabase } from '../../db';
import { newUuidBuffer } from '../../db';

/**
 * The only code in the system permitted to write `journals` or `journal_lines`.
 *
 * That is enforced, not asserted: `openbooks/no-journal-writes` fails the build on
 * an `insertInto('journals')` anywhere else, and this file's path is the single
 * entry in the rule's allowlist (plus the migrations and the test factories). Spec
 * §2.1 makes the ledger the only holder of financial state and §2.2 makes it
 * append-only; both collapse the moment a second code path can insert a posting,
 * because balance validation, the period lock, and actor provenance all live in the
 * service above this one.
 *
 * Everything here takes an explicit `TenantDatabase`. The service opens one
 * transaction and threads it through, so no function here can accidentally run on
 * a second connection — which for the sequence allocation would silently break
 * gaplessness.
 */

export interface JournalRow {
  readonly id: Buffer;
  readonly sequenceNumber: bigint;
  readonly periodId: Buffer;
  readonly entryDate: string;
  readonly memo: string | null;
  readonly reference: string | null;
  readonly source: string;
  readonly actorType: 'user' | 'automation' | 'agent';
  readonly actorId: Buffer;
  readonly invocationMode: 'interactive' | 'scheduled' | null;
  readonly reversesJournalId: Buffer | null;
}

export interface JournalLineRow {
  readonly journalId: Buffer;
  readonly lineNumber: number;
  readonly accountId: Buffer;
  readonly debitMinor: bigint;
  readonly creditMinor: bigint;
  readonly memo: string | null;
}

/**
 * Allocates the next journal number for an org (D-14).
 *
 * Three statements rather than one clever upsert, because the value has to be *read*
 * and MySQL will not return the post-increment value of an
 * `ON DUPLICATE KEY UPDATE`. The upsert only ensures the counter row exists; the
 * `FOR UPDATE` read is what serializes concurrent posters, and the write advances it.
 *
 * The counter lives on its own table for a reason worth restating here, since this
 * is where it bites: `MAX(sequence_number) + 1` would need a locking read on
 * `journals`, and the app user cannot take one — MySQL requires
 * `UPDATE`/`DELETE`/`LOCK TABLES` alongside `SELECT` for `FOR UPDATE`, and
 * withholding exactly those is how immutability is enforced (0004_app_grants).
 * `journal_sequences` is in the mutable allowlist precisely so this lock is
 * available.
 *
 * Consequence: posting serializes per org. That is the price of a gapless sequence,
 * and it is the right price — a gap is indistinguishable from a deleted entry.
 */
export async function allocateSequenceNumber(db: TenantDatabase, orgId: OrgId): Promise<bigint> {
  await db
    .insertInto('journal_sequences')
    .values({ next_value: 1n })
    .onDuplicateKeyUpdate({ org_id: orgId })
    .execute();

  const counter = await db
    .selectFrom('journal_sequences')
    .select('next_value')
    .forUpdate()
    .executeTakeFirstOrThrow();

  await db
    .updateTable('journal_sequences')
    .set({ next_value: counter.next_value + 1n })
    .execute();

  return counter.next_value;
}

/**
 * Accounts that may receive a posting, keyed by id.
 *
 * Reads through the tenant wrapper, so an account belonging to another org is not
 * merely rejected — it does not appear in the result, and the caller reports it as
 * unknown. That is what keeps a cross-org account id indistinguishable from a
 * nonexistent one (A7) without the caller having to remember to make it so.
 */
export async function selectPostableAccounts(
  db: TenantDatabase,
  accountIds: readonly Buffer[],
): Promise<Map<string, { readonly isActive: boolean }>> {
  if (accountIds.length === 0) return new Map();

  const rows = await db
    .selectFrom('accounts')
    .select(['id', 'is_active'])
    .where('accounts.id', 'in', accountIds)
    .execute();

  return new Map(rows.map((row) => [row.id.toString('hex'), { isActive: row.is_active === 1 }]));
}

/** The original of a reversal, and whether it has already been reversed. */
export async function selectJournalToReverse(
  db: TenantDatabase,
  journalId: Buffer,
): Promise<
  | {
      readonly id: Buffer;
      readonly entryDate: string;
      readonly sequenceNumber: bigint;
      readonly reversesJournalId: Buffer | null;
      readonly lines: readonly {
        readonly accountId: Buffer;
        readonly lineNumber: number;
        readonly debitMinor: bigint;
        readonly creditMinor: bigint;
        readonly memo: string | null;
      }[];
    }
  | undefined
> {
  const journal = await db
    .selectFrom('journals')
    .select(['id', 'entry_date', 'sequence_number', 'reverses_journal_id'])
    .where('journals.id', '=', journalId)
    .executeTakeFirst();

  if (!journal) return undefined;

  const lines = await db
    .selectFrom('journal_lines')
    .select(['account_id', 'line_number', 'debit_minor', 'credit_minor', 'memo'])
    .where('journal_lines.journal_id', '=', journalId)
    .orderBy('line_number')
    .execute();

  return {
    id: journal.id,
    entryDate: journal.entry_date,
    sequenceNumber: journal.sequence_number,
    reversesJournalId: journal.reverses_journal_id,
    lines: lines.map((line) => ({
      accountId: line.account_id,
      lineNumber: line.line_number,
      debitMinor: line.debit_minor,
      creditMinor: line.credit_minor,
      memo: line.memo,
    })),
  };
}

/** Is `journalId` already reversed by some other journal? */
export async function selectExistingReversal(
  db: TenantDatabase,
  journalId: Buffer,
): Promise<Buffer | undefined> {
  const row = await db
    .selectFrom('journals')
    .select('id')
    .where('journals.reverses_journal_id', '=', journalId)
    .executeTakeFirst();
  return row?.id;
}

/**
 * Inserts the journal header. Append-only: there is no update counterpart, and the
 * app user holds no `UPDATE` grant on this table to write one with.
 */
export async function insertJournal(db: TenantDatabase, row: JournalRow): Promise<void> {
  const values: Omit<Insertable<DB['journals']>, 'org_id'> = {
    id: row.id,
    sequence_number: row.sequenceNumber,
    period_id: row.periodId,
    entry_date: row.entryDate,
    memo: row.memo,
    reference: row.reference,
    source: row.source,
    actor_type: row.actorType,
    actor_id: row.actorId,
    invocation_mode: row.invocationMode,
    reverses_journal_id: row.reversesJournalId,
  };
  await db.insertInto('journals').values(values).execute();
}

/**
 * Inserts all lines in one statement.
 *
 * One statement rather than a loop so the `chk_journal_lines_one_sided` CHECK and
 * both composite foreign keys are evaluated as a unit — and because a partially
 * inserted journal is not a state this schema should ever hold, even transiently
 * inside a transaction that is about to roll back.
 */
export async function insertJournalLines(
  db: TenantDatabase,
  rows: readonly JournalLineRow[],
): Promise<void> {
  await db
    .insertInto('journal_lines')
    .values(
      rows.map((row) => ({
        journal_id: row.journalId,
        line_number: row.lineNumber,
        account_id: row.accountId,
        debit_minor: row.debitMinor,
        credit_minor: row.creditMinor,
        memo: row.memo,
      })),
    )
    .execute();
}

export function newJournalId(): Buffer {
  return newUuidBuffer();
}
