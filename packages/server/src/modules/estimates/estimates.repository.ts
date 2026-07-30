import { sql } from 'kysely';
import type { Expression, SqlBool } from 'kysely';

import type { RequestContext } from '../../context';
import type { KeysetOrdering, KeysetPage, TenantDatabase } from '../../db';
import {
  applyKeyset,
  instantKey,
  newUuidBuffer,
  orgScope as toOrgId,
  tenantDb,
  toKeysetPage,
  tryUuidToBuffer,
  uuidKey,
} from '../../db';

/**
 * Data access for `estimates` and `estimate_lines` (initiative M, OB-175…176;
 * ROADMAP D-M3, D-M6, D-M7).
 *
 * The AR mirror of `ar-documents.repository.ts`, restricted to what an estimate
 * actually is: a non-posting pre-document with no journal, no allocations and no
 * dimension tags on its lines (D-M7). What that removes relative to the AR
 * original:
 *
 *  - No `journal_id`/`void_journal_id` — there is nothing here for a journal to
 *    attach to, only `sequence_number`/`approved_at` (set together,
 *    `chk_estimates_approved`) and `converted_invoice_id`/`converted_at` (set
 *    together, `chk_estimates_converted`).
 *  - No allocations, so the page read carries only `net`/`tax`, not a third
 *    "allocated" sum.
 *  - No `estimate_line_dimensions` table, so `replaceEstimateLines` is a plain
 *    delete-then-insert with no second statement for tags.
 *
 * Everything that *is* shared with `ar_documents` — the account/tax-rate
 * existence checks, the tax-rate row shape, the contact existence check — is
 * imported from `ar-documents.repository.ts` rather than redefined; see
 * `estimates.service.ts` for those imports. This file owns only what is specific
 * to the `estimates`/`estimate_lines` tables themselves.
 */

const ESTIMATE_COLUMNS = [
  'id',
  'sequence_number',
  'contact_id',
  'issue_date',
  'expiry_date',
  'tax_mode',
  'reference',
  'memo',
  'approved_at',
  'converted_invoice_id',
  'converted_at',
  'created_at',
  'updated_at',
] as const;

const LINE_COLUMNS = [
  'id',
  'line_number',
  'description',
  'quantity_micros',
  'unit_amount_minor',
  'account_id',
  'tax_rate_id',
  'line_amount_minor',
  'tax_amount_minor',
] as const;

