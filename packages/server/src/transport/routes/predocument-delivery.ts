import { predocumentDeliverySchema, sendPredocumentRequestSchema } from '@openbooks/shared-types';
import type { PredocumentDelivery } from '@openbooks/shared-types';
import { z } from 'zod';

import { getContext } from '../../context';
import { withIdempotency } from '../../modules/idempotency';
import { sendEstimate, sendPurchaseOrder } from '../../modules/predocument-delivery';
import type { App } from '../types';
import {
  ERROR_RESPONSES,
  ORG_SCOPED_WRITE_HOOKS,
  idempotencyKeyHeaderSchema,
  idempotentBody,
} from './support';

/**
 * `POST /v1/purchase-orders/{purchaseOrderId}/send` and
 * `POST /v1/estimates/{estimateId}/send` (initiative M, OB-177; ROADMAP D-M5).
 *
 * The send routes are folded into their own file rather than into
 * `purchase-orders.ts`/`estimates.ts` because they are a separate module
 * (`modules/predocument-delivery`), authored in parallel with the two document
 * modules (ROADMAP M's Wave 1). The response is the delivery record — never the
 * document — for `sendInvoice`'s reason (`transport/routes/invoices.ts`): sending
 * changes nothing about the purchase order or estimate itself, only produces a
 * row describing the attempt.
 *
 * **D-M5, lean v1:** unlike `sendInvoice`, this send mints no capability token and
 * renders no PDF — see `modules/predocument-delivery/send.service.ts`'s header for
 * why the hosted page and themed PDF are deferred follow-ups rather than missing
 * pieces of this route.
 */

const PURCHASE_ORDER_TAG = 'purchase-orders';
const ESTIMATE_TAG = 'estimates';

const purchaseOrderParamsSchema = z.strictObject({ purchaseOrderId: z.uuid() });
const estimateParamsSchema = z.strictObject({ estimateId: z.uuid() });

export function registerPredocumentDeliveryRoutes(app: App): void {
  app.post(
    '/v1/purchase-orders/:purchaseOrderId/send',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'sendPurchaseOrder',
        summary: 'Email an approved purchase order to its vendor',
        description:
          'Emails an HTML summary to `recipientEmail` or, if absent, the purchase order’s own ' +
          'vendor contact email, and records the attempt as an append-only ' +
          '`predocument_deliveries` row. A draft cannot be sent — there is nothing approved to ' +
          'summarise (`purchase_order_not_approved`) — and a document with no recipient email ' +
          'on either side answers `no_recipient`. Takes `purchase_orders.write`.',
        tags: [PURCHASE_ORDER_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: purchaseOrderParamsSchema,
        body: sendPredocumentRequestSchema,
        response: { 200: predocumentDeliverySchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { purchaseOrderId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'sendPurchaseOrder',
          request: { purchaseOrderId, send: request.body },
          successStatus: 200,
        },
        () => sendPurchaseOrder(purchaseOrderId, request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<PredocumentDelivery>(result));
    },
  );

  app.post(
    '/v1/estimates/:estimateId/send',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'sendEstimate',
        summary: 'Email an approved estimate to its customer',
        description:
          'The AR mirror of `sendPurchaseOrder`: emails `recipientEmail` or, if absent, the ' +
          'estimate’s own customer contact email, and records the attempt as an append-only ' +
          '`predocument_deliveries` row. `estimate_not_approved` and `no_recipient` are the same ' +
          'two refusals. Takes `estimates.write`.',
        tags: [ESTIMATE_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: estimateParamsSchema,
        body: sendPredocumentRequestSchema,
        response: { 200: predocumentDeliverySchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { estimateId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'sendEstimate',
          request: { estimateId, send: request.body },
          successStatus: 200,
        },
        () => sendEstimate(estimateId, request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<PredocumentDelivery>(result));
    },
  );
}
