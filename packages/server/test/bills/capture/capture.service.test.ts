import { beforeEach, describe, expect, it } from 'vitest';

import { toWireError } from '../../../src/errors';
import {
  createCaptureFromUpload,
  createDraftFromCapture,
  dismissCapture,
  getBillAttachment,
  getCapture,
  listCaptures,
} from '../../../src/modules/bills';
import { bufferToUuid, uuidToBuffer } from '../../db';
import type { CaptureScene } from './support';
import {
  captureRow,
  memberOf,
  sceneIn,
  uploadRequestFor,
  useExtractionQueue,
  useLocalStorage,
  useServiceDatabase,
  vendorIn,
  withContext,
} from './support';

/**
 * OCR bill capture — the upload → extract → review lifecycle (initiative O,
 * OB-186/187/188/190; the pinned OCR contract). Runs the real deterministic
 * extraction adapter, the real `InProcessQueue`, and the real local
 * `StorageProvider`, spec §11's "no mocks" applied to the whole pipeline.
 */
const db = useServiceDatabase();
useLocalStorage();
const queue = useExtractionQueue();

let s: CaptureScene;

beforeEach(async () => {
  s = await sceneIn(db);
});

async function wireErrorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (thrown: unknown) => toWireError(thrown),
  );
}

describe('upload → extraction (the happy path)', () => {
  it('is written extracting, then settles to extracted with the parsed fields (E10-shaped)', async () => {
    const request = uploadRequestFor({
      vendor: 'Acme Supplies',
      date: '2026-07-20',
      reference: 'INV-4471',
      tax: '0',
      lines: [
        { description: 'Widgets', quantity: '2', unitAmountMinor: '15000' },
        { description: 'Freight', quantity: '1', unitAmountMinor: '5000' },
      ],
    });

    const capture = await withContext(s.ctx, () => createCaptureFromUpload(request, s.ctx));
    expect(capture.status).toBe('extracting');
    expect(capture.lines).toEqual([]);

    await queue().settled();

    const settled = await withContext(s.ctx, () => getCapture(capture.id, s.ctx));
    expect(settled.status).toBe('extracted');
    expect(settled.extractedIssueDate).toBe('2026-07-20');
    expect(settled.extractedReference).toBe('INV-4471');
    // 2 × 15000 + 1 × 5000 = 35000, computed by the deterministic adapter itself.
    expect(settled.extractedTotalMinor).toBe('35000');
    expect(settled.lines).toEqual([
      { description: 'Widgets', quantity: '2', unitAmount: '15000' },
      { description: 'Freight', quantity: '1', unitAmount: '5000' },
    ]);
  });

  it('extraction failure lands the capture in `failed` with a reason, never crashes the job', async () => {
    // `12.34` is not a minor-units string (D-13): `fromMinorString` refuses it, so
    // the extraction job's own re-parse (`normalizeExtraction`) throws before
    // anything is stored — the guard against a buggy adapter, exercised for real.
    const request = uploadRequestFor({ vendor: 'Acme', total: '12.34' });

    const capture = await withContext(s.ctx, () => createCaptureFromUpload(request, s.ctx));
    await queue().settled();

    const row = await captureRow(db.app, uuidToBuffer(capture.id));
    expect(row?.status).toBe('failed');
    expect(row?.extraction_error).toBeTruthy();

    const settled = await withContext(s.ctx, () => getCapture(capture.id, s.ctx));
    expect(settled.status).toBe('failed');
    expect(settled.extractionError).toBeTruthy();
  });
});

