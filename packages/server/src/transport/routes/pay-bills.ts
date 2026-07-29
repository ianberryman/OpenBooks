import {
  createPendingPaymentRequestSchema,
  issuePendingPaymentRequestSchema,
  issuePendingPaymentsRequestSchema,
  issueOutcomeSchema,
  issueResultSchema,
  payBillsRequestSchema,
  payableBillListSchema,
  pendingPaymentListSchema,
  pendingPaymentSchema,
  pendingPaymentStatusSchema,
  railDisbursementListSchema,
  railSchema,
  updatePendingPaymentRequestSchema,
  updateVendorDisbursementDetailsRequestSchema,
  vendorDisbursementDetailsSchema,
} from '@openbooks/shared-types';
import type {
  IssueOutcome,
  IssueResult,
  PayableBillList,
  PendingPayment,
  PendingPaymentList,
  RailDisbursementList,
  VendorDisbursementDetails,
} from '@openbooks/shared-types';
import { z } from 'zod';

import { getContext } from '../../context';
import { withIdempotency } from '../../modules/idempotency';
import {
  buildPendingPayment,
  cancelPendingPayment,
  getPendingPayment,
  getVendorDisbursementDetails,
  issuePendingPayment,
  issuePendingPayments,
  listDisbursementsByRail,
  listPayableBills,
  listPendingPayments,
  payBills,
  updatePendingPayment,
  updateVendorDisbursementDetails,
} from '../../modules/pay-bills';
import type { App } from '../types';
import {
  ERROR_RESPONSES,
  ORG_SCOPED_WRITE_HOOKS,
  idempotencyKeyHeaderSchema,
  idempotentBody,
  requireOrgScope,
} from './support';

/**
 * `/v1/pending-payments`, `/v1/pay-bills`, `/v1/disbursements`, and a vendor's
 * disbursement details (OB-115; initiative G, Pay Bills; ROADMAP D-63…D-69,
 * D-109…D-112).
 *
 * Handlers map arguments only (spec §2.4); `queue.service.ts`, `issue.service.ts`,
 * `vendor-details.service.ts`, and `rail-disbursements.service.ts` carry every
 * refusal, every permission check, and D-109's separation of duties — building
 * the queue takes `pending_payments.write`/`.read`, releasing it takes
 * `disbursements.issue`. None of that is restated here.
 *
 * ## Two tags, one file
 *
 * The pending-payment queue (`buildPendingPayment` … `listPayableBills`) is
 * tagged `pay-bills`; the two reads whose whole job is handing a vendor's real
 * bank coordinates to an external processor (`listDisbursementsByRail`,
 * `getVendorDisbursementDetails`/`updateVendorDisbursementDetails`) are tagged
 * `disbursements` — the same split `processing.ts`'s header draws between an
 * org's own processor connections and the customer-facing pay-link, one file
 * covering a cohesive feature under two labels a reader of `openapi.json`
 * would expect.
 *
 * ## `issuePendingPayment`/`issuePendingPayments` are writes, and must be
 * idempotent for the reason `recordPayment` is
 *
 * Both post a journal (via `recordPayment`, inside `issue.service.ts`), so a
 * retried issue must replay the original outcome rather than pay a vendor
 * twice. `withIdempotency` is what makes that true here exactly as it does for
 * `recordPayment` itself — the service's own atomic-per-payment guarantee
 * (D-63) is a different property (one vendor's failure does not roll back the
 * others) and does not by itself make a retry safe.
 *
 * ## `listPendingPayments`/`listPayableBills`/`listDisbursementsByRail` return
 * their own envelope, not a bare array
 *
 * All three services already build `{ pendingPayments }` / `{ bills }` /
 * `{ disbursements }` from a `.map()`/`.push()`, so the arrays are already
 * mutable and the envelope is already the wire shape — there is nothing for
 * `wireList` to do here, unlike a route that hands a service's own `readonly`
 * array straight to the client.
 */

const QUEUE_TAG = 'pay-bills';
const DISBURSEMENTS_TAG = 'disbursements';

const pendingPaymentParamsSchema = z.strictObject({ pendingPaymentId: z.uuid() });
const contactParamsSchema = z.strictObject({ contactId: z.uuid() });

