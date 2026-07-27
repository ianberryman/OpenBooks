import type {
  BankImportMappingDefinition,
  BankStatementFormat,
  BankStatementImportStatus,
} from '@openbooks/shared-types';
import { BANKING_RESOURCES } from '@openbooks/shared-types';

import type { RequestContext } from '../../../context';
import type { KeysetOrdering, KeysetPage, TenantDatabase } from '../../../db';
import {
  applyKeyset,
  instantKey,
  orgScope as toOrgId,
  tenantDb,
  toKeysetPage,
  uuidKey,
} from '../../../db';

/**
 * Data access for statement imports and lines (OB-078).
 *
 * Everything goes through `tenantDb`, so `org_id = ctx.orgId` is on every statement
 * before this file adds a predicate — a cross-org id is a miss, not a leak (E9), and
 * `assertFound` in the service turns the miss into the one 404 it may produce.
 *
 * ## Two tables, two postures, held apart on purpose
 *
 * `bank_statement_imports` is mutable working state now (D-47): this file updates its
 * `status` through the queued → processing → complete/failed lifecycle. That is the
 * whole reason it moved out of `APPEND_ONLY_TABLES`.
 *
 * `bank_statement_lines` is evidence and stays append-only (E2). **There is no update
 * or delete path for a line in this file, and there must not be** — the app user
 * holds no `UPDATE`/`DELETE` on that table, so one would fail at the grant level, and
 * that failure is the design. Dedupe never rewrites a line; it decides which new
 * lines to insert and inserts only those.
 */

export const STATEMENT_IMPORT_RESOURCE = BANKING_RESOURCES.BANK_STATEMENT_IMPORT;
export const BANK_ACCOUNT_RESOURCE = BANKING_RESOURCES.BANK_ACCOUNT;
export const IMPORT_MAPPING_RESOURCE = BANKING_RESOURCES.BANK_IMPORT_MAPPING;

export function orgScope(ctx: RequestContext): TenantDatabase {
  return tenantDb(toOrgId(ctx.orgId));
}

// ---------------------------------------------------------------------------
// Bank account and mapping — the two things startImport reads before it queues
// ---------------------------------------------------------------------------

export interface BankAccountRow {
  readonly id: Buffer;
  readonly external_account_id: string | null;
  readonly is_active: number;
}

export async function selectBankAccount(
  db: TenantDatabase,
  id: Buffer,
): Promise<BankAccountRow | undefined> {
  return db
    .selectFrom('bank_accounts')
    .select(['id', 'external_account_id', 'is_active'])
    .where('id', '=', id)
    .executeTakeFirst();
}

/**
 * Reconstructs a saved mapping's definition, for a CSV import that names one by id.
 *
 * A read, not a rewrite of OB-076's mapping CRUD: creating and editing mappings — and
 * `saveMappingAs` — are OB-076's, the ticket whose title is "CSV import with saved
 * column mappings". The import service needs only to *read* a chosen mapping back
 * into the wire definition the parser takes, and the columns it reads are fixed by
 * `0006_banking` (wave 0), so this stays stable across OB-076's work.
 */
export async function selectMappingDefinition(
  db: TenantDatabase,
  id: Buffer,
): Promise<BankImportMappingDefinition | undefined> {
  const row = await db
    .selectFrom('bank_import_mappings')
    .select([
      'has_header_row',
      'delimiter',
      'date_order',
      'amount_convention',
      'posted_date_column',
      'description_column',
      'amount_column',
      'debit_column',
      'credit_column',
      'value_date_column',
      'counterparty_column',
      'bank_reference_column',
    ])
    .where('id', '=', id)
    .executeTakeFirst();
  if (row === undefined) return undefined;

  return {
    hasHeaderRow: row.has_header_row === 1,
    delimiter: row.delimiter,
    dateOrder: row.date_order,
    amountConvention: row.amount_convention,
    columns: {
      postedDate: row.posted_date_column,
      description: row.description_column,
      amount: row.amount_column,
      debit: row.debit_column,
      credit: row.credit_column,
      valueDate: row.value_date_column,
      counterparty: row.counterparty_column,
      bankReference: row.bank_reference_column,
    },
  };
}

// ---------------------------------------------------------------------------
// The import record and its lifecycle
// ---------------------------------------------------------------------------

export interface NewImportRow {
  readonly id: Buffer;
  readonly bankAccountId: Buffer;
  readonly format: BankStatementFormat;
  readonly filename: string;
  readonly fileHash: string;
  readonly mappingId: Buffer | null;
  readonly importedByUserId: Buffer;
}

