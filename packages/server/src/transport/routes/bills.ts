import {
  billPageSchema,
  billSchema,
  calendarDateSchema,
  createBillRequestSchema,
  createVendorCreditRequestSchema,
  documentStatusSchema,
  pageCursorSchema,
  updateBillRequestSchema,
  updateVendorCreditRequestSchema,
  vendorCreditPageSchema,
  vendorCreditSchema,
  voidDocumentRequestSchema,
} from '@openbooks/shared-types';
import type { Bill, BillPage, VendorCredit, VendorCreditPage } from '@openbooks/shared-types';
import { z } from 'zod';

import { getContext } from '../../context';
import {
  approveBill,
  approveVendorCredit,
  createBill,
  createVendorCredit,
  discardBill,
  discardVendorCredit,
  getBill,
  getVendorCredit,
  listBills,
  listVendorCredits,
  updateBill,
  updateVendorCredit,
  voidBill,
  voidVendorCredit,
} from '../../modules/bills';
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
 * `/v1/bills` and `/v1/vendor-credits` — the payable side (OB-067, for OB-063).
 *
 * The mirror of `invoices.ts`, and everything argued there holds here: approve and
 * void are `POST`s on their own paths rather than a `PATCH` of a derived `status`,
 * discard is a `DELETE` that only ever removes a draft, and the settlement figures
 * on every response are computed on read (D-34).
 *
 * Two things about this half are genuinely different, and both are worth a client
 * knowing before it writes a screen.
 *
 * ## `reference` is the vendor's own invoice number, and it is filterable
 *
 * D-36: on a bill the reference is the number the vendor prints and quotes when
 * chasing, which is the number that matters on an AP document. So `GET /v1/bills`
 * takes a `reference` filter and `GET /v1/invoices` does not — "have we already
 * entered this bill" is a question someone asks several times a week with the
 * vendor's number in their hand, and nobody looks an invoice up by the customer's
 * purchase-order number.
 *
 * `approveBill` refuses a second approved, un-voided bill quoting one vendor's
 * number with `duplicate_vendor_reference`. That is the refusal that costs money if
 * it is missing — it is how a supplier gets paid twice, and neither the total nor
 * the trial balance shows anything wrong.
 *
 * ## The precondition tokens, now shared with AR (OB-092)
 *
 * AR once raised `409 conflict` where AP raises `precondition_failed`, and spelled
 * two shared facts differently. OB-092 reconciled AR onto this file's spelling — the
 * AP vocabulary won because it is complete and machine-branchable — so both
 * subledgers now answer the four shared facts with the same `412` tokens:
 *
 * | fact                         | token (AR and AP alike)     |
 * | ---------------------------- | --------------------------- |
 * | editing an approved document | `document_approved`         |
 * | approving twice              | `document_already_approved` |
 * | voiding twice                | `document_already_void`     |
 * | voiding with allocations     | `document_has_allocations`  |
 *
 * `test/enforcement/refusal-vocabulary.test.ts` asserts the two vocabularies are
 * equal, the guard that they stay reconciled.
 */

const BILL_TAG = 'bills';
const VENDOR_CREDIT_TAG = 'vendor-credits';

const billParamsSchema = z.strictObject({ billId: z.uuid() });
const vendorCreditParamsSchema = z.strictObject({ vendorCreditId: z.uuid() });

/** Local and carrying no `id`: a querystring is emitted as individual `parameters`. */
const listBillsWireQuerySchema = z.strictObject({
  contactId: z.uuid().optional(),
  status: documentStatusSchema.optional(),
  from: calendarDateSchema.optional(),
  to: calendarDateSchema.optional(),
  dueBefore: calendarDateSchema.optional(),
  reference: z
    .string()
    .trim()
    .min(1)
    .optional()
    .meta({
      description:
        'The vendor’s own invoice number (D-36). This filter exists on bills and not on invoices ' +
        'because it is how someone checks whether a bill has already been entered.',
    }),
  limit: pageLimitQuery('bills'),
  cursor: pageCursorSchema.optional(),
});

const listVendorCreditsWireQuerySchema = z.strictObject({
  contactId: z.uuid().optional(),
  status: documentStatusSchema.optional(),
  from: calendarDateSchema.optional(),
  to: calendarDateSchema.optional(),
  unappliedOnly: z
    .stringbool()
    .optional()
    .meta({
      description:
        'Only vendor credits with something left on them. Accepts `true`/`false` (and `1`/`0`, ' +
        '`yes`/`no`, `on`/`off`).',
    }),
  limit: pageLimitQuery('vendor credits'),
  cursor: pageCursorSchema.optional(),
});

