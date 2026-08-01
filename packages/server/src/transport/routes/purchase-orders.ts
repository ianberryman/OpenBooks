import {
  billSchema,
  calendarDateSchema,
  createPurchaseOrderRequestSchema,
  pageCursorSchema,
  PURCHASE_ORDER_STATUSES,
  purchaseOrderPageSchema,
  purchaseOrderSchema,
  purchaseOrdersSummarySchema,
  updatePurchaseOrderRequestSchema,
} from '@openbooks/shared-types';
import type {
  Bill,
  PurchaseOrder,
  PurchaseOrderPage,
  PurchaseOrdersSummary,
} from '@openbooks/shared-types';
import { z } from 'zod';

import { getContext } from '../../context';
import {
  approvePurchaseOrder,
  convertPurchaseOrderToBill,
  createPurchaseOrder,
  discardPurchaseOrder,
  getPurchaseOrder,
  listPurchaseOrders,
  purchaseOrdersSummary,
  updatePurchaseOrder,
} from '../../modules/purchase-orders';
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
 * `/v1/purchase-orders` — the AP-side pre-document (initiative M, OB-170…173,
 * transport for `modules/purchase-orders`; ROADMAP D-M3, D-M4, D-M6, D-M7).
 *
 * Handlers map arguments and hold no logic (spec §2.4): every refusal — a
 * contact that is not a vendor, an edit or a discard after approval, a convert
 * before approval or a second convert of the same purchase order — is the
 * service's, not this file's.
 *
 * ## `approve` posts no journal; `convert` is the one write that reaches AP
 *
 * Unlike `POST /v1/bills/{billId}/approve`, approving a purchase order only
 * allocates its gapless number (D-M3) — there is nothing here shaped like
 * `approveBill`'s journal-posting description. `POST …/convert` is where a
 * purchase order first becomes a financial document: it produces a **draft**
 * bill, returned as `billSchema`, which the AP screens then approve through
 * their own ordinary flow. There is no `POST …/send` on this file — sending a
 * purchase order to its vendor is `modules/predocument-delivery`'s route
 * (D-M5), registered separately.
 */

const TAG = 'purchase-orders';

const purchaseOrderParamsSchema = z.strictObject({ purchaseOrderId: z.uuid() });

/** Local and carrying no `id`, `listBillsWireQuerySchema`'s own reason. */
const listPurchaseOrdersWireQuerySchema = z.strictObject({
  contactId: z.uuid().optional(),
  status: z.enum(PURCHASE_ORDER_STATUSES).optional(),
  limit: pageLimitQuery('purchase orders'),
  cursor: pageCursorSchema.optional(),
});

/** Local, `estimatesSummaryWireQuerySchema`'s reason restated: no `id` to reference. */
const purchaseOrdersSummaryWireQuerySchema = z.strictObject({
  asOf: calendarDateSchema.optional(),
});

