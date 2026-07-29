import {
  DOCUMENT_CAPTURE_MAX_BYTES,
  billSchema,
  captureStatusSchema,
  createDraftFromCaptureRequestSchema,
  documentCapturePageSchema,
  documentCaptureSchema,
  pageCursorSchema,
  uploadCaptureRequestSchema,
} from '@openbooks/shared-types';
import type { Bill, DocumentCapture, DocumentCapturePage } from '@openbooks/shared-types';
import { z } from 'zod';

import { getContext } from '../../context';
import {
  createCaptureFromUpload,
  createDraftFromCapture,
  dismissCapture,
  getBillAttachment,
  getCapture,
  listCaptures,
} from '../../modules/bills';
import { withIdempotency } from '../../modules/idempotency';
import { getInboundEmailAddress } from '../../modules/orgs';
import { errorResponseSchema } from '../schemas';
import type { App } from '../types';
import {
  ERROR_RESPONSES,
  ORG_SCOPED_WRITE_HOOKS,
  idempotencyKeyHeaderSchema,
  idempotentBody,
  pageLimitQuery,
  requireOrgScope,
} from './support';

/**
 * `/v1/bills/captures` — OCR bill capture's review surface (initiative O,
 * OB-186/187/188/190; the pinned OCR contract), plus the two routes that ride
 * alongside it: streaming a bill's retained attachment and revealing the org's
 * inbound-capture mailbox.
 *
 * ## Every operation reuses `bills.write`/`bills.read` — no new permission keys
 *
 * The pinned contract's locked decisions are explicit: capturing a bill is
 * writing a bill (AP-flow map, D-25), so nothing here touches the fixed
 * 51-entry `PERMISSION_KEYS` catalog. Enforcement is service-layer only
 * (`capture.service.ts`); this file maps arguments and nothing else.
 *
 * ## A capture is staging; the draft is the bill (D-34, D-38 one layer back)
 *
 * `POST .../draft` is the one route here that creates a financial document, and
 * even that only a **draft** (`journal_id IS NULL`) — approving it afterwards is
 * the ordinary `POST /v1/bills/{billId}/approve` (`bills.ts`), unchanged, and
 * `assertNoDuplicateReference` fires there exactly as it does for a hand-entered
 * bill. Nothing under `/v1/bills/captures` posts a journal.
 *
 * ## The upload is base64-in-JSON, `uploadBrandingLogoRequestSchema`'s shape
 *
 * `uploadCaptureRequestSchema` lives in `shared-types`, not locally, because a
 * capture is document-contract surface an MCP tool can reach too (unlike the
 * logo, which is transport-only). `bodyLimit` is still raised per-route, for the
 * same reason: base64 costs a third more than the bytes it encodes, and a
 * captured document is the largest body this surface accepts (10 MiB of actual
 * document — `DOCUMENT_CAPTURE_MAX_BYTES`).
 *
 * ## The attachment stream declares no `200` response schema
 *
 * `GET /v1/bills/{billId}/attachments/{attachmentId}` sends raw bytes, not
 * JSON — `public-invoices.ts`'s `/pdf` route argues why at length and this route
 * follows it exactly: only `default: errorResponseSchema` is declared, and
 * Fastify's own reply handling sends the `Buffer` payload as-is.
 */

const CAPTURE_TAG = 'bill-captures';

const captureParamsSchema = z.strictObject({ captureId: z.uuid() });
const attachmentParamsSchema = z.strictObject({ billId: z.uuid(), attachmentId: z.uuid() });

/** Base64 costs 4 characters for every 3 bytes it encodes (`branding.ts`'s convention). */
const DOCUMENT_CAPTURE_CONTENT_MAX_LENGTH = Math.ceil(DOCUMENT_CAPTURE_MAX_BYTES / 3) * 4;

const listCapturesWireQuerySchema = z.strictObject({
  status: captureStatusSchema.optional(),
  limit: pageLimitQuery('captures'),
  cursor: pageCursorSchema.optional(),
});

/** Not in `shared-types`: transport-only, `uploadBrandingLogoRequestSchema`'s reasoning applies. */
const inboundEmailAddressSchema = z
  .object({
    address: z.string().meta({
      description:
        'The mailbox address that, once real inbound receiving is wired to it, becomes captures ' +
        '(D-25’s "real MX/receipt-rule receiving is out of scope this wave" — this address is ' +
        'stable now so the UI can show it before that lands).',
    }),
  })
  .meta({ id: 'InboundEmailAddress' });

