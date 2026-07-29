import { BANKING_RESOURCES } from '@openbooks/shared-types';
import type { BankLineClearing, BankStatementLine } from '@openbooks/shared-types';

import type { RequestContext } from '../../../context';
import type { KeysetOrdering, KeysetPage, TenantDatabase } from '../../../db';
import {
  applyKeyset,
  bufferToUuid,
  calendarDateKey,
  orgScope as toOrgId,
  tenantDb,
  toKeysetPage,
  tryUuidToBuffer,
  uuidKey,
} from '../../../db';
import { assembleClearing } from '../clearing';
import type { ClearingEntryRow, ClearingRow } from '../clearing/clearing.repository';
import { selectEntriesForClearings } from '../clearing/clearing.repository';

/**
 * Data access for `bank_statement_lines` and the clearing embedded in each (OB-084;
 * ROADMAP D-42, D-45).
 *
 * The read surface the matching and reconciliation screens (OB-086) need and that no
 * earlier wave built: waves 1–3 wrote lines (import) and read one line at a time to
 * clear it, but never a list. Append-only at the grant level (D-42), so there is no
 * `forUpdate` here and no write path — a statement line is what the bank said, and the
 * only thing that ever changes about it is whether a clearing references it.
 *
 * Everything goes through `tenantDb`, so `org_id = ctx.orgId` is on every statement — a
 * cross-org id is a miss, not a leak (E9).
 */

export const STATEMENT_LINE_RESOURCE = BANKING_RESOURCES.BANK_STATEMENT_LINE;

const LINE_COLUMNS = [
  'id',
  'bank_account_id',
  'import_id',
  'posted_date',
  'value_date',
  'amount_minor',
  'description',
  'counterparty',
  'bank_reference',
  'occurrence_index',
  'fingerprint',
  'created_at',
] as const;

interface StatementLineRow {
  readonly id: Buffer;
  readonly bank_account_id: Buffer;
  readonly import_id: Buffer;
  readonly posted_date: string;
  readonly value_date: string | null;
  readonly amount_minor: bigint;
  readonly description: string;
  readonly counterparty: string | null;
  readonly bank_reference: string | null;
  readonly occurrence_index: number;
  readonly fingerprint: string;
  readonly created_at: Date;
}

const CLEARING_COLUMNS = [
  'id',
  'statement_line_id',
  'reconciliation_session_id',
  'cleared_amount_minor',
  'difference_amount_minor',
  'difference_account_id',
  'difference_journal_id',
  'created_by_user_id',
  'created_at',
] as const;

export function orgScope(ctx: RequestContext): TenantDatabase {
  return tenantDb(toOrgId(ctx.orgId));
}

export function lineIdBytes(id: string): Buffer | undefined {
  return tryUuidToBuffer(id);
}

export interface StatementLineFilters {
  readonly bankAccountId?: Buffer | undefined;
  readonly importId?: Buffer | undefined;
  readonly direction?: 'inbound' | 'outbound' | undefined;
  readonly cleared?: boolean | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly cursor?: string | undefined;
}

/**
 * `(posted_date, id)` — the one list in the module not ordered by `(created_at, id)`.
 *
 * `posted_date` qualifies as a keyset column precisely because of D-42: a statement
 * line is never modified, so its date cannot move beneath a paging client. A
 * reconciliation reads a statement in date order, so any other ordering would make the
 * milestone's central screen sort a whole account client-side.
 */
const LINE_KEYSET: KeysetOrdering<StatementLineRow> = [
  calendarDateKey('bank_statement_lines.posted_date', (row) => row.posted_date),
  uuidKey('bank_statement_lines.id', (row) => row.id),
];

export async function selectStatementLineById(
  db: TenantDatabase,
  id: Buffer,
): Promise<StatementLineRow | undefined> {
  return db
    .selectFrom('bank_statement_lines')
    .select(LINE_COLUMNS)
    .where('id', '=', id)
    .executeTakeFirst();
}

