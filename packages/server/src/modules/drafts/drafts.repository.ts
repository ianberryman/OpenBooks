import type { JournalDraft, JournalDraftLine, JournalDraftSummary } from '@openbooks/shared-types';

import type { RequestContext } from '../../context';
import type { KeysetOrdering, KeysetPage, TenantDatabase } from '../../db';
import {
  applyKeyset,
  bufferToUuid,
  instantKey,
  newUuidBuffer,
  orgScope as toOrgId,
  tenantDb,
  toKeysetPage,
  tryUuidToBuffer,
  uuidKey,
} from '../../db';

/**
 * Data access for journal drafts.
 *
 * Everything goes through `tenantDb`, so `org_id = ctx.orgId` is on every
 * statement before this file adds a predicate: a cross-org draft id matches
 * nothing and the service's `assertFound` turns that into the one error a miss is
 * allowed to produce (A7).
 *
 * These are the first tables since M1 the app user may `UPDATE` and `DELETE`
 * (`0999_app_grants`, D-19), which is what makes `selectDraftByIdForUpdate`
 * possible at all — the journal tables cannot be locked, because MySQL requires
 * `UPDATE`/`DELETE` alongside `SELECT` for a locking read and withholding exactly
 * those is how immutability is enforced. That lock is the whole of the
 * exactly-once guarantee in `postDraft`; see the commentary there.
 */

/** The resource token every miss in this module reports (A7). */
export const DRAFT_RESOURCE = 'journal_draft';

const DRAFT_COLUMNS = [
  'id',
  'entry_date',
  'memo',
  'reference',
  'created_by_user_id',
  'created_at',
  'updated_at',
] as const;

const DRAFT_LINE_COLUMNS = [
  'id',
  'line_number',
  'account_id',
  'contact_id',
  'debit_minor',
  'credit_minor',
  'memo',
] as const;