export function registerBillRoutes(app: App): void {
  app.post(
    '/v1/bills',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'createBill',
        summary: 'Create a draft bill',
        description:
          'Creates a draft. `issueDate` is the vendor’s date and is routinely in the past, which ' +
          'is what makes the open-period check at approval the interesting one rather than a ' +
          'formality. `contactId` must be a vendor — `contact_is_not_a_vendor` otherwise.',
        tags: [BILL_TAG],
        headers: idempotencyKeyHeaderSchema,
        body: createBillRequestSchema,
        response: { 201: billSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const result = await withIdempotency(
        { endpoint: 'createBill', request: request.body, successStatus: 201 },
        () => createBill(request.body, ctx),
      );

      const bill = idempotentBody<Bill>(result);
      return reply.status(result.status).header('location', `/v1/bills/${bill.id}`).send(bill);
    },
  );

  app.get(
    '/v1/bills',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listBills',
        summary: 'List bills',
        description:
          'One page of headers with totals and settlement, and no lines. Ordered by ' +
          '`(created_at, id)`, for `listInvoices`’ reasons. `reference` filters on the vendor’s ' +
          'own invoice number.',
        tags: [BILL_TAG],
        querystring: listBillsWireQuerySchema,
        response: { 200: billPageSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<BillPage> => {
      const { contactId, status, from, to, dueBefore, reference, limit, cursor } = request.query;
      return listBills(
        {
          limit,
          ...(cursor === undefined ? {} : { cursor }),
          ...(contactId === undefined ? {} : { contactId }),
          ...(status === undefined ? {} : { status }),
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to }),
          ...(dueBefore === undefined ? {} : { dueBefore }),
          ...(reference === undefined ? {} : { reference }),
        },
        getContext(),
      );
    },
  );

  app.get(
    '/v1/bills/:billId',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getBill',
        summary: 'One bill, with its lines and allocations',
        tags: [BILL_TAG],
        params: billParamsSchema,
        response: { 200: billSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<Bill> => getBill(request.params.billId, getContext()),
  );

  app.patch(
    '/v1/bills/:billId',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'updateBill',
        summary: 'Update a draft bill',
        description:
          'Drafts only; an approved bill answers `document_approved`. `lines` replaces the whole ' +
          'set. The correction after approval is a vendor credit or a void, never an edit (D-38).',
        tags: [BILL_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: billParamsSchema,
        body: updateBillRequestSchema,
        response: { 200: billSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { billId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'updateBill', request: { billId, patch: request.body }, successStatus: 200 },
        () => updateBill(billId, request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<Bill>(result));
    },
  );

  app.delete(
    '/v1/bills/:billId',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'discardBill',
        summary: 'Discard a draft bill',
        description:
          'Deletes a draft and its lines. Nothing reached the ledger and no number was allocated, ' +
          'so nothing is restated and no gap is left.',
        tags: [BILL_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: billParamsSchema,
        response: { 204: noContentSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { billId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'discardBill', request: { billId }, successStatus: 204 },
        () => discardBill(billId, ctx),
      );

      return reply.status(result.status).send(idempotentBody<null>(result));
    },
  );

  app.post(
    '/v1/bills/:billId/approve',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'approveBill',
        summary: 'Approve a bill and post its journal',
        description:
          'The irreversible step (D-38). In one transaction it allocates the bill’s gapless ' +
          'number, posts a balanced journal debiting what was bought and **crediting** the org’s ' +
          'payables control account, and records both. Refusals worth branching on: ' +
          '`duplicate_vendor_reference` when another approved, un-voided bill from this vendor ' +
          'already quotes this `reference`; `payable_control_account_not_set` and ' +
          '`payable_control_account_unusable` naming the org setting to fix; and ' +
          '`document_already_approved` when it has already happened.',
        tags: [BILL_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: billParamsSchema,
        response: { 200: billSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { billId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'approveBill', request: { billId }, successStatus: 200 },
        () => approveBill(billId, ctx),
      );

      return reply.status(result.status).send(idempotentBody<Bill>(result));
    },
  );

  app.post(
    '/v1/bills/:billId/void',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'voidBill',
        summary: 'Void an approved bill',
        description:
          'Posts a reversing journal and records it on the bill; nothing is deleted (D-16, C7). ' +
          'The reversal takes its own `date`, which must fall in an open period. A bill with ' +
          'allocations against it is refused with `document_has_allocations`.',
        tags: [BILL_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: billParamsSchema,
        body: voidDocumentRequestSchema,
        response: { 200: billSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { billId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'voidBill', request: { billId, void: request.body }, successStatus: 200 },
        () => voidBill(billId, request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<Bill>(result));
    },
  );

  app.post(
    '/v1/vendor-credits',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'createVendorCredit',
        summary: 'Create a draft vendor credit',
        description:
          'The AP mirror of a credit note, and a document in its own right (D-39). No `dueDate`: ' +
          'nothing about it falls due, and aging never ages one.',
        tags: [VENDOR_CREDIT_TAG],
        headers: idempotencyKeyHeaderSchema,
        body: createVendorCreditRequestSchema,
        response: { 201: vendorCreditSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const result = await withIdempotency(
        { endpoint: 'createVendorCredit', request: request.body, successStatus: 201 },
        () => createVendorCredit(request.body, ctx),
      );

      const vendorCredit = idempotentBody<VendorCredit>(result);
      return reply
        .status(result.status)
        .header('location', `/v1/vendor-credits/${vendorCredit.id}`)
        .send(vendorCredit);
    },
  );

  app.get(
    '/v1/vendor-credits',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listVendorCredits',
        summary: 'List vendor credits',
        description:
          'One page of headers, ordered by `(created_at, id)`. `settlement.outstanding` reads as ' +
          '“credit still available to apply against bills”.',
        tags: [VENDOR_CREDIT_TAG],
        querystring: listVendorCreditsWireQuerySchema,
        response: { 200: vendorCreditPageSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<VendorCreditPage> => {
      const { contactId, status, from, to, unappliedOnly, limit, cursor } = request.query;
      return listVendorCredits(
        {
          limit,
          ...(cursor === undefined ? {} : { cursor }),
          ...(contactId === undefined ? {} : { contactId }),
          ...(status === undefined ? {} : { status }),
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to }),
          ...(unappliedOnly === undefined ? {} : { unappliedOnly }),
        },
        getContext(),
      );
    },
  );

  app.get(
    '/v1/vendor-credits/:vendorCreditId',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getVendorCredit',
        summary: 'One vendor credit, with its lines and allocations',
        tags: [VENDOR_CREDIT_TAG],
        params: vendorCreditParamsSchema,
        response: { 200: vendorCreditSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<VendorCredit> =>
      getVendorCredit(request.params.vendorCreditId, getContext()),
  );

  app.patch(
    '/v1/vendor-credits/:vendorCreditId',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'updateVendorCredit',
        summary: 'Update a draft vendor credit',
        description: 'Drafts only, and `lines` replaces the whole set. See `updateBill`.',
        tags: [VENDOR_CREDIT_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: vendorCreditParamsSchema,
        body: updateVendorCreditRequestSchema,
        response: { 200: vendorCreditSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { vendorCreditId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'updateVendorCredit',
          request: { vendorCreditId, patch: request.body },
          successStatus: 200,
        },
        () => updateVendorCredit(vendorCreditId, request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<VendorCredit>(result));
    },
  );

  app.delete(
    '/v1/vendor-credits/:vendorCreditId',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'discardVendorCredit',
        summary: 'Discard a draft vendor credit',
        tags: [VENDOR_CREDIT_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: vendorCreditParamsSchema,
        response: { 204: noContentSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { vendorCreditId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'discardVendorCredit', request: { vendorCreditId }, successStatus: 204 },
        () => discardVendorCredit(vendorCreditId, ctx),
      );

      return reply.status(result.status).send(idempotentBody<null>(result));
    },
  );

  app.post(
    '/v1/vendor-credits/:vendorCreditId/approve',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'approveVendorCredit',
        summary: 'Approve a vendor credit and post its journal',
        description:
          'Allocates the vendor credit’s own gapless number — a separate series from bills — and ' +
          'posts the mirror of a bill’s journal, debiting payables. Approving makes the credit ' +
          'available; applying it to a bill is a separate fact (D-39): see ' +
          '`POST /v1/vendor-credits/{vendorCreditId}/allocations`.',
        tags: [VENDOR_CREDIT_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: vendorCreditParamsSchema,
        response: { 200: vendorCreditSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { vendorCreditId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'approveVendorCredit', request: { vendorCreditId }, successStatus: 200 },
        () => approveVendorCredit(vendorCreditId, ctx),
      );

      return reply.status(result.status).send(idempotentBody<VendorCredit>(result));
    },
  );

  app.post(
    '/v1/vendor-credits/:vendorCreditId/void',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'voidVendorCredit',
        summary: 'Void an approved vendor credit',
        description:
          'A reversing journal, never a deletion. A vendor credit that has been applied to a bill ' +
          'is refused with `document_has_allocations`.',
        tags: [VENDOR_CREDIT_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: vendorCreditParamsSchema,
        body: voidDocumentRequestSchema,
        response: { 200: vendorCreditSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { vendorCreditId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'voidVendorCredit',
          request: { vendorCreditId, void: request.body },
          successStatus: 200,
        },
        () => voidVendorCredit(vendorCreditId, request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<VendorCredit>(result));
    },
  );
}