export function registerPurchaseOrderRoutes(app: App): void {
  app.post(
    '/v1/purchase-orders',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'createPurchaseOrder',
        summary: 'Create a draft purchase order',
        description:
          'Creates a draft. `contactId` must be a vendor — `contact_is_not_a_vendor` otherwise. ' +
          '`lines` is optional: "New purchase order" produces an empty one, and the arity and ' +
          'value checks belong at approval.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        body: createPurchaseOrderRequestSchema,
        response: { 201: purchaseOrderSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const result = await withIdempotency(
        { endpoint: 'createPurchaseOrder', request: request.body, successStatus: 201 },
        () => createPurchaseOrder(request.body, ctx),
      );

      const purchaseOrder = idempotentBody<PurchaseOrder>(result);
      return reply
        .status(result.status)
        .header('location', `/v1/purchase-orders/${purchaseOrder.id}`)
        .send(purchaseOrder);
    },
  );

  app.get(
    '/v1/purchase-orders',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listPurchaseOrders',
        summary: 'List purchase orders',
        description:
          'One page of headers with totals, no lines. Ordered by `(created_at, id)` (D-21). ' +
          '`status` is stored, not computed (D-M6): `draft`, `approved`, or `converted`.',
        tags: [TAG],
        querystring: listPurchaseOrdersWireQuerySchema,
        response: { 200: purchaseOrderPageSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<PurchaseOrderPage> => {
      const { contactId, status, limit, cursor } = request.query;
      return listPurchaseOrders(
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
    '/v1/purchase-orders/summary',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'purchaseOrdersSummary',
        summary: 'The purchase-orders-list headline figures',
        description:
          'What is still in draft, what is approved and awaiting conversion to a bill, and what ' +
          'has converted in the last 30 days, as at a date. A live snapshot rather than a report: ' +
          '`asOf` defaults to today. A purchase order posts no journal (D-M3), so these are ' +
          'stored-column predicates over `purchase_orders`, not a read against the payable aging.',
        tags: [TAG],
        querystring: purchaseOrdersSummaryWireQuerySchema,
        response: { 200: purchaseOrdersSummarySchema, ...ERROR_RESPONSES },
      },
    },
    // A static segment, so `find-my-way` matches it ahead of `/v1/purchase-orders/:purchaseOrderId`
    // whatever the registration order; it is placed here so a reader sees why.
    async (request): Promise<PurchaseOrdersSummary> => {
      const { asOf } = request.query;
      return purchaseOrdersSummary(asOf === undefined ? {} : { asOf }, getContext());
    },
  );

  app.get(
    '/v1/purchase-orders/:purchaseOrderId',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getPurchaseOrder',
        summary: 'One purchase order, with its lines',
        tags: [TAG],
        params: purchaseOrderParamsSchema,
        response: { 200: purchaseOrderSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<PurchaseOrder> =>
      getPurchaseOrder(request.params.purchaseOrderId, getContext()),
  );

  app.patch(
    '/v1/purchase-orders/:purchaseOrderId',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'updatePurchaseOrder',
        summary: 'Update a draft purchase order',
        description:
          'Drafts only; an approved purchase order answers `purchase_order_approved`. `lines` ' +
          'replaces the whole set.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: purchaseOrderParamsSchema,
        body: updatePurchaseOrderRequestSchema,
        response: { 200: purchaseOrderSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { purchaseOrderId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'updatePurchaseOrder',
          request: { purchaseOrderId, patch: request.body },
          successStatus: 200,
        },
        () => updatePurchaseOrder(purchaseOrderId, request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<PurchaseOrder>(result));
    },
  );

  app.delete(
    '/v1/purchase-orders/:purchaseOrderId',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'discardPurchaseOrder',
        summary: 'Discard a draft purchase order',
        description:
          'Deletes a draft and its lines. Nothing was approved and no number was allocated, so ' +
          'nothing is restated and no gap is left.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: purchaseOrderParamsSchema,
        response: { 204: noContentSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { purchaseOrderId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'discardPurchaseOrder', request: { purchaseOrderId }, successStatus: 204 },
        () => discardPurchaseOrder(purchaseOrderId, ctx),
      );

      return reply.status(result.status).send(idempotentBody<null>(result));
    },
  );

  app.post(
    '/v1/purchase-orders/:purchaseOrderId/approve',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'approvePurchaseOrder',
        summary: 'Approve a purchase order',
        description:
          'Allocates the purchase order’s gapless number and stamps `approvedAt` (D-M6). Posts ' +
          'no journal (D-M3) — that happens only once it is converted and the resulting bill is ' +
          'itself approved. Refused with `purchase_order_already_approved` when it has already ' +
          'happened, or as a validation failure when the purchase order has no lines with value.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: purchaseOrderParamsSchema,
        response: { 200: purchaseOrderSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { purchaseOrderId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'approvePurchaseOrder', request: { purchaseOrderId }, successStatus: 200 },
        () => approvePurchaseOrder(purchaseOrderId, ctx),
      );

      return reply.status(result.status).send(idempotentBody<PurchaseOrder>(result));
    },
  );

  app.post(
    '/v1/purchase-orders/:purchaseOrderId/convert',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'convertPurchaseOrderToBill',
        summary: 'Convert an approved purchase order into a draft bill',
        description:
          'Builds a draft bill from the purchase order’s header and stored lines and returns it ' +
          '(D-M4). Requires the purchase order to be approved (`purchase_order_not_approved` ' +
          'otherwise) and requires `bills.write` in its own right, since producing a bill is a ' +
          'separate grant from converting the purchase order. Convert-once: a second attempt ' +
          'answers `purchase_order_already_converted` naming the bill already produced.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: purchaseOrderParamsSchema,
        response: { 200: billSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { purchaseOrderId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'convertPurchaseOrderToBill',
          request: { purchaseOrderId },
          successStatus: 200,
        },
        () => convertPurchaseOrderToBill(purchaseOrderId, ctx),
      );

      return reply.status(result.status).send(idempotentBody<Bill>(result));
    },
  );
}