export interface DraftRow {
  readonly id: Buffer;
  readonly entry_date: string | null;
  readonly memo: string | null;
  readonly reference: string | null;
  readonly created_by_user_id: Buffer;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface DraftLineRow {
  readonly id: bigint;
  readonly line_number: number;
  readonly account_id: Buffer | null;
  readonly contact_id: Buffer | null;
  readonly debit_minor: bigint;
  readonly credit_minor: bigint;
  readonly memo: string | null;
}

export interface NewDraftRow {
  readonly createdByUserId: Buffer;
  readonly entryDate: string | null;
  readonly memo: string | null;
  readonly reference: string | null;
}

export interface DraftPatch {
  readonly entryDate?: string | null;
  readonly memo?: string | null;
  readonly reference?: string | null;
}

/** A line as the service has resolved it: ids as bytes, amount split across the two columns. */
export interface NewDraftLineRow {
  readonly lineNumber: number;
  readonly accountId: Buffer | null;
  readonly contactId: Buffer | null;
  readonly debitMinor: bigint;
  readonly creditMinor: bigint;
  readonly memo: string | null;
  /** `(dimension, value)` pairs, the axis already resolved from the value. */
  readonly dimensions: readonly { readonly dimensionId: Buffer; readonly valueId: Buffer }[];
}

/** The org-scoped handle for the current operation (spec §4: no org parameters). */
export function orgScope(ctx: RequestContext): TenantDatabase {
  return tenantDb(toOrgId(ctx.orgId));
}

/**
 * A client-supplied draft id as bytes, or `undefined` when it is not a UUID.
 *
 * Undefined rather than a throw, so the service routes a malformed id through
 * `assertFound` to the same 404 a nonexistent one produces. A 400 here would be a
 * distinguishable answer for a class of ids, which is the shape A7 rules out.
 */
export function draftIdBytes(draftId: string): Buffer | undefined {
  return tryUuidToBuffer(draftId);
}

export function newDraftId(): Buffer {
  return newUuidBuffer();
}

export async function insertDraft(
  db: TenantDatabase,
  id: Buffer,
  input: NewDraftRow,
): Promise<void> {
  await db
    .insertInto('journal_drafts')
    .values({
      id,
      created_by_user_id: input.createdByUserId,
      entry_date: input.entryDate,
      memo: input.memo,
      reference: input.reference,
    })
    .execute();
}

export async function selectDraftById(
  db: TenantDatabase,
  id: Buffer,
): Promise<DraftRow | undefined> {
  return db
    .selectFrom('journal_drafts')
    .select(DRAFT_COLUMNS)
    .where('journal_drafts.id', '=', id)
    .executeTakeFirst();
}

/**
 * The same read, taking an exclusive row lock.
 *
 * This is the serialization point for every write to a draft, and for the post.
 * Two callers posting one draft both reach this statement; the second blocks
 * until the first commits, and then finds the row gone — which is what turns "two
 * posts of one draft" into one journal and one 404 rather than two journals. It
 * only works because `journal_drafts` is in `0999_app_grants`'s mutable allowlist.
 */
export async function selectDraftByIdForUpdate(
  db: TenantDatabase,
  id: Buffer,
): Promise<DraftRow | undefined> {
  return db
    .selectFrom('journal_drafts')
    .select(DRAFT_COLUMNS)
    .where('journal_drafts.id', '=', id)
    .forUpdate()
    .executeTakeFirst();
}

/**
 * Applies the header patch, and always writes `updated_at`.
 *
 * `ON UPDATE CURRENT_TIMESTAMP(3)` only fires when some column's value actually
 * changes, so an edit that replaced only the *lines* would leave the header's
 * `updated_at` at the moment the draft was created. A drafts list sorted or
 * labelled by last edit would then be wrong in exactly the case a user notices —
 * the draft they were just working on.
 */
export async function updateDraftRow(
  db: TenantDatabase,
  id: Buffer,
  patch: DraftPatch,
  now: Date,
): Promise<void> {
  await db
    .updateTable('journal_drafts')
    .set({
      ...(patch.entryDate === undefined ? {} : { entry_date: patch.entryDate }),
      ...(patch.memo === undefined ? {} : { memo: patch.memo }),
      ...(patch.reference === undefined ? {} : { reference: patch.reference }),
      updated_at: now,
    })
    .where('journal_drafts.id', '=', id)
    .execute();
}

/**
 * Deletes the draft, and with it its lines and their tags.
 *
 * The cascade is `0002_ledger`'s and it is the one place in this schema where a
 * delete removes rows the caller did not name. It is safe precisely because
 * nothing here is a posting.
 *
 * Returns the row count so the caller can tell "deleted" from "was not there",
 * which is not knowable from an `UPDATE` (mysql2 does not set `CLIENT_FOUND_ROWS`)
 * but is exact for a `DELETE`.
 */
export async function deleteDraftRow(db: TenantDatabase, id: Buffer): Promise<number> {
  const result = await db
    .deleteFrom('journal_drafts')
    .where('journal_drafts.id', '=', id)
    .executeTakeFirst();

  return Number(result.numDeletedRows);
}

export async function selectDraftLines(
  db: TenantDatabase,
  draftId: Buffer,
): Promise<readonly DraftLineRow[]> {
  return db
    .selectFrom('journal_draft_lines')
    .select(DRAFT_LINE_COLUMNS)
    .where('journal_draft_lines.draft_id', '=', draftId)
    .orderBy('journal_draft_lines.line_number')
    .execute();
}

/** The tags on a set of draft lines, keyed by line id. */
export async function selectDraftLineDimensions(
  db: TenantDatabase,
  lineIds: readonly bigint[],
): Promise<ReadonlyMap<string, readonly string[]>> {
  const tags = new Map<string, string[]>();
  if (lineIds.length === 0) return tags;

  const rows = await db
    .selectFrom('journal_draft_line_dimensions')
    .select(['draft_line_id', 'dimension_value_id'])
    .where('journal_draft_line_dimensions.draft_line_id', 'in', lineIds)
    .orderBy('journal_draft_line_dimensions.dimension_id')
    .execute();

  for (const row of rows) {
    const key = row.draft_line_id.toString();
    const existing = tags.get(key);
    if (existing === undefined) {
      tags.set(key, [bufferToUuid(row.dimension_value_id)]);
    } else {
      existing.push(bufferToUuid(row.dimension_value_id));
    }
  }

  return tags;
}

/**
 * Replaces a draft's lines wholesale.
 *
 * Delete-then-insert rather than a diff, because `lines` on the wire is a whole
 * set (see `updateDraftRequestSchema`) and a diff would have to invent stable
 * line identities to compare against. The tags go with the lines through
 * `ON DELETE CASCADE`, so nothing here has to remember them.
 *
 * The line ids are read back rather than derived from the insert's `insertId`:
 * mysql2 returns the id of the *first* row of a multi-row insert, and deriving
 * the rest by adding one assumes a contiguous auto-increment block — true today
 * and not true under `innodb_autoinc_lock_mode = 2` with concurrent inserts, which
 * is the default in MySQL 8. Reading them back costs one indexed query and cannot
 * be wrong.
 */
export async function replaceDraftLines(
  db: TenantDatabase,
  draftId: Buffer,
  lines: readonly NewDraftLineRow[],
): Promise<void> {
  await db
    .deleteFrom('journal_draft_lines')
    .where('journal_draft_lines.draft_id', '=', draftId)
    .execute();

  if (lines.length === 0) return;

  await db
    .insertInto('journal_draft_lines')
    .values(
      lines.map((line) => ({
        draft_id: draftId,
        line_number: line.lineNumber,
        account_id: line.accountId,
        contact_id: line.contactId,
        debit_minor: line.debitMinor,
        credit_minor: line.creditMinor,
        memo: line.memo,
      })),
    )
    .execute();

  const tagged = lines.filter((line) => line.dimensions.length > 0);
  if (tagged.length === 0) return;

  const idsByLineNumber = new Map(
    (await selectDraftLines(db, draftId)).map((row) => [row.line_number, row.id]),
  );

  await db
    .insertInto('journal_draft_line_dimensions')
    .values(
      tagged.flatMap((line) =>
        line.dimensions.map((tag) => ({
          // Present by construction: the lines were just inserted under this
          // draft, and `uq_journal_draft_lines_draft_line` makes the number unique
          // within it. `?? 0n` would insert a tag against another org's line, so
          // the impossible case throws instead.
          draft_line_id: idsByLineNumber.get(line.lineNumber) ?? missingDraftLine(line.lineNumber),
          dimension_id: tag.dimensionId,
          dimension_value_id: tag.valueId,
        })),
      ),
    )
    .execute();
}

/**
 * Which of `ids` exist in this org, as hex keys.
 *
 * Read through the tenant wrapper, so another org's account is not merely
 * rejected — it does not appear, and the caller reports it as unknown (A7).
 */
export async function selectExistingAccountIds(
  db: TenantDatabase,
  ids: readonly Buffer[],
): Promise<ReadonlySet<string>> {
  if (ids.length === 0) return new Set();

  const rows = await db
    .selectFrom('accounts')
    .select('id')
    .where('accounts.id', 'in', ids)
    .execute();

  return new Set(rows.map((row) => row.id.toString('hex')));
}

export async function selectExistingContactIds(
  db: TenantDatabase,
  ids: readonly Buffer[],
): Promise<ReadonlySet<string>> {
  if (ids.length === 0) return new Set();

  const rows = await db
    .selectFrom('contacts')
    .select('id')
    .where('contacts.id', 'in', ids)
    .execute();

  return new Set(rows.map((row) => row.id.toString('hex')));
}

/**
 * The axis each dimension value belongs to, keyed by the value's hex id.
 *
 * A tag names a value and never a pair, so the axis is derived here — which is
 * what makes a mismatched `(axis, value)` unrepresentable rather than merely
 * refused, the same argument `setJournalLineDimensionsRequestSchema` makes.
 */
export async function selectDimensionAxes(
  db: TenantDatabase,
  valueIds: readonly Buffer[],
): Promise<ReadonlyMap<string, Buffer>> {
  if (valueIds.length === 0) return new Map();

  const rows = await db
    .selectFrom('dimension_values')
    .select(['id', 'dimension_id'])
    .where('dimension_values.id', 'in', valueIds)
    .execute();

  return new Map(rows.map((row) => [row.id.toString('hex'), row.dimension_id]));
}

/**
 * `(created_at, id)` — D-21's ordering for everything that is not the journal
 * list, and the only one available here.
 *
 * The journal list orders by `(entry_date, sequence_number)`; a draft has no
 * sequence number by construction (D-14) and its `entry_date` is nullable, so
 * neither column is total. Both of these are written once, which is the property
 * a keyset ordering needs — `updated_at` moves on every edit and would drop a
 * draft behind a cursor that had already passed it.
 *
 * Reads `idx_journal_drafts_org_created`.
 */
const DRAFT_KEYSET: KeysetOrdering<DraftRow> = [
  instantKey('journal_drafts.created_at', (row) => row.created_at),
  uuidKey('journal_drafts.id', (row) => row.id),
];

export interface DraftFilters {
  /** Already bytes: an author who is not a member of this org matches nothing. */
  readonly createdByUserId?: Buffer | undefined;
  readonly cursor?: string | undefined;
}

export async function selectDraftsPage(
  db: TenantDatabase,
  filters: DraftFilters,
  limit: number,
): Promise<KeysetPage<DraftRow>> {
  let query = db.selectFrom('journal_drafts').select(DRAFT_COLUMNS);

  if (filters.createdByUserId !== undefined) {
    query = query.where('journal_drafts.created_by_user_id', '=', filters.createdByUserId);
  }

  const rows = await applyKeyset(query, DRAFT_KEYSET, limit, filters.cursor).execute();

  return toKeysetPage(rows, DRAFT_KEYSET, limit);
}

export function toDraftSummary(row: DraftRow): JournalDraftSummary {
  return {
    id: bufferToUuid(row.id),
    entryDate: row.entry_date,
    memo: row.memo,
    reference: row.reference,
    createdByUserId: bufferToUuid(row.created_by_user_id),
    // `timezone: 'Z'` on the pool and `DATETIME(3)` left as a `Date`
    // (`src/db/connection.ts`), so these are real instants.
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function toDraft(
  row: DraftRow,
  lines: readonly DraftLineRow[],
  tags: ReadonlyMap<string, readonly string[]>,
): JournalDraft {
  return { ...toDraftSummary(row), lines: lines.map((line) => toDraftLine(line, tags)) };
}

function toDraftLine(
  row: DraftLineRow,
  tags: ReadonlyMap<string, readonly string[]>,
): JournalDraftLine {
  // Derived from which column is non-zero rather than echoed from the request, so
  // this reports what the table holds. A line with no amount has no side: the
  // table has no column for one, and the CHECK that would have made the pair
  // consistent is deliberately absent (a half-entered line is an ordinary state).
  const side = row.debit_minor > 0n ? 'debit' : row.credit_minor > 0n ? 'credit' : null;
  const amount = row.debit_minor > 0n ? row.debit_minor : row.credit_minor;

  return {
    // A `BIGINT`, stringified so it cannot lose precision on the wire — the same
    // reason money is a string (D-13).
    lineId: row.id.toString(),
    lineNumber: row.line_number,
    accountId: row.account_id === null ? null : bufferToUuid(row.account_id),
    contactId: row.contact_id === null ? null : bufferToUuid(row.contact_id),
    side,
    amount: amount.toString(),
    memo: row.memo,
    dimensionValueIds: [...(tags.get(row.id.toString()) ?? [])],
  };
}

function missingDraftLine(lineNumber: number): never {
  throw new Error(
    `Draft line ${String(lineNumber)} was inserted and could not be read back; its tags cannot ` +
      'be attached to a line that is not there.',
  );
}