export interface EstimateRow {
  readonly id: Buffer;
  readonly sequence_number: bigint | null;
  readonly contact_id: Buffer;
  readonly issue_date: string;
  readonly expiry_date: string | null;
  readonly tax_mode: 'exclusive' | 'inclusive';
  readonly reference: string | null;
  readonly memo: string | null;
  readonly approved_at: Date | null;
  readonly converted_invoice_id: Buffer | null;
  readonly converted_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface EstimateLineRow {
  readonly id: bigint;
  readonly line_number: number;
  readonly description: string | null;
  readonly quantity_micros: bigint;
  readonly unit_amount_minor: bigint;
  readonly account_id: Buffer;
  readonly tax_rate_id: Buffer | null;
  readonly line_amount_minor: bigint;
  readonly tax_amount_minor: bigint;
}

/** An estimate plus the two sums a summary needs, from one statement. */
export interface EstimatePageRow extends EstimateRow {
  readonly net: string | number | bigint;
  readonly tax: string | number | bigint;
}

export interface NewEstimateRow {
  readonly createdByUserId: Buffer;
  readonly contactId: Buffer;
  readonly issueDate: string;
  readonly expiryDate: string | null;
  readonly taxMode: 'exclusive' | 'inclusive';
  readonly reference: string | null;
  readonly memo: string | null;
}

export interface EstimatePatch {
  readonly contactId?: Buffer;
  readonly issueDate?: string;
  readonly expiryDate?: string | null;
  readonly taxMode?: 'exclusive' | 'inclusive';
  readonly reference?: string | null;
  readonly memo?: string | null;
}

/** A line as the service has priced it: ids as bytes, both roundings already made. */
export interface NewEstimateLineRow {
  readonly lineNumber: number;
  readonly description: string;
  readonly quantityMicros: bigint;
  readonly unitAmountMinor: bigint;
  readonly accountId: Buffer;
  readonly taxRateId: Buffer | null;
  readonly lineAmountMinor: bigint;
  readonly taxAmountMinor: bigint;
}

/** The org-scoped handle for the current operation (spec §4: no org parameters). */
export function orgScope(ctx: RequestContext): TenantDatabase {
  return tenantDb(toOrgId(ctx.orgId));
}

/**
 * A client-supplied estimate id as bytes, or `undefined` when it is not a UUID.
 *
 * Undefined rather than a throw, so the service routes a malformed id through
 * `assertFound` to the same 404 a nonexistent one produces (A7).
 */
export function estimateIdBytes(estimateId: string): Buffer | undefined {
  return tryUuidToBuffer(estimateId);
}

export function newEstimateId(): Buffer {
  return newUuidBuffer();
}

export async function insertEstimate(
  db: TenantDatabase,
  id: Buffer,
  input: NewEstimateRow,
): Promise<void> {
  await db
    .insertInto('estimates')
    .values({
      id,
      contact_id: input.contactId,
      issue_date: input.issueDate,
      expiry_date: input.expiryDate,
      tax_mode: input.taxMode,
      reference: input.reference,
      memo: input.memo,
      created_by_user_id: input.createdByUserId,
    })
    .execute();
}

export async function selectEstimateById(
  db: TenantDatabase,
  id: Buffer,
): Promise<EstimateRow | undefined> {
  return db
    .selectFrom('estimates')
    .select(ESTIMATE_COLUMNS)
    .where('estimates.id', '=', id)
    .executeTakeFirst();
}

/**
 * The same read, taking an exclusive row lock.
 *
 * The serialization point for every write to an estimate — update, discard,
 * approve, convert. Two callers approving one estimate both reach this
 * statement; the second blocks until the first commits and then sees a row that
 * already carries a number, which is what turns "two approvals" into one number
 * and one refusal. Works only because `estimates` is in `0999_app_grants`'s
 * mutable allowlist (D-14).
 */
export async function selectEstimateByIdForUpdate(
  db: TenantDatabase,
  id: Buffer,
): Promise<EstimateRow | undefined> {
  return db
    .selectFrom('estimates')
    .select(ESTIMATE_COLUMNS)
    .where('estimates.id', '=', id)
    .forUpdate()
    .executeTakeFirst();
}

/**
 * Applies the header patch, and always writes `updated_at` — `updateDocumentRow`'s
 * reason: an edit that replaced only the lines would otherwise leave the header's
 * `updated_at` stale.
 */
export async function updateEstimateRow(
  db: TenantDatabase,
  id: Buffer,
  patch: EstimatePatch,
  now: Date,
): Promise<void> {
  await db
    .updateTable('estimates')
    .set({
      ...(patch.contactId === undefined ? {} : { contact_id: patch.contactId }),
      ...(patch.issueDate === undefined ? {} : { issue_date: patch.issueDate }),
      ...(patch.expiryDate === undefined ? {} : { expiry_date: patch.expiryDate }),
      ...(patch.taxMode === undefined ? {} : { tax_mode: patch.taxMode }),
      ...(patch.reference === undefined ? {} : { reference: patch.reference }),
      ...(patch.memo === undefined ? {} : { memo: patch.memo }),
      updated_at: now,
    })
    .where('estimates.id', '=', id)
    .execute();
}

/**
 * Writes the two columns that make an estimate approved, together.
 *
 * `chk_estimates_approved` asserts `(sequence_number IS NULL) = (approved_at IS
 * NULL)`, so this pair cannot be written apart — the same shape `markApproved`
 * takes on `ar_documents`, with a number in place of a journal because an
 * estimate posts none (D-M3).
 */
export async function approveEstimateRow(
  db: TenantDatabase,
  id: Buffer,
  sequenceNumber: bigint,
  approvedAt: Date,
): Promise<number> {
  const result = await db
    .updateTable('estimates')
    .set({ sequence_number: sequenceNumber, approved_at: approvedAt, updated_at: approvedAt })
    .where('estimates.id', '=', id)
    // Belt to the row lock's braces, `markApproved`'s reason exactly: an approval
    // can only ever move an estimate out of the draft state.
    .where('estimates.approved_at', 'is', null)
    .executeTakeFirst();

  return Number(result.numUpdatedRows);
}

/**
 * Writes the pair that makes an estimate converted, together.
 *
 * `chk_estimates_converted` ties `converted_invoice_id` to `converted_at`
 * exactly as `chk_estimates_approved` ties the approval pair — a half-converted
 * estimate is unrepresentable rather than merely avoided (D-M4).
 */
export async function markEstimateConverted(
  db: TenantDatabase,
  id: Buffer,
  invoiceId: Buffer,
  convertedAt: Date,
): Promise<number> {
  const result = await db
    .updateTable('estimates')
    .set({ converted_invoice_id: invoiceId, converted_at: convertedAt, updated_at: convertedAt })
    .where('estimates.id', '=', id)
    // Convert-once, enforced here as well as by the service's row lock: a
    // caller that somehow reached this without the lock cannot re-convert an
    // already-converted row.
    .where('estimates.converted_invoice_id', 'is', null)
    .executeTakeFirst();

  return Number(result.numUpdatedRows);
}

/**
 * Deletes an estimate and, through `ON DELETE CASCADE`, its lines.
 *
 * Only ever called for a draft — the service's restriction, since a CHECK cannot
 * govern a DELETE. The `sequence_number IS NULL` predicate is the same belt the
 * approve/convert writes wear: a discard racing an approval is settled by
 * whichever reaches the row lock first.
 */
export async function deleteEstimate(db: TenantDatabase, id: Buffer): Promise<number> {
  const result = await db
    .deleteFrom('estimates')
    .where('estimates.id', '=', id)
    .where('estimates.sequence_number', 'is', null)
    .executeTakeFirst();

  return Number(result.numDeletedRows);
}

export async function selectEstimateLines(
  db: TenantDatabase,
  estimateId: Buffer,
): Promise<readonly EstimateLineRow[]> {
  return db
    .selectFrom('estimate_lines')
    .select(LINE_COLUMNS)
    .where('estimate_lines.estimate_id', '=', estimateId)
    .orderBy('estimate_lines.line_number')
    .execute();
}

/**
 * Replaces an estimate's lines wholesale.
 *
 * Delete-then-insert rather than a diff, `replaceDocumentLines`'s reason
 * restated: `lines` on the wire is a whole set. No tag re-insert step here — a
 * predocument line carries none (D-M7).
 */
export async function replaceEstimateLines(
  db: TenantDatabase,
  estimateId: Buffer,
  lines: readonly NewEstimateLineRow[],
): Promise<void> {
  await db
    .deleteFrom('estimate_lines')
    .where('estimate_lines.estimate_id', '=', estimateId)
    .execute();

  if (lines.length === 0) return;

  await db
    .insertInto('estimate_lines')
    .values(
      lines.map((line) => ({
        estimate_id: estimateId,
        line_number: line.lineNumber,
        description: line.description,
        quantity_micros: line.quantityMicros,
        unit_amount_minor: line.unitAmountMinor,
        account_id: line.accountId,
        tax_rate_id: line.taxRateId,
        line_amount_minor: line.lineAmountMinor,
        tax_amount_minor: line.taxAmountMinor,
      })),
    )
    .execute();
}

/**
 * The next number in this org's `'estimate'` series, taken `FOR UPDATE`
 * (D-36, applied to a pre-document by D-M3).
 *
 * The same insert-then-lock shape as `allocateDocumentNumber` in
 * `ar-documents.repository.ts`, restated here rather than called there: that
 * function's `documentType` parameter is typed to the two AR document kinds and
 * does not accept `'estimate'`, and widening it would let an invoice or credit
 * note number be requested through a name that reads as estimate-only. The
 * counter row itself is the same `document_sequences` table and the same
 * `(org_id, document_type)` key (`0005_subledger`, extended by `0015` to carry
 * `'estimate'`) — only the call site is separate.
 */
export async function claimEstimateNumber(db: TenantDatabase): Promise<bigint> {
  await db
    .insertInto('document_sequences')
    .values({ document_type: 'estimate', next_value: 1n })
    .onDuplicateKeyUpdate({ document_type: 'estimate' })
    .execute();

  const counter = await db
    .selectFrom('document_sequences')
    .select('next_value')
    .where('document_sequences.document_type', '=', 'estimate')
    .forUpdate()
    .executeTakeFirstOrThrow();

  await db
    .updateTable('document_sequences')
    .set({ next_value: counter.next_value + 1n })
    .where('document_sequences.document_type', '=', 'estimate')
    .execute();

  return counter.next_value;
}

// ---------------------------------------------------------------------------
// The computed numbers: totals, never stored (D-34's argument, applied to a
// document that posts no journal at all)
// ---------------------------------------------------------------------------

const NET_EXPRESSION = sql<string>`(
  SELECT COALESCE(SUM(l.line_amount_minor), 0) FROM estimate_lines l
  WHERE l.org_id = estimates.org_id AND l.estimate_id = estimates.id
)`;

const TAX_EXPRESSION = sql<string>`(
  SELECT COALESCE(SUM(l.tax_amount_minor), 0) FROM estimate_lines l
  WHERE l.org_id = estimates.org_id AND l.estimate_id = estimates.id
)`;

/** `SUM` columns arrive as a DECIMAL string; plain `BIGINT` columns as a `bigint`. */
export function toBigInt(value: string | number | bigint): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}

