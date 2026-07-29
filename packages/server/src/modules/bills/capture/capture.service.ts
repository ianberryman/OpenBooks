import type { InboundEmailAttachment, InboundEmailMessage } from '@openbooks/plugin-api';
import type {
  Bill,
  CreateDraftFromCaptureRequest,
  DocumentCapture,
  DocumentCapturePage,
} from '@openbooks/shared-types';
import {
  createDraftFromCaptureRequestSchema,
  uploadCaptureRequestSchema,
} from '@openbooks/shared-types';
import type { UploadCaptureRequest } from '@openbooks/shared-types';

import { getContext } from '../../../context';
import type { RequestContext } from '../../../context';
import {
  bufferToUuid,
  newUuid,
  newUuidBuffer,
  resolvePageLimit,
  tryUuidToBuffer,
} from '../../../db';
import { InternalError, PreconditionFailedError, assertFound, parseInput } from '../../../errors';
import { queueProvider, storageProvider } from '../../../providers';
import { requirePermission } from '../../permissions';
import { requireAuthor } from '../ap-documents.service';
import { createBill } from '../bills.service';

import type { CaptureFilters, DocumentCaptureRow } from './capture.repository';
import {
  ATTACHMENT_RESOURCE,
  CAPTURE_RESOURCE,
  insertAttachment,
  insertCapture,
  markCaptureDismissed,
  markCaptureDrafted,
  orgScope,
  selectAttachment,
  selectCaptureById,
  selectCaptureByIdForUpdate,
  selectCapturesPage,
} from './capture.repository';
import type { DocumentExtractionJob, DocumentExtractionJobContext } from './extraction.job';
import { DOCUMENT_EXTRACTION_QUEUE } from './extraction.job';

/**
 * OCR bill capture — the staging area between an uploaded or emailed document and
 * a bill a human has reviewed (initiative O, OB-186/187/188/190).
 *
 * ## Surface
 *
 * | Operation                                        | Permission     |
 * | ------------------------------------------------- | -------------- |
 * | `createCaptureFromUpload(input, ctx)`              | `bills.write`  |
 * | `createCaptureFromInbound(msg, orgId, ctx?)`       | `bills.write`  |
 * | `listCaptures(query, ctx)`                         | `bills.read`   |
 * | `getCapture(id, ctx)`                              | `bills.read`   |
 * | `dismissCapture(id, ctx)`                          | `bills.write`  |
 * | `createDraftFromCapture(id, input, ctx)`           | `bills.write`  |
 *
 * No new permission keys (the pinned contract, locked decisions): capturing a
 * bill is writing a bill, so both operations reuse `bills.write`/`bills.read`
 * from the fixed 51-entry catalog exactly as `bills.service.ts` does.
 *
 * ## A capture is a proposal, never a posting
 *
 * `documentCaptureSchema`'s own header says it and it is worth restating here:
 * nothing in this file creates a bill except `createDraftFromCapture`, and even
 * that only creates a **draft** (`journal_id IS NULL`) through the existing
 * `createBill` — approval from there on is the ordinary `approveBill` path,
 * unchanged, with `assertNoDuplicateReference` firing exactly as it does for any
 * other bill. `extractedReference` is surfaced on the read shape precisely so a
 * reviewer sees a potential duplicate before confirming the draft, but this
 * module never checks it itself — that check belongs to approval, not capture.
 *
 * ## The extraction job never touches this file's transactions
 *
 * `createCaptureFromUpload` stores the original, inserts the row, and enqueues
 * `DOCUMENT_EXTRACTION_QUEUE` — all synchronous with the request, all inside
 * whatever ambient transaction `withIdempotency` opened. The job itself
 * (`extraction.job.ts`) runs detached, under `runAsAutomation`, and writes back
 * through the same repository this file uses; there is no second write path.
 */

const RESOURCE = CAPTURE_RESOURCE;

/**
 * The document formats a captured original may be. Mirrors `UPLOAD_CAPTURE_CONTENT_TYPES`
 * in `@openbooks/shared-types/subledger/captures.ts`, which is not exported —
 * `uploadCaptureRequestSchema` already enforces it on the upload path, and this
 * list is what `createCaptureFromInbound` filters an email's attachments by, for
 * the same reason the schema excludes `image/svg+xml`: a captured document is
 * data nobody has reviewed yet, so it must not become a stored-script vector.
 */