export function registerBillCaptureRoutes(app: App): void {
  app.post(
    '/v1/bills/captures',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      bodyLimit: DOCUMENT_CAPTURE_CONTENT_MAX_LENGTH + 4096,
      schema: {
        operationId: 'createBillCapture',
        summary: 'Upload a document to be extracted',
        description:
          'Stores the original, writes a `document_captures` row at status `extracting`, and ' +
          'enqueues extraction (event-driven, not the daily tick). The bytes are never returned; ' +
          'only the row.',
        tags: [CAPTURE_TAG],
        headers: idempotencyKeyHeaderSchema,
        body: uploadCaptureRequestSchema,
        response: { 201: documentCaptureSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const result = await withIdempotency(
        { endpoint: 'createBillCapture', request: request.body, successStatus: 201 },
        () => createCaptureFromUpload(request.body, ctx),
      );

      const capture = idempotentBody<DocumentCapture>(result);
      return reply
        .status(result.status)
        .header('location', `/v1/bills/captures/${capture.id}`)
        .send(capture);
    },
  );

  app.get(
    '/v1/bills/captures',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listBillCaptures',
        summary: 'List captures',
        description:
          'One page of captures, oldest first by creation (D-21). Filter by `status` to see the ' +
          'review queue (`extracted`/`failed`) or the settled ones (`drafted`/`dismissed`).',
        tags: [CAPTURE_TAG],
        querystring: listCapturesWireQuerySchema,
        response: { 200: documentCapturePageSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<DocumentCapturePage> => {
      const { status, limit, cursor } = request.query;
      return listCaptures(
        {
          limit,
          ...(cursor === undefined ? {} : { cursor }),
          ...(status === undefined ? {} : { status }),
        },
        getContext(),
      );
    },
  );

  app.get(
    '/v1/bills/captures/:captureId',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getBillCapture',
        summary: 'One capture, with its extracted lines',
        tags: [CAPTURE_TAG],
        params: captureParamsSchema,
        response: { 200: documentCaptureSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<DocumentCapture> => getCapture(request.params.captureId, getContext()),
  );

  app.post(
    '/v1/bills/captures/:captureId/dismiss',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'dismissBillCapture',
        summary: 'Dismiss a capture that is not a bill',
        description:
          'Only from `extracted` or `failed` — a capture still `extracting` has nothing to review ' +
          'yet, and one already `drafted`/`dismissed` has been reviewed once already.',
        tags: [CAPTURE_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: captureParamsSchema,
        response: { 200: documentCaptureSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { captureId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'dismissBillCapture', request: { captureId }, successStatus: 200 },
        () => dismissCapture(captureId, ctx),
      );

      return reply.status(result.status).send(idempotentBody<DocumentCapture>(result));
    },
  );

  app.post(
    '/v1/bills/captures/:captureId/draft',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'createDraftFromBillCapture',
        summary: 'Confirm a reviewed capture into a draft bill',
        description:
          'The review-edited payload — the same shape as `CreateBillRequest`, because it becomes ' +
          'one via the existing `createBill`. Attaches the captured original to the new bill and ' +
          'moves the capture to `drafted`. The result is a **draft** (`journal_id` null); approve ' +
          'it with `POST /v1/bills/{billId}/approve` as any other bill.',
        tags: [CAPTURE_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: captureParamsSchema,
        body: createDraftFromCaptureRequestSchema,
        response: { 201: billSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { captureId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'createDraftFromBillCapture',
          request: { captureId, draft: request.body },
          successStatus: 201,
        },
        () => createDraftFromCapture(captureId, request.body, ctx),
      );

      const bill = idempotentBody<Bill>(result);
      return reply.status(result.status).header('location', `/v1/bills/${bill.id}`).send(bill);
    },
  );

  app.get(
    '/v1/bills/:billId/attachments/:attachmentId',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getBillAttachment',
        summary: 'The retained original behind a bill, streamed',
        description:
          'Streams the stored bytes of one attachment on a bill — ordinarily the document a ' +
          'capture became, but a bill may carry more than the one its capture produced.',
        tags: [CAPTURE_TAG],
        params: attachmentParamsSchema,
        // See the file header for why `200` is deliberately undeclared.
        response: { default: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const { billId, attachmentId } = request.params;
      const attachment = await getBillAttachment(billId, attachmentId, getContext());

      // The zod type provider constrains `send` to the declared response shapes, and
      // the only one here is the error `default`; the success body is raw bytes, so
      // it is cast past that constraint exactly as `getPublicInvoicePdf` does.
      const disposition = `inline; filename="${encodeURIComponent(attachment.filename)}"`;
      return reply
        .header('content-type', attachment.contentType)
        .header('content-disposition', disposition)
        .send(Buffer.from(attachment.bytes) as never);
    },
  );

  app.get(
    '/v1/bills/inbound-address',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getInboundBillEmailAddress',
        summary: 'The org’s inbound bill-capture mailbox',
        description:
          'Mints one on first read if the org has none yet. Real inbound receiving (MX / SES ' +
          'receipt rules) is out of scope this wave — the address is stable now so the UI can show ' +
          'it — and the webhook a mail relay posts to is `POST /v1/bills/inbound/{token}`.',
        tags: [CAPTURE_TAG],
        response: { 200: inboundEmailAddressSchema, ...ERROR_RESPONSES },
      },
    },
    async () => getInboundEmailAddress(getContext()),
  );
}
