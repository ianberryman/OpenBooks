import { z } from 'zod';

import { calendarDateSchema, minorUnitsSchema, pageSchema } from '../wire';

import {
  DOCUMENT_MAX_LINES,
  documentLineInputSchema,
  documentMemoSchema,
  documentReferenceSchema,
  quantitySchema,
  taxModeSchema,
} from './documents';

/**
 * OCR bill capture (initiative O, OB-185…191): the wire contracts for the staging
 * area between an uploaded or emailed document and a bill a human has reviewed.
 *
 * ## A capture is a proposal, never a posting
 *
 * Nothing here creates a bill. `documentCaptureSchema` is the read shape of a
 * `document_captures` row (F1's schema stream), and it carries no `journalId` and
 * no status any bill schema would recognise — `bills.ts`'s D-34/D-38 argument
 * applies one level further back here: a capture is not a financial document at
 * all, only a document *about* to become one. `createDraftFromCaptureRequestSchema`
 * is deliberately the same shape as `createBillRequestSchema` — the review step
 * edits the extraction into a real bill and hands it to the existing `createBill`,
 * so the two schemas have to agree field for field or every review submission
 * would need translating.
 *
 * ## `unitAmount`/`quantity`/`extractedTotalMinor` reuse the document vocabulary
 *
 * `extractedCaptureLineSchema` and `extractedTotalMinor` are built from the same
 * `minorUnitsSchema`/`quantitySchema` every other document line uses (`documents.ts`),
 * because an extracted amount is money the moment it is read off a page, not only
 * once a bill exists to hold it — D-13's rule about *where* a decimal would first
 * be invented applies to a proposal exactly as it does to a posting.
 */

export const CAPTURE_STATUSES = [
  'extracting',
  'extracted',
  'failed',
  'drafted',
  'dismissed',
] as const;
export type CaptureStatus = (typeof CAPTURE_STATUSES)[number];

/**
 * The capture lifecycle. No `.meta({ id })`, following `documentStatusSchema`'s
 * neighbours in `documents.ts`: an inline `enum` costs no component and reads the
 * same in a generated client.
 */
export const captureStatusSchema = z.enum(CAPTURE_STATUSES).meta({
  description:
    'Where a capture sits in its lifecycle. `extracting` on creation, then `extracted` or ' +
    '`failed` once the extraction job finishes, then `drafted` or `dismissed` once a human has ' +
    'reviewed it. There is no state past `drafted` here — once a draft bill exists, its own ' +
    'status carries the truth (D-38).',
});

export const CAPTURE_SOURCES = ['upload', 'email'] as const;
export type CaptureSource = (typeof CAPTURE_SOURCES)[number];

export const captureSourceSchema = z.enum(CAPTURE_SOURCES).meta({
  description: 'How the document arrived: a direct upload, or an attachment on an inbound email.',
});

/**
 * The image/document formats an upload capture accepts. Raster and PDF only —
 * `image/svg+xml` is excluded for `UPLOAD_LOGO_CONTENT_TYPES`'s reason
 * (`transport/routes/branding.ts`): an SVG can carry a `<script>`, and a captured
 * bill is data nobody has reviewed yet.
 */
const UPLOAD_CAPTURE_CONTENT_TYPES = ['application/pdf', 'image/png', 'image/jpeg'] as const;

/**
 * 10 MiB of actual document — generous for a scanned, multi-page bill PDF, which
 * is the largest real-world case this route expects. The route's own `bodyLimit`
 * has to be raised above this, base64-inflated, exactly as the branding logo
 * route's is (`LOGO_CONTENT_MAX_LENGTH`'s comment) — that adjustment lives beside
 * the route, not here.
 */
export const DOCUMENT_CAPTURE_MAX_BYTES = 10 * 1024 * 1024;

/** Base64 costs 4 characters for every 3 bytes it encodes. */
const DOCUMENT_CAPTURE_CONTENT_MAX_LENGTH = Math.ceil(DOCUMENT_CAPTURE_MAX_BYTES / 3) * 4;

/**
 * `POST /v1/bills/captures` — a direct upload. JSON with the file as a base64
 * body field, not multipart, for `uploadBrandingLogoRequestSchema`'s reason: it
 * keeps one request-parsing path on this surface, and (unlike the logo) this
 * shape belongs in `shared-types` because a capture is document-contract surface
 * an MCP tool can reach too, not a transport-only concern.
 */
export const uploadCaptureRequestSchema = z
  .strictObject({
    filename: z.string().trim().min(1).max(255).meta({
      description: 'What the file was called at upload. Recorded and shown back at review.',
    }),
    contentType: z.enum(UPLOAD_CAPTURE_CONTENT_TYPES).meta({
      description: 'The document format. Anything else is refused before the bytes are read.',
    }),
    content: z
      .base64()
      .max(DOCUMENT_CAPTURE_CONTENT_MAX_LENGTH)
      .meta({
        description: `The document, base64-encoded. Decodes to at most ${String(DOCUMENT_CAPTURE_MAX_BYTES)} bytes (10 MiB).`,
      }),
  })
  .meta({
    id: 'UploadCaptureRequest',
    description:
      'Uploads a document to be extracted. Creates a `document_captures` row in status ' +
      '`extracting` and enqueues the extraction job; the bytes are stored, never returned.',
  });

