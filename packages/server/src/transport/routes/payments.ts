import {
  allocationListSchema,
  calendarDateSchema,
  createAllocationsRequestSchema,
  createPaymentRequestSchema,
  pageCursorSchema,
  paymentDirectionSchema,
  paymentPageSchema,
  paymentSchema,
  paymentStatusSchema,
  updatePaymentRequestSchema,
  voidDocumentRequestSchema,
} from '@openbooks/shared-types';
import type { AllocationList, Payment, PaymentPage } from '@openbooks/shared-types';
import { z } from 'zod';

import { getContext } from '../../context';
import { withIdempotency } from '../../modules/idempotency';
import {
  allocateCreditNote,
  allocatePayment,
  allocateVendorCredit,
  deleteAllocation,
  getPayment,
  listPayments,
  recordPayment,
  updatePayment,
  voidPayment,
} from '../../modules/payments';
import type { App } from '../types';
import {
  ERROR_RESPONSES,
  ORG_SCOPED_WRITE_HOOKS,
  idempotencyKeyHeaderSchema,
  idempotentBody,
  noContentSchema,
  pageLimitQuery,
  requireOrgScope,
  wireList,
} from './support';

/**
 * `/v1/payments` and the allocation surface (OB-067, for OB-064; ROADMAP D-37,
 * D-39, D-40).
 *
 * ## Every allocation route is here, including the two on AR and AP documents
 *
 * `POST /v1/credit-notes/{creditNoteId}/allocations` and
 * `POST /v1/vendor-credits/{vendorCreditId}/allocations` are registered from this
 * file even though their paths sit under the document collections, because they call
 * `allocateCreditNote` and `allocateVendorCredit` — which are the *same mechanism* as
 * `allocatePayment` (D-39). The three differ in which permission they check, where
 * the available amount is read from, and what the default date is; everything after
 * that is one function.
 *
 * Routing them into `invoices.ts` and `bills.ts` would put two of the three sources
 * of an allocation in one place and the third in another, and the thing that goes
 * wrong when that happens is specific: "what is outstanding" would acquire a second
 * definition, which is exactly what D-39 chose one mechanism to prevent and what C2
 * exists to catch. The path names the resource being applied; the file names the
 * module that owns applying.
 *
 * ## An allocation posts no journal, so `DELETE` is a real delete
 *
 * By the time an allocation is written, both sides are already in the ledger: the
 * payment's journal debited the bank and credited the control account, and the
 * credit note's journal posted when it was approved. A second posting here would
 * double-count. So an allocation is an ordinary mutable row, and
 * `DELETE /v1/allocations/{allocationId}` removes it outright — a 204 with no body
 * and, uniquely on this surface's writes, no request body at all. Nothing in any
 * financial statement changes; what changes is what is outstanding, and that is
 * computed on read (D-34), so there is nothing else to correct anywhere.
 *
 * The permission it takes is the *source's* — un-applying is a change to what that
 * payment or credit note has done — which is why the route names no permission and
 * could not: the service resolves the allocation before it knows which one to ask
 * for. `requirePermission` is service-layer only (spec §5).
 *
 * ## `listPayments` with no `direction` needs both permissions, and the route says so
 *
 * An unfiltered list spans both subledgers, so it is a read of both and
 * `payments.service.ts` requires `payments_received.read` *and*
 * `payments_made.read`. A caller holding one side filters by `direction` and gets
 * their side.
 *
 * The route does not re-check it and must not (spec §2.4, §5). What it does do is
 * document it, because the alternative behaviour — silently returning only the rows
 * the caller may see — is the one a client would otherwise assume, and an AR clerk
 * looking at a payments list that quietly omitted half the business would have no
 * way to know.
 *
 * ## Recording and applying in one call
 *
 * `POST /v1/payments` accepts `allocations`, so the ordinary case — one payment
 * settling one invoice — is a single idempotent write. Two calls would leave a
 * window in which the money is recorded and unapplied, and a client that failed
 * between them would have created the orphan credit that makes people distrust the
 * feature. The batch is still all-or-nothing: over-allocating any target refuses the
 * whole request, and the payment is not recorded either.
 */

const PAYMENT_TAG = 'payments';
const ALLOCATION_TAG = 'allocations';

const paymentParamsSchema = z.strictObject({ paymentId: z.uuid() });
const allocationParamsSchema = z.strictObject({ allocationId: z.uuid() });
const creditNoteParamsSchema = z.strictObject({ creditNoteId: z.uuid() });
const vendorCreditParamsSchema = z.strictObject({ vendorCreditId: z.uuid() });