export interface EstimateFilters {
  readonly cursor?: string | undefined;
  readonly contactId?: Buffer | undefined;
  readonly status?: 'approved' | 'converted' | 'draft' | undefined;
}

/**
 * `(created_at, id)` — `DOCUMENT_KEYSET`'s reasons exactly: an estimate's own
 * number is null until approval and `issue_date` stays editable while it is a
 * draft, so neither can be the keyset column.
 *
 * Reads `idx_estimates_org_created`.
 */
const ESTIMATE_KEYSET: KeysetOrdering<EstimatePageRow> = [
  instantKey('estimates.created_at', (row) => row.created_at),
  uuidKey('estimates.id', (row) => row.id),
];

/**
 * One page of the org's estimates, with the stored status filtered **in the
 * statement** — unlike `ar_documents`' status this one is a stored column
 * comparison, not a join against allocations, but it is filtered here for the
 * same paging reason: filtering after the fetch would make the page size depend
 * on the data.
 */
export async function selectEstimatesPage(
  db: TenantDatabase,
  filters: EstimateFilters,
  limit: number,
): Promise<KeysetPage<EstimatePageRow>> {
  let query = db
    .selectFrom('estimates')
    .select([...ESTIMATE_COLUMNS, NET_EXPRESSION.as('net'), TAX_EXPRESSION.as('tax')]);

  if (filters.contactId !== undefined) {
    query = query.where('estimates.contact_id', '=', filters.contactId);
  }
  if (filters.status !== undefined) {
    query = query.where(statusPredicate(filters.status));
  }

  const rows = await applyKeyset(query, ESTIMATE_KEYSET, limit, filters.cursor).execute();
  return toKeysetPage(rows, ESTIMATE_KEYSET, limit);
}

function statusPredicate(status: 'approved' | 'converted' | 'draft'): Expression<SqlBool> {
  switch (status) {
    case 'draft':
      return sql<SqlBool>`estimates.sequence_number IS NULL`;
    case 'approved':
      return sql<SqlBool>`estimates.sequence_number IS NOT NULL
        AND estimates.converted_invoice_id IS NULL`;
    case 'converted':
      return sql<SqlBool>`estimates.converted_invoice_id IS NOT NULL`;
  }
}