/** Writes the import `queued`: no counts and no lines yet (D-47). */
export async function insertQueuedImport(db: TenantDatabase, row: NewImportRow): Promise<void> {
  await db
    .insertInto('bank_statement_imports')
    .values({
      id: row.id,
      bank_account_id: row.bankAccountId,
      format: row.format,
      filename: row.filename,
      file_hash: row.fileHash,
      mapping_id: row.mappingId,
      imported_by_user_id: row.importedByUserId,
      // status defaults to 'queued'; counts, closing balance and external account id
      // are all NULL until the worker parses the file and completes.
    })
    .execute();
}

export interface ImportStatusRow {
  readonly status: 'queued' | 'processing' | 'complete' | 'failed';
}

export async function selectImportStatus(
  db: TenantDatabase,
  id: Buffer,
): Promise<ImportStatusRow | undefined> {
  return db
    .selectFrom('bank_statement_imports')
    .select('status')
    .where('id', '=', id)
    .executeTakeFirst();
}

/**
 * Moves an import to `processing`, but only from `queued`/`processing`.
 *
 * The `WHERE status <> 'complete'` guard is what makes re-running safe (D-49): a job
 * that runs twice against an already-completed import must not drag it back to
 * `processing` and re-do its work. A crashed import left `queued` or `processing` is
 * reprocessed; a finished one is left alone.
 */
export async function markImportProcessing(db: TenantDatabase, id: Buffer): Promise<void> {
  await db
    .updateTable('bank_statement_imports')
    .set({ status: 'processing' })
    .where('id', '=', id)
    .where('status', '!=', 'complete')
    .execute();
}

export interface CompletedImport {
  readonly linesRead: number;
  readonly linesDuplicate: number;
  readonly closingBalance: bigint | null;
  readonly externalAccountId: string | null;
}

export async function markImportComplete(
  db: TenantDatabase,
  id: Buffer,
  result: CompletedImport,
): Promise<void> {
  await db
    .updateTable('bank_statement_imports')
    .set({
      status: 'complete',
      lines_read: result.linesRead,
      lines_duplicate: result.linesDuplicate,
      closing_balance_minor: result.closingBalance,
      external_account_id: result.externalAccountId,
      failure_reason: null,
    })
    .where('id', '=', id)
    .execute();
}

export async function markImportFailed(
  db: TenantDatabase,
  id: Buffer,
  reason: string,
): Promise<void> {
  await db
    .updateTable('bank_statement_imports')
    .set({ status: 'failed', failure_reason: reason })
    .where('id', '=', id)
    .execute();
}

export interface ImportRow {
  readonly id: Buffer;
  readonly bank_account_id: Buffer;
  readonly format: BankStatementFormat;
  readonly filename: string;
  readonly status: 'queued' | 'processing' | 'complete' | 'failed';
  readonly lines_read: number | null;
  readonly lines_duplicate: number | null;
  readonly failure_reason: string | null;
  readonly closing_balance_minor: bigint | null;
  readonly external_account_id: string | null;
}

export async function selectImportById(
  db: TenantDatabase,
  id: Buffer,
): Promise<ImportRow | undefined> {
  return db
    .selectFrom('bank_statement_imports')
    .select([
      'id',
      'bank_account_id',
      'format',
      'filename',
      'status',
      'lines_read',
      'lines_duplicate',
      'failure_reason',
      'closing_balance_minor',
      'external_account_id',
    ])
    .where('id', '=', id)
    .executeTakeFirst();
}

// ---------------------------------------------------------------------------
// The import read model — the poll surface (OB-084's follow-up)
// ---------------------------------------------------------------------------

/**
 * The whole import row a `GET` returns: the lifecycle columns plus the provenance a
 * completed import carries. Wider than `ImportRow` above, which is the worker's own
 * read; kept separate so the lifecycle write path is not coupled to the read shape.
 */
export interface ImportReadRow {
  readonly id: Buffer;
  readonly bank_account_id: Buffer;
  readonly format: BankStatementFormat;
  readonly filename: string;
  readonly mapping_id: Buffer | null;
  readonly status: BankStatementImportStatus;
  readonly lines_read: number | null;
  readonly lines_duplicate: number | null;
  readonly failure_reason: string | null;
  readonly closing_balance_minor: bigint | null;
  readonly external_account_id: string | null;
  readonly imported_by_user_id: Buffer;
  readonly created_at: Date;
}

const IMPORT_READ_COLUMNS = [
  'id',
  'bank_account_id',
  'format',
  'filename',
  'mapping_id',
  'status',
  'lines_read',
  'lines_duplicate',
  'failure_reason',
  'closing_balance_minor',
  'external_account_id',
  'imported_by_user_id',
  'created_at',
] as const;

export async function selectImportForRead(
  db: TenantDatabase,
  id: Buffer,
): Promise<ImportReadRow | undefined> {
  return db
    .selectFrom('bank_statement_imports')
    .select(IMPORT_READ_COLUMNS)
    .where('id', '=', id)
    .executeTakeFirst();
}