/**
 * One page of lines. The `cleared` filter is a left join to `bank_line_clearings` and a
 * NULL test — the same shape the reconciliation repo uses to count cleared/uncleared —
 * so a line with no clearing row is excluded or kept without a second query. Only the
 * line's own columns are selected; the clearings are read in one batch afterwards.
 */
export async function selectStatementLinesPage(
  db: TenantDatabase,
  filters: StatementLineFilters,
  limit: number,
): Promise<KeysetPage<StatementLineRow>> {
  const columns = LINE_COLUMNS.map((column) => `bank_statement_lines.${column}` as const);
  let query = db
    .selectFrom('bank_statement_lines')
    .leftJoin('bank_line_clearings', (join) =>
      join.onRef('bank_line_clearings.statement_line_id', '=', 'bank_statement_lines.id'),
    )
    .select(columns);

  if (filters.bankAccountId !== undefined) {
    query = query.where('bank_statement_lines.bank_account_id', '=', filters.bankAccountId);
  }
  if (filters.importId !== undefined) {
    query = query.where('bank_statement_lines.import_id', '=', filters.importId);
  }
  if (filters.direction === 'inbound') {
    query = query.where('bank_statement_lines.amount_minor', '>', 0n);
  }
  if (filters.direction === 'outbound') {
    query = query.where('bank_statement_lines.amount_minor', '<', 0n);
  }
  if (filters.cleared === true) {
    query = query.where('bank_line_clearings.id', 'is not', null);
  }
  if (filters.cleared === false) {
    query = query.where('bank_line_clearings.id', 'is', null);
  }
  if (filters.from !== undefined) {
    query = query.where('bank_statement_lines.posted_date', '>=', filters.from);
  }
  if (filters.to !== undefined) {
    query = query.where('bank_statement_lines.posted_date', '<=', filters.to);
  }

  const rows = await applyKeyset(query, LINE_KEYSET, limit, filters.cursor).execute();
  return toKeysetPage(rows, LINE_KEYSET, limit);
}

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

/** Every clearing for a page of lines, keyed by the line's id hex, in one query. */
export async function selectClearingsForLines(
  db: TenantDatabase,
  lineIds: readonly Buffer[],
): Promise<Map<string, ClearingRow>> {
  if (lineIds.length === 0) return new Map();

  const rows = await db
    .selectFrom('bank_line_clearings')
    .select(CLEARING_COLUMNS)
    .where('statement_line_id', 'in', lineIds)
    .execute();

  return new Map(rows.map((row) => [row.statement_line_id.toString('hex'), row]));
}

/**
 * Every entry for a page of clearings, keyed by the parent clearing's id hex — the
 * sibling `selectEntriesForClearings` re-exported so `service.ts` need not reach
 * into `clearing.repository.ts` directly for the one function it needs from there.
 */
export async function selectClearingEntriesForClearings(
  db: TenantDatabase,
  clearingIds: readonly Buffer[],
): Promise<Map<string, ClearingEntryRow[]>> {
  return selectEntriesForClearings(db, clearingIds);
}

/**
 * The clearing as the wire returns it. `assembleClearing` (`clearing.service.ts`,
 * re-exported from `../clearing`) is the one conversion for both the write path and
 * this read path — parent plus entries, D-105.
 */
export function toBankLineClearing(
  row: ClearingRow,
  entries: readonly ClearingEntryRow[],
): BankLineClearing {
  return assembleClearing(row, entries);
}

export function toStatementLine(
  row: StatementLineRow,
  clearing: BankLineClearing | null,
): BankStatementLine {
  return {
    id: bufferToUuid(row.id),
    bankAccountId: bufferToUuid(row.bank_account_id),
    importId: bufferToUuid(row.import_id),
    postedDate: row.posted_date,
    valueDate: row.value_date,
    amount: row.amount_minor.toString(),
    description: row.description,
    counterparty: row.counterparty,
    bankReference: row.bank_reference,
    occurrenceIndex: row.occurrence_index,
    fingerprint: row.fingerprint,
    clearing,
    createdAt: row.created_at.toISOString(),
  };
}