/** Local and carrying no `id`: a querystring is emitted as individual `parameters`. */
const listPendingPaymentsWireQuerySchema = z.strictObject({
  status: pendingPaymentStatusSchema.optional().meta({
    description:
      'Omitting this lists every status. `open` is what a clerk building or ' +
      'issuing usually wants.',
  }),
});

/** Local and carrying no `id`, `listPendingPaymentsWireQuerySchema`'s own reason. */
const listDisbursementsWireQuerySchema = z.strictObject({
  rail: railSchema,
});

export function registerPayBillsRoutes(app: App): void {
  app.post(
    '/v1/pending-payments',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'buildPendingPayment',
        summary: 'Build a pending payment',
        description:
          'One vendor per pending payment — a Payment carries one contact and allocations ' +
          'refuse to cross contacts (D-63). Posts no journal (D-64): this only reserves each ' +
          'named bill’s `committed` until issue.',
        tags: [QUEUE_TAG],
        headers: idempotencyKeyHeaderSchema,
        body: createPendingPaymentRequestSchema,
        response: { 201: pendingPaymentSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const result = await withIdempotency(
        { endpoint: 'buildPendingPayment', request: request.body, successStatus: 201 },
        () => buildPendingPayment(request.body, ctx),
      );

      const pendingPayment = idempotentBody<PendingPayment>(result);
      return reply
        .status(result.status)
        .header('location', `/v1/pending-payments/${pendingPayment.id}`)
        .send(pendingPayment);
    },
  );

  app.post(
    '/v1/pay-bills',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'payBills',
        summary: 'Build a batch of pending payments, one per vendor',
        description:
          'The fan-out is already expressed on the wire as one element per vendor (D-63): ' +
          'each is built independently, so one vendor’s refusal does not lose the rest.',
        tags: [QUEUE_TAG],
        headers: idempotencyKeyHeaderSchema,
        body: payBillsRequestSchema,
        response: { 201: pendingPaymentListSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const result = await withIdempotency(
        { endpoint: 'payBills', request: request.body, successStatus: 201 },
        () => payBills(request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<PendingPaymentList>(result));
    },
  );

  app.get(
    '/v1/pending-payments',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listPendingPayments',
        summary: 'List the pending-payment queue',
        description: 'Every pending payment the org holds, optionally filtered by status.',
        tags: [QUEUE_TAG],
        querystring: listPendingPaymentsWireQuerySchema,
        response: { 200: pendingPaymentListSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<PendingPaymentList> => {
      const { status } = request.query;
      return listPendingPayments(getContext(), status === undefined ? undefined : { status });
    },
  );

  app.get(
    '/v1/pending-payments/:pendingPaymentId',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getPendingPayment',
        summary: 'One pending payment',
        tags: [QUEUE_TAG],
        params: pendingPaymentParamsSchema,
        response: { 200: pendingPaymentSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<PendingPayment> =>
      getPendingPayment(request.params.pendingPaymentId, getContext()),
  );

  app.patch(
    '/v1/pending-payments/:pendingPaymentId',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'updatePendingPayment',
        summary: 'Edit an open pending payment',
        description:
          'An omitted field is unchanged. `intents`, when supplied, replaces the set wholesale ' +
          'rather than patching individual lines — the queue is pencil, and rebuilding the ' +
          'line set is how it is edited. Refused once the pending payment is no longer `open`.',
        tags: [QUEUE_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: pendingPaymentParamsSchema,
        body: updatePendingPaymentRequestSchema,
        response: { 200: pendingPaymentSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { pendingPaymentId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'updatePendingPayment',
          request: { pendingPaymentId, patch: request.body },
          successStatus: 200,
        },
        () => updatePendingPayment(pendingPaymentId, request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<PendingPayment>(result));
    },
  );

  app.post(
    '/v1/pending-payments/:pendingPaymentId/cancel',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'cancelPendingPayment',
        summary: 'Cancel an open pending payment',
        description:
          'Frees every bill it named — `committedForBill` counts only `open` intents. No ' +
          'ledger correction is needed because none was ever posted (D-64): a pending payment ' +
          'is pencil, and erasing pencil restates nothing. Refused once no longer `open`.',
        tags: [QUEUE_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: pendingPaymentParamsSchema,
        response: { 200: pendingPaymentSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { pendingPaymentId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'cancelPendingPayment', request: { pendingPaymentId }, successStatus: 200 },
        () => cancelPendingPayment(pendingPaymentId, ctx),
      );

      return reply.status(result.status).send(idempotentBody<PendingPayment>(result));
    },
  );

  app.post(
    '/v1/pending-payments/:pendingPaymentId/issue',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'issuePendingPayment',
        summary: 'Issue one pending payment',
        description:
          'Materialises it into a real Payment (D-65) — the journal, the payAmount ' +
          'allocations, any settlement discount, and any applied vendor credit all post in one ' +
          'transaction. Idempotent: a retried issue replays the original outcome rather than ' +
          'paying the vendor twice.',
        tags: [QUEUE_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: pendingPaymentParamsSchema,
        body: issuePendingPaymentRequestSchema,
        response: { 200: issueOutcomeSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { pendingPaymentId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'issuePendingPayment',
          request: { pendingPaymentId, issue: request.body },
          successStatus: 200,
        },
        () => issuePendingPayment(pendingPaymentId, request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<IssueOutcome>(result));
    },
  );

  app.post(
    '/v1/disbursements/issue',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'issuePendingPayments',
        summary: 'Issue several pending payments in one call',
        description:
          'Atomic per payment, not per run (G2/D-63): each vendor is materialised in its own ' +
          'transaction, so one bad ACH detail leaves the others issued and reports that one ' +
          '`failed` rather than rolling back the batch. Idempotent as a whole call.',
        tags: [DISBURSEMENTS_TAG],
        headers: idempotencyKeyHeaderSchema,
        body: issuePendingPaymentsRequestSchema,
        response: { 200: issueResultSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const result = await withIdempotency(
        { endpoint: 'issuePendingPayments', request: request.body, successStatus: 200 },
        () => issuePendingPayments(request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<IssueResult>(result));
    },
  );

  app.get(
    '/v1/payable-bills',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listPayableBills',
        summary: 'The Pay Bills window',
        description:
          'Every approved, non-void, not-fully-paid bill, with `outstanding`, `committed`, and ' +
          '`availableToPay` computed on read (D-34, D-68) and stored nowhere — a bill an open ' +
          'pending payment already covers shows `availableToPay = 0`.',
        tags: [QUEUE_TAG],
        response: { 200: payableBillListSchema, ...ERROR_RESPONSES },
      },
    },
    async (): Promise<PayableBillList> => listPayableBills(getContext()),
  );

  app.get(
    '/v1/disbursements',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listDisbursementsByRail',
        summary: 'Every disbursement issued on one rail',
        description:
          'The handoff surface an external ACH/wire processor pulls from (D-110) — OpenBooks ' +
          'writes no NACHA file and executes no wire itself. Carries the vendor’s real bank ' +
          'coordinates, gated on the release authority (D-109) rather than the queue-read ' +
          'permission.',
        tags: [DISBURSEMENTS_TAG],
        querystring: listDisbursementsWireQuerySchema,
        response: { 200: railDisbursementListSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<RailDisbursementList> =>
      listDisbursementsByRail(request.query.rail, getContext()),
  );

  app.get(
    '/v1/contacts/:contactId/disbursement-details',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getVendorDisbursementDetails',
        summary: 'A vendor’s ACH/wire disbursement details',
        description:
          'The four `contacts` columns Pay Bills reads to pick a rail default and the ' +
          'coordinates an `ach`/`wire` handoff needs (D-67). Gated on `contacts.read`, not a ' +
          'Pay-Bills-specific key — these are contact fields.',
        tags: [DISBURSEMENTS_TAG],
        params: contactParamsSchema,
        response: { 200: vendorDisbursementDetailsSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<VendorDisbursementDetails> =>
      getVendorDisbursementDetails(request.params.contactId, getContext()),
  );

  app.patch(
    '/v1/contacts/:contactId/disbursement-details',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'updateVendorDisbursementDetails',
        summary: 'Set or clear a vendor’s ACH/wire disbursement details',
        description:
          'An omitted field is left alone; `null` clears it. Gated on `contacts.write`, ' +
          '`getVendorDisbursementDetails`’s own reason.',
        tags: [DISBURSEMENTS_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: contactParamsSchema,
        body: updateVendorDisbursementDetailsRequestSchema,
        response: { 200: vendorDisbursementDetailsSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { contactId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'updateVendorDisbursementDetails',
          request: { contactId, patch: request.body },
          successStatus: 200,
        },
        () => updateVendorDisbursementDetails(contactId, request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<VendorDisbursementDetails>(result));
    },
  );
}
