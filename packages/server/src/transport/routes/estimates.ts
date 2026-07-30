import {
  createEstimateRequestSchema,
  ESTIMATE_STATUSES,
  estimatePageSchema,
  estimateSchema,
  invoiceSchema,
  pageCursorSchema,
  updateEstimateRequestSchema,
} from '@openbooks/shared-types';
import type { Estimate, EstimatePage, Invoice } from '@openbooks/shared-types';
import { z } from 'zod';

import { getContext } from '../../context';
import {
  approveEstimate,
  convertEstimateToInvoice,
  createEstimate,
  discardEstimate,
  getEstimate,
  listEstimates,
  updateEstimate,
} from '../../modules/estimates';
import { withIdempotency } from '../../modules/idempotency';
import type { App } from '../types';
import {
  ERROR_RESPONSES,
  ORG_SCOPED_WRITE_HOOKS,
  idempotencyKeyHeaderSchema,
  idempotentBody,
  noContentSchema,
  pageLimitQuery,
  requireOrgScope,
} from './support';

/**
 * `/v1/estimates` — the AR mirror of `/v1/purchase-orders` (initiative M,
 * OB-175…176; ROADMAP D-M3, D-M4, D-M6, D-M7).
 *
 * There is no `/send` route here: sending an approved estimate to its customer
 * is a separate ticket's surface (`modules/predocument-delivery`), not this
 * file's. `/approve` and `/convert` follow `invoices.ts`'s own argument for why
 * a state change with its own rules is a `POST` on its own path rather than a
 * `PATCH` of `status` — doubly so here, since `status` is a stored column an
 * estimate's own schema already marks as something a client never writes.
 *
 * Approve and convert both take no body, for `approveInvoice`'s reason
 * restated: the first field anyone would add to an empty body is the one that
 * lets a client override a fact the session and the estimate's own lines
 * already determine (who approved it, what it carries at convert).
 *
 * `discardEstimate` is `DELETE` and only ever removes a draft — an approved or
 * converted estimate answers `precondition_failed` with `estimate_approved`,
 * `updateEstimate`'s and `discardEstimate`'s shared refusal.
 */

const ESTIMATE_TAG = 'estimates';

const estimateParamsSchema = z.strictObject({ estimateId: z.uuid() });

/**
 * Local and carrying no `id`, `listInvoicesWireQuerySchema`'s reason: a
 * querystring is emitted as individual `parameters`, so a component for one
 * would be referenced by nothing.
 */
const listEstimatesWireQuerySchema = z.strictObject({
  contactId: z.uuid().optional(),
  status: z.enum(ESTIMATE_STATUSES).optional(),
  limit: pageLimitQuery('estimates'),
  cursor: pageCursorSchema.optional(),
});