describe('vendor matching (reuses banking/matching/scoring.ts)', () => {
  it('sets matchedContactId when exactly one active vendor matches the extracted name', async () => {
    const vendorRow = await db.app
      .selectFrom('contacts')
      .select(['display_name'])
      .where('id', '=', s.vendorId)
      .executeTakeFirstOrThrow();

    const capture = await withContext(s.ctx, () =>
      createCaptureFromUpload(uploadRequestFor({ vendor: vendorRow.display_name }), s.ctx),
    );
    await queue().settled();

    const settled = await withContext(s.ctx, () => getCapture(capture.id, s.ctx));
    expect(settled.matchedContactId).toBe(s.vendorUuid);
  });

  it('leaves matchedContactId null when no active vendor matches', async () => {
    const request = uploadRequestFor({ vendor: 'Nobody Ever Heard Of This Company' });

    const capture = await withContext(s.ctx, () => createCaptureFromUpload(request, s.ctx));
    await queue().settled();

    const settled = await withContext(s.ctx, () => getCapture(capture.id, s.ctx));
    expect(settled.matchedContactId).toBeNull();
  });

  it('leaves matchedContactId null when the name matches more than one active vendor', async () => {
    // Two vendors whose normalized names both contain "Bright" (`namesMatch`'s
    // containment rule), so extracting "Bright" is genuinely ambiguous.
    await vendorIn(db, s.orgId, 'Bright Ltd');
    await vendorIn(db, s.orgId, 'Bright Supplies');

    const request = uploadRequestFor({ vendor: 'Bright' });
    const capture = await withContext(s.ctx, () => createCaptureFromUpload(request, s.ctx));
    await queue().settled();

    const settled = await withContext(s.ctx, () => getCapture(capture.id, s.ctx));
    expect(settled.matchedContactId).toBeNull();
  });

  it('never matches an inactive or non-vendor contact', async () => {
    await vendorIn(db, s.orgId, 'Dormant Co', { isActive: false });
    await vendorIn(db, s.orgId, 'Customer Only Co', { isVendor: false });

    const request = uploadRequestFor({ vendor: 'Dormant Co' });
    const capture = await withContext(s.ctx, () => createCaptureFromUpload(request, s.ctx));
    await queue().settled();

    const settled = await withContext(s.ctx, () => getCapture(capture.id, s.ctx));
    expect(settled.matchedContactId).toBeNull();
  });
});

describe('listing and reading', () => {
  it('lists captures oldest first, filterable by status', async () => {
    const first = await withContext(s.ctx, () =>
      createCaptureFromUpload(uploadRequestFor({ vendor: 'A' }), s.ctx),
    );
    const second = await withContext(s.ctx, () =>
      createCaptureFromUpload(uploadRequestFor({ vendor: 'B' }), s.ctx),
    );
    await queue().settled();

    const page = await withContext(s.ctx, () => listCaptures({}, s.ctx));
    expect(page.items.map((item) => item.id)).toEqual([first.id, second.id]);

    const extractedOnly = await withContext(s.ctx, () =>
      listCaptures({ status: 'extracted' }, s.ctx),
    );
    expect(extractedOnly.items.every((item) => item.status === 'extracted')).toBe(true);
  });

  it('a cross-org capture id is a 404, never a different org’s row (A7)', async () => {
    const other = await sceneIn(db);
    const capture = await withContext(s.ctx, () =>
      createCaptureFromUpload(uploadRequestFor({ vendor: 'A' }), s.ctx),
    );

    const error = await wireErrorOf(
      withContext(other.ctx, () => getCapture(capture.id, other.ctx)),
    );
    expect(error).toMatchObject({ code: 'not_found' });
  });
});

describe('dismissCapture', () => {
  it('moves an extracted capture to dismissed, and refuses a second dismissal', async () => {
    const capture = await withContext(s.ctx, () =>
      createCaptureFromUpload(uploadRequestFor({ vendor: 'A' }), s.ctx),
    );
    await queue().settled();

    const dismissed = await withContext(s.ctx, () => dismissCapture(capture.id, s.ctx));
    expect(dismissed.status).toBe('dismissed');

    const error = await wireErrorOf(withContext(s.ctx, () => dismissCapture(capture.id, s.ctx)));
    expect(error).toMatchObject({
      code: 'precondition_failed',
      details: { precondition: 'capture_dismissed' },
    });
  });

  it('refuses to dismiss a capture that is still extracting', async () => {
    // No `queue().settled()` — the row is caught mid-`extracting`.
    const capture = await withContext(s.ctx, () =>
      createCaptureFromUpload(uploadRequestFor({ vendor: 'A' }), s.ctx),
    );

    const error = await wireErrorOf(withContext(s.ctx, () => dismissCapture(capture.id, s.ctx)));
    expect(error).toMatchObject({
      code: 'precondition_failed',
      details: { precondition: 'capture_extracting' },
    });

    await queue().settled();
  });
});