/** Local and carrying no `id`: a querystring is emitted as individual `parameters`. */
const listPaymentsWireQuerySchema = z.strictObject({
  direction: paymentDirectionSchema.optional().meta({
    description:
      'Omitting this lists both subledgers, which requires `payments_received.read` **and** ' +
      '`payments_made.read`. A caller holding one side filters by it and gets their side — the ' +
      'list is never silently narrowed to what the caller may see.',
  }),
  contactId: z.uuid().optional(),
  status: paymentStatusSchema.optional(),
  from: calendarDateSchema.optional(),
  to: calendarDateSchema.optional(),
  unallocatedOnly: z
    .stringbool()
    .optional()
    .meta({
      description:
        'Only payments with credit still available on them (D-37). Accepts `true`/`false` (and ' +
        '`1`/`0`, `yes`/`no`, `on`/`off`).',
    }),
  limit: pageLimitQuery('payments'),
  cursor: pageCursorSchema.optional(),
});

export function registerPaymentRoutes(app: App): void {
  app.post(
    '/v1/payments',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'recordPayment',
        summary: 'Record a payment, optionally applying it',
        description:
          'Posts a journal moving money through `accountId` against the control account the ' +
          '`direction` chooses, and optionally applies it in the same transaction. `allocations` ' +
          'may be absent or short of `amount`: over-**paying** is fine and the remainder is a ' +
          'credit balance on the contact (D-37), while over-allocating a document is refused ' +
          'with `document_over_allocated` and takes the whole request with it. A payment has no ' +
          'draft state and no gapless number — money either moved or it did not.',
        tags: [PAYMENT_TAG],
        headers: idempotencyKeyHeaderSchema,
        body: createPaymentRequestSchema,
        response: { 201: paymentSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const result = await withIdempotency(
        { endpoint: 'recordPayment', request: request.body, successStatus: 201 },
        () => recordPayment(request.body, ctx),
      );

      const payment = idempotentBody<Payment>(result);
      return reply
        .status(result.status)
        .header('location', `/v1/payments/${payment.id}`)
        .send(payment);
    },
  );

  app.get(
    '/v1/payments',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listPayments',
        summary: 'List payments',
        description:
          'One page, ordered by `(created_at, id)` and not by `date`: payments are recorded in ' +
          'whatever order the paperwork surfaces, so a back-dated one would land behind a cursor ' +
          'that had already passed its date and appear on no page at all. Omitting `direction` ' +
          'spans both subledgers and therefore requires both read permissions.',
        tags: [PAYMENT_TAG],
        querystring: listPaymentsWireQuerySchema,
        response: { 200: paymentPageSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<PaymentPage> => {
      const { direction, contactId, status, from, to, unallocatedOnly, limit, cursor } =
        request.query;
      return listPayments(
        {
          limit,
          ...(cursor === undefined ? {} : { cursor }),
          ...(direction === undefined ? {} : { direction }),
          ...(contactId === undefined ? {} : { contactId }),
          ...(status === undefined ? {} : { status }),
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to }),
          ...(unallocatedOnly === undefined ? {} : { unallocatedOnly }),
        },
        getContext(),
      );
    },
  );

  app.get(
    '/v1/payments/:paymentId',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getPayment',
        summary: 'One payment, with its allocations',
        description:
          '`settlement.outstanding` is the credit still available on the contact — the same ' +
          'arithmetic as an invoice’s “still owed”, computed on read (D-34).',
        tags: [PAYMENT_TAG],
        params: paymentParamsSchema,
        response: { 200: paymentSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<Payment> => getPayment(request.params.paymentId, getContext()),
  );

  app.patch(
    '/v1/payments/:paymentId',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'updatePayment',
        summary: 'Update a payment’s reference and memo',
        description:
          'The text a human wrote, and nothing else. `amount`, `date`, `accountId` and ' +
          '`direction` are facts the posted journal carries and a journal is never edited (spec ' +
          '§2.2, D-16) — a payment recorded wrongly is voided and recorded again.',
        tags: [PAYMENT_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: paymentParamsSchema,
        body: updatePaymentRequestSchema,
        response: { 200: paymentSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { paymentId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'updatePayment',
          request: { paymentId, patch: request.body },
          successStatus: 200,
        },
        () => updatePayment(paymentId, request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<Payment>(result));
    },
  );

  app.post(
    '/v1/payments/:paymentId/void',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'voidPayment',
        summary: 'Void a payment',
        description:
          'Posts a reversing journal and **deletes the allocations this payment made** — the ' +
          'money did not move, so nothing it settled is settled, and outstanding is a sum over ' +
          'those rows rather than a column anyone could correct. The payment itself stays ' +
          'visible with both journals (D-16). The reversal takes its own `date`, which must fall ' +
          'in an open period.',
        tags: [PAYMENT_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: paymentParamsSchema,
        body: voidDocumentRequestSchema,
        response: { 200: paymentSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { paymentId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'voidPayment', request: { paymentId, void: request.body }, successStatus: 200 },
        () => voidPayment(paymentId, request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<Payment>(result));
    },
  );

  app.post(
    '/v1/payments/:paymentId/allocations',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'allocatePayment',
        summary: 'Apply a recorded payment to documents',
        description:
          'Applies up to the payment’s unallocated remainder across one or more invoices or ' +
          'bills. A batch, because “this transfer paid three invoices” is one decision by one ' +
          'person and has to succeed or fail as one. Posts no journal: the money entered the ' +
          'ledger when the payment was recorded, and a second posting would double-count. ' +
          'Refusals: `document_over_allocated` when a target would be settled past its total ' +
          '(C3), `source_over_allocated` when the payment has less left than the batch asks for, ' +
          '`allocation_target_mismatch` when a target is on the other subledger, ' +
          '`allocation_contact_mismatch` when it belongs to a different contact, ' +
          '`document_not_approved` for a draft target, `document_void`, and `payment_void`.',
        tags: [ALLOCATION_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: paymentParamsSchema,
        body: createAllocationsRequestSchema,
        response: { 201: allocationListSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { paymentId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'allocatePayment',
          request: { paymentId, body: request.body },
          successStatus: 201,
        },
        async () => ({
          allocations: wireList(await allocatePayment(paymentId, request.body, ctx)),
        }),
      );

      return reply.status(result.status).send(idempotentBody<AllocationList>(result));
    },
  );

  app.post(
    '/v1/credit-notes/:creditNoteId/allocations',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'allocateCreditNote',
        summary: 'Apply a credit note to invoices',
        description:
          'D-39’s whole point: a credit note reduces what is owed through the same rows a ' +
          'payment does, so “what is outstanding” has one definition regardless of what reduced ' +
          'it. Available is the credit note’s total less what has already been applied, read ' +
          'under its row lock. Takes `credit_notes.write`. Targets must be invoices belonging to ' +
          'the same contact; the refusals are `allocatePayment`’s.',
        tags: [ALLOCATION_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: creditNoteParamsSchema,
        body: createAllocationsRequestSchema,
        response: { 201: allocationListSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { creditNoteId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'allocateCreditNote',
          request: { creditNoteId, body: request.body },
          successStatus: 201,
        },
        async () => ({
          allocations: wireList(await allocateCreditNote(creditNoteId, request.body, ctx)),
        }),
      );

      return reply.status(result.status).send(idempotentBody<AllocationList>(result));
    },
  );

  app.post(
    '/v1/vendor-credits/:vendorCreditId/allocations',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'allocateVendorCredit',
        summary: 'Apply a vendor credit to bills',
        description:
          'The payables mirror of `allocateCreditNote`, taking `vendor_credits.write`. Targets ' +
          'must be bills belonging to the same contact.',
        tags: [ALLOCATION_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: vendorCreditParamsSchema,
        body: createAllocationsRequestSchema,
        response: { 201: allocationListSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { vendorCreditId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'allocateVendorCredit',
          request: { vendorCreditId, body: request.body },
          successStatus: 201,
        },
        async () => ({
          allocations: wireList(await allocateVendorCredit(vendorCreditId, request.body, ctx)),
        }),
      );

      return reply.status(result.status).send(idempotentBody<AllocationList>(result));
    },
  );

  /**
   * The one write on this surface that takes an id and nothing else — no body,
   * because there is nothing to say about un-applying beyond which allocation.
   */
  app.delete(
    '/v1/allocations/:allocationId',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'deleteAllocation',
        summary: 'Un-apply an allocation',
        description:
          'Removes the row outright. This restates no financial statement — an allocation posted ' +
          'no journal — and it needs no reversal, because what it changes is what is outstanding ' +
          'and that is computed on read (D-34). The permission taken is the source’s: un-' +
          'applying is a change to what that payment or credit note has done.',
        tags: [ALLOCATION_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: allocationParamsSchema,
        response: { 204: noContentSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { allocationId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'deleteAllocation', request: { allocationId }, successStatus: 204 },
        () => deleteAllocation(allocationId, ctx),
      );

      return reply.status(result.status).send(idempotentBody<null>(result));
    },
  );
}
