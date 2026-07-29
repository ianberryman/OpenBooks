import type { Selectable } from 'kysely';

import type { RequestContext } from '../../../context';
import type { DB, KeysetOrdering, KeysetPage, TenantDatabase } from '../../../db';
import {
  applyKeyset,
  instantKey,
  orgScope as toOrgId,
  tenantDb,
  toKeysetPage,
  uuidKey,
} from '../../../db';

/**
 * Data access for `document_captures` and `bill_attachments` (initiative O,
 * OB-186…190).
 *
 * Everything goes through `tenantDb`, exactly as `ap-documents.repository.ts`
 * argues: every statement here already carries `org_id = ctx.orgId` before the
 * caller adds anything, so a cross-org capture id matches nothing and the
 * service's `assertFound` turns that into the one error a miss is allowed to
 * produce (A7).
 *
 * Both tables are in `0999_app_grants`'s mutable allowlist (the migration's own
 * header explains why: a capture is working state, not ledger evidence), which is
 * what makes `selectCaptureByIdForUpdate`'s locking read possible — MySQL refuses
 * a locking read without `UPDATE`/`DELETE` alongside `SELECT` (D-14).
 */

export const CAPTURE_RESOURCE = 'document_capture';
export const ATTACHMENT_RESOURCE = 'bill_attachment';

const CAPTURE_COLUMNS = [
  'id',
  'org_id',
  'source',
  'status',
  'storage_key',
  'filename',
  'content_type',
  'byte_size',
  'extracted_vendor_name',
  'matched_contact_id',
  'extracted_issue_date',
  'extracted_reference',
  'extracted_total_minor',
  'extraction_json',
  'extraction_error',
  'drafted_bill_id',
  'created_by_user_id',
  'created_at',
  'updated_at',
] as const;

const ATTACHMENT_COLUMNS = [
  'id',
  'org_id',
  'ap_document_id',
  'storage_key',
  'filename',
  'content_type',
  'byte_size',
  'created_by_user_id',
  'created_at',
] as const;

export type DocumentCaptureRow = Selectable<DB['document_captures']>;
export type BillAttachmentRow = Selectable<DB['bill_attachments']>;

export interface NewCaptureRow {
  readonly source: DocumentCaptureRow['source'];
  readonly storageKey: string;
  readonly filename: string;
  readonly contentType: string;
  readonly byteSize: bigint;
  readonly createdByUserId: Buffer;
}

/** What the extraction job writes back on success. See `extraction.job.ts`. */
export interface ExtractedFieldsPatch {
  readonly vendorName: string | null;
  readonly matchedContactId: Buffer | null;
  readonly issueDate: string | null;
  readonly reference: string | null;
  readonly totalMinor: bigint | null;
  /** Pre-serialized (`JSON.stringify`) — see `response_body`'s precedent in `modules/idempotency`. */
  readonly extractionJson: string;
}

export interface NewAttachmentRow {
  readonly apDocumentId: Buffer;
  readonly storageKey: string;
  readonly filename: string;
  readonly contentType: string;
  readonly byteSize: bigint;
  readonly createdByUserId: Buffer;
}

export interface VendorContactRow {
  readonly id: Buffer;
  readonly display_name: string;
}

/** The org-scoped handle for the current operation (spec §4: no org parameters). */
export function orgScope(ctx: RequestContext): TenantDatabase {
  return tenantDb(toOrgId(ctx.orgId));
}

export async function insertCapture(
  db: TenantDatabase,
  id: Buffer,
  input: NewCaptureRow,
): Promise<void> {
  await db
    .insertInto('document_captures')
    .values({
      id,
      source: input.source,
      status: 'extracting',
      storage_key: input.storageKey,
      filename: input.filename,
      content_type: input.contentType,
      byte_size: input.byteSize,
      created_by_user_id: input.createdByUserId,
    })
    .execute();
}

export async function selectCaptureById(
  db: TenantDatabase,
  id: Buffer,
): Promise<DocumentCaptureRow | undefined> {
  return db
    .selectFrom('document_captures')
    .select(CAPTURE_COLUMNS)
    .where('document_captures.id', '=', id)
    .executeTakeFirst();
}

/**
 * The same read, taking an exclusive row lock.
 *
 * The serialization point for `dismissCapture` and `createDraftFromCapture`: two
 * callers reviewing one capture both reach this statement, the second blocks
 * until the first commits, and then sees the status the first one left — which is
 * what turns "reviewed twice" into one outcome and one refusal, `approveDocument`'s
 * shape applied one layer back.
 */
export async function selectCaptureByIdForUpdate(
  db: TenantDatabase,
  id: Buffer,
): Promise<DocumentCaptureRow | undefined> {
  return db
    .selectFrom('document_captures')
    .select(CAPTURE_COLUMNS)
    .where('document_captures.id', '=', id)
    .forUpdate()
    .executeTakeFirst();
}

/**
 * Writes the extraction result and moves the row to `extracted`.
 *
 * `WHERE status = 'extracting'` makes this idempotent under D-49's crash-recovery
 * shape: a job that runs twice (a redelivered message, a re-run after a restart)
 * writes nothing the second time, because the row is no longer `extracting`. The
 * returned count is how the caller tells "wrote it" from "already done".
 */