describe('createDraftFromCapture', () => {
  it('creates a draft bill, attaches the original, and marks the capture drafted', async () => {
    const capture = await withContext(s.ctx, () =>
      createCaptureFromUpload(
        uploadRequestFor({
          vendor: 'Acme',
          lines: [{ description: 'Paper', quantity: '1', unitAmountMinor: '150000' }],
        }),
        s.ctx,
      ),
    );
    await queue().settled();

    const bill = await withContext(s.ctx, () =>
      createDraftFromCapture(
        capture.id,
        {
          contactId: s.vendorUuid,
          issueDate: '2026-07-20',
          taxMode: 'exclusive',
          lines: [
            {
              description: 'Paper',
              quantity: '1',
              unitAmount: '150000',
              accountId: s.expenseUuid,
            },
          ],
        },
        s.ctx,
      ),
    );

    expect(bill.status).toBe('draft');
    expect(bill.journalId).toBeNull();

    const settledCapture = await withContext(s.ctx, () => getCapture(capture.id, s.ctx));
    expect(settledCapture.status).toBe('drafted');
    expect(settledCapture.draftedBillId).toBe(bill.id);

    const attachment = await db.app
      .selectFrom('bill_attachments')
      .select(['id', 'ap_document_id', 'storage_key', 'filename'])
      .where('ap_document_id', '=', uuidToBuffer(bill.id))
      .executeTakeFirstOrThrow();
    expect(attachment.filename).toBe('invoice.txt');

    const streamed = await withContext(s.ctx, () =>
      getBillAttachment(bill.id, bufferToUuid(attachment.id), s.ctx),
    );
    expect(streamed.contentType).toBe('application/pdf');
    expect(streamed.bytes.length).toBeGreaterThan(0);

    // Reachable once only (D-38's shape, one layer back).
    const error = await wireErrorOf(
      withContext(s.ctx, () =>
        createDraftFromCapture(
          capture.id,
          { contactId: s.vendorUuid, issueDate: '2026-07-20', taxMode: 'exclusive' },
          s.ctx,
        ),
      ),
    );
    expect(error).toMatchObject({
      code: 'precondition_failed',
      details: { precondition: 'capture_already_drafted' },
    });
  });
});

describe('permission gates (bills.write / bills.read, no new catalog keys)', () => {
  it('a read-only member cannot upload or dismiss, but can list and read', async () => {
    const reader = await memberOf(db, s, 'readOnly');
    const capture = await withContext(s.ctx, () =>
      createCaptureFromUpload(uploadRequestFor({ vendor: 'A' }), s.ctx),
    );
    await queue().settled();

    const uploadError = await wireErrorOf(
      withContext(reader, () => createCaptureFromUpload(uploadRequestFor({ vendor: 'B' }), reader)),
    );
    expect(uploadError).toMatchObject({ code: 'permission_denied' });

    const dismissError = await wireErrorOf(
      withContext(reader, () => dismissCapture(capture.id, reader)),
    );
    expect(dismissError).toMatchObject({ code: 'permission_denied' });

    const read = await withContext(reader, () => getCapture(capture.id, reader));
    expect(read.id).toBe(capture.id);

    const listed = await withContext(reader, () => listCaptures({}, reader));
    expect(listed.items.some((item) => item.id === capture.id)).toBe(true);
  });
});