export type UploadCaptureRequest = z.infer<typeof uploadCaptureRequestSchema>;

/**
 * One line item as extraction read it off the document. Not `documentLineSchema`
 * (`documents.ts`) — that is a *posted* line with an account, a tax rate, and a
 * rounded tax amount, none of which extraction can know; this is only what the
 * page said, for a human to turn into one of those at review.
 */
export const extractedCaptureLineSchema = z
  .strictObject({
    description: z.string().nullable(),
    quantity: quantitySchema,
    unitAmount: minorUnitsSchema,
  })
  .meta({
    id: 'ExtractedCaptureLine',
    description: 'One line item as extraction read it off the document, before any review.',
  });

export type ExtractedCaptureLine = z.infer<typeof extractedCaptureLineSchema>;

/**
 * A capture, as the API returns it. `extraction_json`'s line items are surfaced
 * flat as `lines`, hydrating the whole proposal the review screen edits — there is
 * no separate "get capture lines" call, matching the read shape of every document
 * here (`billSchema` inlines its lines the same way).
 *
 * Every extracted field is nullable-and-required rather than optional, matching
 * `orgBrandingSchema`'s reasoning: a persisted row holds either a value or NULL,
 * and under `exactOptionalPropertyTypes` an absent key is a different type from a
 * null one. `matchedContactId`/`draftedBillId` are null until, respectively, the
 * vendor-matching step and the review step set them — see the capture service
 * contract (`modules/bills/capture`) for when each happens.
 */
export const documentCaptureSchema = z
  .strictObject({
    id: z.uuid(),
    source: captureSourceSchema,
    status: captureStatusSchema,
    filename: z.string(),
    contentType: z.string(),
    byteSize: z.int().nonnegative(),
    extractedVendorName: z.string().nullable(),
    matchedContactId: z
      .uuid()
      .nullable()
      .meta({
        description:
          'Set when exactly one active vendor contact matches the extracted name (no name lookup ' +
          'exists yet — see the capture service contract); null otherwise, for a human to resolve.',
      }),
    extractedIssueDate: calendarDateSchema.nullable(),
    extractedReference: z.string().nullable().meta({
      description: 'The vendor’s own invoice number, where extraction found one (D-36’s field).',
    }),
    extractedTotalMinor: minorUnitsSchema.nullable(),
    lines: z.array(extractedCaptureLineSchema),
    extractionError: z.string().nullable().meta({
      description: 'Why extraction failed, set only when `status` is `failed`.',
    }),
    draftedBillId: z.uuid().nullable().meta({
      description: 'The draft bill this capture became, set once review has acted (D-34).',
    }),
    createdAt: z.iso.datetime(),
  })
  .meta({
    id: 'DocumentCapture',
    description:
      'An uploaded or emailed document and what extraction made of it. A proposal, never a ' +
      'posting: nothing here creates a bill on its own — see `POST .../draft`.',
  });

export type DocumentCapture = z.infer<typeof documentCaptureSchema>;

export const documentCapturePageSchema = pageSchema(documentCaptureSchema, {
  id: 'DocumentCapturePage',
  description: 'One page of captures, oldest first by creation.',
});

export type DocumentCapturePage = z.infer<typeof documentCapturePageSchema>;

/**
 * The review-confirmed payload that turns a capture into a bill.
 *
 * Deliberately the same shape as `createBillRequestSchema` (`bills.ts`) — reusing
 * its field schemas field for field, not merely resembling them — because review
 * hands this straight to the existing `createBill` (see the capture service
 * contract): a **draft** bill, `journal_id IS NULL`, exactly as any other bill
 * starts. `lines` is optional for the same reason it is there: a reviewer can
 * confirm the header and add lines afterwards through the ordinary bill-edit path.
 */
export const createDraftFromCaptureRequestSchema = z
  .strictObject({
    contactId: z.uuid(),
    issueDate: calendarDateSchema,
    dueDate: calendarDateSchema.optional(),
    taxMode: taxModeSchema,
    reference: documentReferenceSchema.nullish(),
    memo: documentMemoSchema.nullish(),
    lines: z.array(documentLineInputSchema).max(DOCUMENT_MAX_LINES).optional(),
  })
  .meta({
    id: 'CreateDraftFromCaptureRequest',
    description:
      'Confirms a reviewed capture into a draft bill. The same shape as `CreateBillRequest`, ' +
      'because that is exactly what this becomes — the vendor extraction could not resolve on ' +
      'its own (D-25) is what `contactId` supplies here.',
  });

export type CreateDraftFromCaptureRequest = z.infer<typeof createDraftFromCaptureRequestSchema>;