export async function markCaptureExtracted(
  db: TenantDatabase,
  id: Buffer,
  patch: ExtractedFieldsPatch,
  now: Date,
): Promise<number> {
  const result = await db
    .updateTable('document_captures')
    .set({
      status: 'extracted',
      extracted_vendor_name: patch.vendorName,
      matched_contact_id: patch.matchedContactId,
      extracted_issue_date: patch.issueDate,
      extracted_reference: patch.reference,
      extracted_total_minor: patch.totalMinor,
      extraction_json: patch.extractionJson,
      updated_at: now,
    })
    .where('document_captures.id', '=', id)
    .where('document_captures.status', '=', 'extracting')
    .executeTakeFirst();

  return Number(result.numUpdatedRows);
}

/** As `markCaptureExtracted`, for the failure path. Same idempotency guard. */
export async function markCaptureFailed(
  db: TenantDatabase,
  id: Buffer,
  reason: string,
  now: Date,
): Promise<number> {
  const result = await db
    .updateTable('document_captures')
    .set({ status: 'failed', extraction_error: reason, updated_at: now })
    .where('document_captures.id', '=', id)
    .where('document_captures.status', '=', 'extracting')
    .executeTakeFirst();

  return Number(result.numUpdatedRows);
}

/**
 * Moves a reviewed capture to `dismissed`.
 *
 * `WHERE status IN ('extracted','failed')` is the review gate: a capture still
 * `extracting` has nothing to review yet, and one already `drafted`/`dismissed`
 * has been reviewed once already (D-38's "approval happens once" restated one
 * layer back). The service reads the row `FOR UPDATE` first and turns a zero
 * count here into the specific refusal — see `assertReviewable`.
 */
export async function markCaptureDismissed(
  db: TenantDatabase,
  id: Buffer,
  now: Date,
): Promise<number> {
  const result = await db
    .updateTable('document_captures')
    .set({ status: 'dismissed', updated_at: now })
    .where('document_captures.id', '=', id)
    .where('document_captures.status', 'in', ['extracted', 'failed'])
    .executeTakeFirst();

  return Number(result.numUpdatedRows);
}

/** As `markCaptureDismissed`, recording the draft bill this capture became. */
export async function markCaptureDrafted(
  db: TenantDatabase,
  id: Buffer,
  draftedBillId: Buffer,
  now: Date,
): Promise<number> {
  const result = await db
    .updateTable('document_captures')
    .set({ status: 'drafted', drafted_bill_id: draftedBillId, updated_at: now })
    .where('document_captures.id', '=', id)
    .where('document_captures.status', 'in', ['extracted', 'failed'])
    .executeTakeFirst();

  return Number(result.numUpdatedRows);
}

// ---------------------------------------------------------------------------
// Listing (D-21)
// ---------------------------------------------------------------------------

/**
 * `(created_at, id)` — D-21's ordering for everything that is not the journal
 * list. `status` is written exactly once past `extracting` in the ordinary
 * lifecycle (extraction, then one review action), and `created_at`/`id` are
 * written once ever, so the tuple is total and stable under paging.
 */
const CAPTURE_KEYSET: KeysetOrdering<DocumentCaptureRow> = [
  instantKey('document_captures.created_at', (row) => row.created_at),
  uuidKey('document_captures.id', (row) => row.id),
];

export interface CaptureFilters {
  readonly status?: DocumentCaptureRow['status'] | undefined;
  readonly cursor?: string | undefined;
}

export async function selectCapturesPage(
  db: TenantDatabase,
  filters: CaptureFilters,
  limit: number,
): Promise<KeysetPage<DocumentCaptureRow>> {
  let query = db.selectFrom('document_captures').select(CAPTURE_COLUMNS);

  if (filters.status !== undefined) {
    query = query.where('document_captures.status', '=', filters.status);
  }

  const rows = await applyKeyset(query, CAPTURE_KEYSET, limit, filters.cursor).execute();
  return toKeysetPage(rows, CAPTURE_KEYSET, limit);
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export async function insertAttachment(
  db: TenantDatabase,
  id: Buffer,
  input: NewAttachmentRow,
): Promise<void> {
  await db
    .insertInto('bill_attachments')
    .values({
      id,
      ap_document_id: input.apDocumentId,
      storage_key: input.storageKey,
      filename: input.filename,
      content_type: input.contentType,
      byte_size: input.byteSize,
      created_by_user_id: input.createdByUserId,
    })
    .execute();
}

/**
 * One attachment, scoped to the bill it is supposed to belong to.
 *
 * The `ap_document_id` predicate is not an optimization: an attachment id that is
 * real but belongs to a *different* document must miss exactly as a nonexistent
 * one does (A7 applied to a two-segment path), so both conditions are one query
 * rather than "does the bill exist" followed by "does the attachment exist".
 */
export async function selectAttachment(
  db: TenantDatabase,
  apDocumentId: Buffer,
  attachmentId: Buffer,
): Promise<BillAttachmentRow | undefined> {
  return db
    .selectFrom('bill_attachments')
    .select(ATTACHMENT_COLUMNS)
    .where('bill_attachments.id', '=', attachmentId)
    .where('bill_attachments.ap_document_id', '=', apDocumentId)
    .executeTakeFirst();
}

// ---------------------------------------------------------------------------
// Vendor matching (reuses `banking/matching/scoring.ts`'s name semantics)
// ---------------------------------------------------------------------------

/** Active vendor contacts, for the extraction job's name match. No paging: a name match needs the whole set. */
export async function selectActiveVendorContacts(
  db: TenantDatabase,
): Promise<readonly VendorContactRow[]> {
  return db
    .selectFrom('contacts')
    .select(['id', 'display_name'])
    .where('contacts.is_vendor', '=', 1)
    .where('contacts.is_active', '=', 1)
    .execute();
}