const CAPTURABLE_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
]);

function captureStorageKey(orgId: string): string {
  return `org/${orgId}/captures/${newUuid()}`;
}

function jobContextOf(ctx: RequestContext): DocumentExtractionJobContext {
  return {
    requestId: ctx.requestId,
    orgId: ctx.orgId,
    userId: ctx.userId,
    roleId: ctx.roleId,
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    ...(ctx.invocationMode === undefined ? {} : { invocationMode: ctx.invocationMode }),
  };
}

async function enqueueExtraction(
  captureId: Buffer,
  storageKey: string,
  contentType: string,
  ctx: RequestContext,
): Promise<void> {
  const job: DocumentExtractionJob = {
    captureId: bufferToUuid(captureId),
    orgId: ctx.orgId,
    storageKey,
    contentType,
    context: jobContextOf(ctx),
  };
  await queueProvider().enqueue(DOCUMENT_EXTRACTION_QUEUE, job);
}

// ---------------------------------------------------------------------------
// Creating a capture
// ---------------------------------------------------------------------------

/**
 * Stores an uploaded document, writes it `extracting`, and enqueues extraction.
 *
 * `storageProvider().put` runs before any database write, matching
 * `uploadLogo`'s shape (`branding.service.ts`): the object store is not
 * transactional with MySQL, so nothing about wrapping it in the row insert would
 * make the two consistent — it would only hold a connection for the duration of
 * a network call. What has to be right is that the row names the key the bytes
 * were actually stored under, which is a plain insert.
 */
export async function createCaptureFromUpload(
  input: UploadCaptureRequest,
  ctx: RequestContext = getContext('createCaptureFromUpload()'),
): Promise<DocumentCapture> {
  await requirePermission(ctx, 'bills.write');
  const request = parseInput(uploadCaptureRequestSchema, input);
  const author = requireAuthor(ctx);

  const bytes = Buffer.from(request.content, 'base64');
  const key = captureStorageKey(ctx.orgId);
  await storageProvider().put(key, bytes, request.contentType);

  const db = orgScope(ctx);
  const id = newUuidBuffer();
  await insertCapture(db, id, {
    source: 'upload',
    storageKey: key,
    filename: request.filename,
    contentType: request.contentType,
    byteSize: BigInt(bytes.length),
    createdByUserId: author,
  });

  await enqueueExtraction(id, key, request.contentType, ctx);

  return toDocumentCapture(assertFound(await selectCaptureById(db, id), RESOURCE));
}

/**
 * One capture per eligible attachment on an inbound email.
 *
 * Called from the inbound webhook route, already inside
 * `runAsAutomation(orgId, 'document-extraction', …)` (the pinned contract) — so
 * the ambient context is already an automation context scoped to `orgId` by the
 * time this runs, and the trailing `ctx` parameter defaults to it. `orgId` is
 * still taken explicitly, rather than read off `ctx`, because that is the shape
 * the contract pins for this one function: the route resolves the org from the
 * inbound token before any context exists to read it from.
 *
 * Attachments outside `CAPTURABLE_CONTENT_TYPES` are silently skipped rather than
 * failing the whole message — an email with a signature image and a PDF invoice
 * is ordinary, and one unreadable attachment should not sink the readable one.
 */
export async function createCaptureFromInbound(
  msg: InboundEmailMessage,
  orgId: string,
  ctx: RequestContext = getContext('createCaptureFromInbound()'),
): Promise<DocumentCapture[]> {
  await requirePermission(ctx, 'bills.write');
  const author = requireAuthor(ctx);

  const db = orgScope(ctx);
  const created: DocumentCapture[] = [];

  for (const attachment of msg.attachments) {
    if (!isCapturable(attachment)) continue;

    const key = captureStorageKey(orgId);
    await storageProvider().put(key, attachment.body, attachment.contentType);

    const id = newUuidBuffer();
    await insertCapture(db, id, {
      source: 'email',
      storageKey: key,
      filename: attachment.filename,
      contentType: attachment.contentType,
      byteSize: BigInt(attachment.body.length),
      createdByUserId: author,
    });

    await enqueueExtraction(id, key, attachment.contentType, ctx);
    created.push(toDocumentCapture(assertFound(await selectCaptureById(db, id), RESOURCE)));
  }

  return created;
}