export function registerEstimateRoutes(app: App): void {
  app.post(
    '/v1/estimates',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'createEstimate',
        summary: 'Create a draft estimate',
        description:
          'Creates a draft. Nothing is posted — an estimate never touches a journal (D-M3) — and ' +
          'no number is allocated: a number reserved by a draft that was then discarded would ' +
          'leave a gap in the estimate series (D-36).',
        tags: [ESTIMATE_TAG],
        headers: idempotencyKeyHeaderSchema,
        body: createEstimateRequestSchema,
        response: { 201: estimateSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const result = await withIdempotency(
        { endpoint: 'createEstimate', request: request.body, successStatus: 201 },
        () => createEstimate(request.body, ctx),
      );

      const estimate = idempotentBody<Estimate>(result);
      return reply
        .status(result.status)
        .header('location', `/v1/estimates/${estimate.id}`)
        .send(estimate);
    },
  );

  app.get(
    '/v1/estimates',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listEstimates',
        summary: 'List estimates',
        description:
          'One page of headers with totals, and no lines. Ordered by `(created_at, id)` and not ' +
          'by document number: a draft has none until approval, and `issueDate` is editable while ' +
          'it is a draft — a keyset over a mutable column silently drops the rows that moved ' +
          'behind the cursor.',
        tags: [ESTIMATE_TAG],
        querystring: listEstimatesWireQuerySchema,
        response: { 200: estimatePageSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<EstimatePage> => {
      const { contactId, status, limit, cursor } = request.query;
      return listEstimates(
        {
          limit,
          ...(cursor === undefined ? {} : { cursor }),
          ...(contactId === undefined ? {} : { contactId }),
          ...(status === undefined ? {} : { status }),
        },
        getContext(),
      );
    },
  );

  app.get(
    '/v1/estimates/:estimateId',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getEstimate',
        summary: 'One estimate, with its lines',
        tags: [ESTIMATE_TAG],
        params: estimateParamsSchema,
        response: { 200: estimateSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<Estimate> => getEstimate(request.params.estimateId, getContext()),
  );

  app.patch(
    '/v1/estimates/:estimateId',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'updateEstimate',
        summary: 'Update a draft estimate',
        description:
          'Drafts only. An approved or converted estimate answers `precondition_failed` with ' +
          '`estimate_approved`. `lines` replaces the whole set, and changing `taxMode` reprices ' +
          'them rather than converting them.',
        tags: [ESTIMATE_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: estimateParamsSchema,
        body: updateEstimateRequestSchema,
        response: { 200: estimateSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { estimateId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'updateEstimate',
          request: { estimateId, patch: request.body },
          successStatus: 200,
        },
        () => updateEstimate(estimateId, request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<Estimate>(result));
    },
  );

  app.delete(
    '/v1/estimates/:estimateId',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'discardEstimate',
        summary: 'Discard a draft estimate',
        description:
          'Deletes a draft and its lines. An approved or converted estimate is refused with ' +
          '`estimate_approved`.',
        tags: [ESTIMATE_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: estimateParamsSchema,
        response: { 204: noContentSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { estimateId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'discardEstimate', request: { estimateId }, successStatus: 204 },
        () => discardEstimate(estimateId, ctx),
      );

      return reply.status(result.status).send(idempotentBody<null>(result));
    },
  );

  app.post(
    '/v1/estimates/:estimateId/approve',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'approveEstimate',
        summary: 'Approve an estimate and allocate its number',
        description:
          'Allocates the estimate’s gapless number and stamps `approvedAt`. No journal — an ' +
          'estimate never posts one (D-M3) — so this is strictly narrower than approving an ' +
          'invoice. No body: the actor is the session and the lines are the estimate’s own. An ' +
          'estimate with no lines is refused with `validation_failed`, and one already approved ' +
          'with `precondition_failed` naming `estimate_already_approved`.',
        tags: [ESTIMATE_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: estimateParamsSchema,
        response: { 200: estimateSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { estimateId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'approveEstimate', request: { estimateId }, successStatus: 200 },
        () => approveEstimate(estimateId, ctx),
      );

      return reply.status(result.status).send(idempotentBody<Estimate>(result));
    },
  );

  app.post(
    '/v1/estimates/:estimateId/convert',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'convertEstimateToInvoice',
        summary: 'Convert an approved estimate into a draft invoice',
        description:
          'Builds a draft invoice from the estimate’s header and lines and returns it — never the ' +
          'estimate (D-M4). The invoice is a draft: nothing is posted here, and it is approved ' +
          'through the ordinary invoice flow. Requires the estimate to be approved ' +
          '(`precondition_failed`/`estimate_not_approved` otherwise) and unconverted ' +
          '(`precondition_failed`/`estimate_already_converted` on a second attempt — conversion ' +
          'happens at most once).',
        tags: [ESTIMATE_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: estimateParamsSchema,
        response: { 200: invoiceSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { estimateId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'convertEstimateToInvoice', request: { estimateId }, successStatus: 200 },
        () => convertEstimateToInvoice(estimateId, ctx),
      );

      return reply.status(result.status).send(idempotentBody<Invoice>(result));
    },
  );
}