export interface ImportListFilters {
  readonly bankAccountId?: Buffer | undefined;
  readonly cursor?: string | undefined;
}

/** `(created_at, id)` — the default this API's lists use (D-21); `created_at` cannot move. */
const IMPORT_KEYSET: KeysetOrdering<ImportReadRow> = [
  instantKey('bank_statement_imports.created_at', (row) => row.created_at),
  uuidKey('bank_statement_imports.id', (row) => row.id),
];

export async function selectImportsPage(
  db: TenantDatabase,
  filters: ImportListFilters,
  limit: number,
): Promise<KeysetPage<ImportReadRow>> {
  let query = db.selectFrom('bank_statement_imports').select(IMPORT_READ_COLUMNS);

  if (filters.bankAccountId !== undefined) {
    query = query.where('bank_account_id', '=', filters.bankAccountId);
  }

  const rows = await applyKeyset(query, IMPORT_KEYSET, limit, filters.cursor).execute();
  return toKeysetPage(rows, IMPORT_KEYSET, limit);
}

// ---------------------------------------------------------------------------
// The lines — INSERT and SELECT only (append-only, E2)
// ---------------------------------------------------------------------------

export interface NewLineRow {
  readonly id: Buffer;
  readonly bankAccountId: Buffer;
  readonly importId: Buffer;
  readonly postedDate: string;
  readonly valueDate: string | null;
  readonly description: string;
  readonly counterparty: string | null;
  readonly amountMinor: bigint;
  readonly bankReference: string | null;
  readonly fingerprint: string;
  readonly occurrenceIndex: number;
}

/**
 * How many lines this account already holds for each of the given fingerprints.
 *
 * The `n` in `insert max(0, k − n) rows` (D-42). Read without a lock deliberately:
 * lines are only ever inserted, so this count monotonically increases, and a stale
 * (lower) read can only make the caller *plan more* rows — every one of which the
 * INSERT IGNORE below drops if it turns out to exist. There is no read under which a
 * genuinely new line is missed, so no `FOR UPDATE` is needed, and the unique key is
 * the real guarantee anyway.
 */
export async function existingFingerprintCounts(
  db: TenantDatabase,
  bankAccountId: Buffer,
  fingerprints: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (fingerprints.length === 0) return counts;

  const rows = await db
    .selectFrom('bank_statement_lines')
    .select(['fingerprint', (eb) => eb.fn.countAll<string | number | bigint>().as('n')])
    .where('bank_account_id', '=', bankAccountId)
    .where('fingerprint', 'in', fingerprints)
    .groupBy('fingerprint')
    .execute();

  for (const row of rows) counts.set(row.fingerprint, Number(row.n));
  return counts;
}

/**
 * Inserts the planned new lines, ignoring any that already exist.
 *
 * `INSERT IGNORE`, so a `(fingerprint, occurrence_index)` another writer or an
 * earlier partial run already inserted is skipped rather than raising — which is
 * exactly the dedupe outcome, and is what makes a concurrent overlapping import and a
 * re-run both safe. The only constraint an insert here can violate that the service
 * has not already checked is that unique key; every other column is bounded by the
 * wire schema or is a valid foreign key by construction, so IGNORE is not masking a
 * class of real error. The count of what *this* import actually contributed is read
 * back from `import_id`, not inferred from this call.
 */
export async function insertLinesIgnore(
  db: TenantDatabase,
  rows: readonly NewLineRow[],
): Promise<void> {
  if (rows.length === 0) return;

  await db
    .insertInto('bank_statement_lines')
    .values(
      rows.map((row) => ({
        id: row.id,
        bank_account_id: row.bankAccountId,
        import_id: row.importId,
        posted_date: row.postedDate,
        value_date: row.valueDate,
        description: row.description,
        counterparty: row.counterparty,
        amount_minor: row.amountMinor,
        bank_reference: row.bankReference,
        fingerprint: row.fingerprint,
        occurrence_index: row.occurrenceIndex,
      })),
    )
    .ignore()
    .execute();
}

/**
 * How many lines carry this import id — the count of what the import contributed.
 *
 * Read back after the insert rather than counted from the plan, so it is correct
 * whatever the insert actually did: rows a re-run's earlier attempt already wrote
 * carry this import id and are counted; rows a *different* import wrote carry another
 * id and are not. That makes `linesImported` stable across re-runs and honest under
 * concurrency (E1), and `linesDuplicate = linesRead − linesImported` follows.
 */
export async function countLinesByImport(db: TenantDatabase, importId: Buffer): Promise<number> {
  const row = await db
    .selectFrom('bank_statement_lines')
    .select((eb) => eb.fn.countAll<string | number | bigint>().as('n'))
    .where('import_id', '=', importId)
    .executeTakeFirstOrThrow();
  return Number(row.n);
}