function isCapturable(attachment: InboundEmailAttachment): boolean {
  return CAPTURABLE_CONTENT_TYPES.has(attachment.contentType);
}

// ---------------------------------------------------------------------------
// Reading captures back
// ---------------------------------------------------------------------------

export interface ListCapturesQuery {
  readonly status?: DocumentCaptureRow['status'] | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

export async function listCaptures(
  query: ListCapturesQuery,
  ctx: RequestContext = getContext('listCaptures()'),
): Promise<DocumentCapturePage> {
  await requirePermission(ctx, 'bills.read');
  const limit = resolvePageLimit(query.limit);

  const filters: CaptureFilters = {
    ...(query.status === undefined ? {} : { status: query.status }),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
  };

  const page = await selectCapturesPage(orgScope(ctx), filters, limit);
  return { items: page.rows.map(toDocumentCapture), nextCursor: page.nextCursor };
}

export async function getCapture(
  captureId: string,
  ctx: RequestContext = getContext('getCapture()'),
): Promise<DocumentCapture> {
  await requirePermission(ctx, 'bills.read');

  const id = assertFound(tryUuidToBuffer(captureId), RESOURCE);
  const row = assertFound(await selectCaptureById(orgScope(ctx), id), RESOURCE);
  return toDocumentCapture(row);
}

// ---------------------------------------------------------------------------
// Review actions
// ---------------------------------------------------------------------------

/**
 * Dismisses a capture a human has looked at and decided is not a bill (a
 * misdirected scan, a duplicate of one already entered by hand).
 *
 * Reachable only from `extracted` or `failed` — see `assertReviewable`. Dismissing
 * removes nothing: the row, and the original in storage, both stay (there is no
 * append-only argument to make here, per the migration's own header — a capture
 * is working state, not evidence — but there is also no reason to delete it: a
 * dismissed capture is a small, useful record of "we looked at this and it was
 * nothing").
 */
export async function dismissCapture(
  captureId: string,
  ctx: RequestContext = getContext('dismissCapture()'),
): Promise<DocumentCapture> {
  await requirePermission(ctx, 'bills.write');

  return orgScope(ctx).transaction(async (trx) => {
    const id = assertFound(tryUuidToBuffer(captureId), RESOURCE);
    const row = assertFound(await selectCaptureByIdForUpdate(trx, id), RESOURCE);
    assertReviewable(row);

    const updated = await markCaptureDismissed(trx, id, new Date());
    if (updated !== 1) {
      throw new InternalError(
        `Dismissing a capture updated ${String(updated)} rows while holding its row lock. The ` +
          'capture was read FOR UPDATE in this transaction, so its status cannot have changed ' +
          'between the check and the write.',
      );
    }

    return toDocumentCapture(assertFound(await selectCaptureById(trx, id), RESOURCE));
  });
}

/**
 * Confirms a reviewed capture into a draft bill (D-34/D-38's vocabulary, one
 * step back): `createBill` does the real work — this function locks the
 * capture, hands the review-edited payload straight through, attaches the
 * stored original to the new bill, and records `drafted_bill_id`, all in one
 * transaction.
 *
 * `createBill`'s own `orgScope(ctx).transaction(...)` joins the transaction this
 * function opened (`transaction-scope.ts`'s ambient propagation), so a bill that
 * exists with no capture pointing at it, or a capture marked `drafted` with no
 * bill behind it, are both unreachable outcomes rather than a window a crash
 * could land in.
 */
export async function createDraftFromCapture(
  captureId: string,
  input: CreateDraftFromCaptureRequest,
  ctx: RequestContext = getContext('createDraftFromCapture()'),
): Promise<Bill> {
  await requirePermission(ctx, 'bills.write');
  const request = parseInput(createDraftFromCaptureRequestSchema, input);
  const author = requireAuthor(ctx);

  return orgScope(ctx).transaction(async (trx) => {
    const id = assertFound(tryUuidToBuffer(captureId), RESOURCE);
    const row = assertFound(await selectCaptureByIdForUpdate(trx, id), RESOURCE);
    assertReviewable(row);

    // `createDraftFromCaptureRequestSchema` is field-for-field `createBillRequestSchema`
    // (the shared-types header explains why), so the parsed request is handed
    // straight through with no translation — one schema disagreeing with the
    // other would be caught by `yarn build`'s type check, not discovered at review time.
    const bill = await createBill(request, ctx);
    const billId = tryUuidToBuffer(bill.id);
    if (billId === undefined) {
      throw new InternalError(`createBill returned a non-UUID id (${bill.id}).`);
    }

    await insertAttachment(trx, newUuidBuffer(), {
      apDocumentId: billId,
      storageKey: row.storage_key,
      filename: row.filename,
      contentType: row.content_type,
      byteSize: row.byte_size,
      createdByUserId: author,
    });

    const updated = await markCaptureDrafted(trx, id, billId, new Date());
    if (updated !== 1) {
      throw new InternalError(
        `Confirming a capture updated ${String(updated)} rows while holding its row lock. The ` +
          'capture was read FOR UPDATE in this transaction, so its status cannot have changed ' +
          'between the check and the write.',
      );
    }

    return bill;
  });
}

/**
 * Streams a bill's retained attachment, `getPublicInvoiceArtifact`'s shape:
 * verify the reference, then read the bytes back through `storageProvider().get`.
 */
export async function getBillAttachment(
  billId: string,
  attachmentId: string,
  ctx: RequestContext = getContext('getBillAttachment()'),
): Promise<{
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly filename: string;
}> {
  await requirePermission(ctx, 'bills.read');

  const documentId = assertFound(tryUuidToBuffer(billId), ATTACHMENT_RESOURCE);
  const id = assertFound(tryUuidToBuffer(attachmentId), ATTACHMENT_RESOURCE);
  const row = assertFound(
    await selectAttachment(orgScope(ctx), documentId, id),
    ATTACHMENT_RESOURCE,
  );

  const bytes = await storageProvider().get(row.storage_key);
  return { bytes, contentType: row.content_type, filename: row.filename };
}

// ---------------------------------------------------------------------------
// Shared checks and conversions
// ---------------------------------------------------------------------------

/**
 * Refuses a review action outside `extracted`/`failed` — the lock-and-check half
 * of `markCaptureDismissed`/`markCaptureDrafted`'s `WHERE` guard, giving each
 * unreachable state its own token rather than one undifferentiated refusal.
 */
function assertReviewable(row: DocumentCaptureRow): void {
  if (row.status === 'extracted' || row.status === 'failed') return;

  if (row.status === 'extracting') {
    throw new PreconditionFailedError(
      'capture_extracting',
      'This capture is still being extracted. Wait for it to finish, or check back shortly.',
    );
  }
  if (row.status === 'drafted') {
    throw new PreconditionFailedError(
      'capture_already_drafted',
      'This capture has already become a draft bill. Review happens once; edit the bill instead.',
    );
  }
  throw new PreconditionFailedError(
    'capture_dismissed',
    'This capture has already been dismissed. Review happens once.',
  );
}

/**
 * `document_captures.extraction_json`'s in-process shape: the whole `ExtractedBill`
 * the job wrote, read back for the `lines` the wire schema surfaces flat.
 */
interface StoredExtraction {
  readonly lines?: readonly {
    readonly description: string | null;
    readonly quantity: string;
    readonly unitAmountMinor: string;
  }[];
}

function toDocumentCapture(row: DocumentCaptureRow): DocumentCapture {
  const stored = (row.extraction_json ?? null) as StoredExtraction | null;
  const lines = stored?.lines ?? [];

  return {
    id: bufferToUuid(row.id),
    source: row.source,
    status: row.status,
    filename: row.filename,
    contentType: row.content_type,
    byteSize: Number(row.byte_size),
    extractedVendorName: row.extracted_vendor_name,
    matchedContactId: row.matched_contact_id === null ? null : bufferToUuid(row.matched_contact_id),
    extractedIssueDate: row.extracted_issue_date,
    extractedReference: row.extracted_reference,
    extractedTotalMinor:
      row.extracted_total_minor === null ? null : row.extracted_total_minor.toString(),
    lines: lines.map((line) => ({
      description: line.description,
      quantity: line.quantity,
      unitAmount: line.unitAmountMinor,
    })),
    extractionError: row.extraction_error,
    draftedBillId: row.drafted_bill_id === null ? null : bufferToUuid(row.drafted_bill_id),
    createdAt: row.created_at.toISOString(),
  };
}
