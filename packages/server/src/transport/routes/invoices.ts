import {
  calendarDateSchema,
  createCreditNoteRequestSchema,
  createInvoiceRequestSchema,
  creditNotePageSchema,
  creditNoteSchema,
  documentStatusSchema,
  invoicePageSchema,
  invoiceSchema,
  pageCursorSchema,
  updateCreditNoteRequestSchema,
  updateInvoiceRequestSchema,
  voidDocumentRequestSchema,
} from '@openbooks/shared-types';
import type { CreditNote, CreditNotePage, Invoice, InvoicePage } from '@openbooks/shared-types';
import { z } from 'zod';

import { getContext } from '../../context';
import { withIdempotency } from '../../modules/idempotency';
import {
  approveCreditNote,
  approveInvoice,
  createCreditNote,
  createInvoice,
  discardCreditNote,
  discardInvoice,
  getCreditNote,
  getInvoice,
  listCreditNotes,
  listInvoices,
  updateCreditNote,
  updateInvoice,
  voidCreditNote,
  voidInvoice,
} from '../../modules/invoices';
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
 * `/v1/invoices` and `/v1/credit-notes` — the receivable side (OB-067, for OB-062;
 * ROADMAP D-34, D-36, D-38, D-39).
 *
 * ## Approve and void are `POST`s on their own paths, not a `PATCH` of `status`
 *
 * This is the shape decision the ticket asked for, and there are four arguments
 * against `PATCH { status: 'approved' }`. The first alone is decisive.
 *
 * 1. **`status` is derived, so a client cannot write it** (D-38). `draft`,
 *    `approved`, `part_paid`, `paid` and `void` are read from `journal_id`,
 *    `void_journal_id` and a sum over allocations; there is no column to set. A
 *    `PATCH` naming the field would publish a contract in which a computed value is
 *    writable, which is the first step towards someone storing it — and D-38 exists
 *    because a stored status drifts the first time an allocation is removed.
 * 2. **Two of the five values are unreachable by any request.** `part_paid` and
 *    `paid` follow from allocating, so a status-shaped `PATCH` would accept an enum
 *    of which three members mean "do a thing" and two mean "you cannot ask for
 *    that". An operation whose argument is mostly invalid is not an operation.
 * 3. **Void carries a body a patch has nowhere to put.** `voidDocumentRequestSchema`
 *    takes the reversal's own entry date and a memo, because the document's period is
 *    usually closed by the time anyone voids it. `{ status: 'void', date, memo }`
 *    makes two of three fields conditional on the first.
 * 4. **The two transitions are not updates.** Approving posts a balanced journal
 *    through `postJournal`, allocates the gapless number, and is irreversible;
 *    `updateInvoice` edits a draft and touches no ledger. `PATCH` promising "an
 *    absent field is unchanged" (`updateAccountRequestSchema`'s contract) while one
 *    of its fields writes to an append-only ledger is a method whose effect depends
 *    on which key the body happens to carry.
 *
 * So they are `POST …/approve` and `POST …/void`, which is also what the rest of
 * this surface already does for a state change with its own rules —
 * `deactivateAccount`, `closeFiscalPeriod`, `postDraft`, `reverseJournal`. Approve
 * takes no body at all, deliberately: `invoices.ts` in `shared-types` argues that
 * the first field anyone would add is the one letting a client date the journal
 * differently from the invoice it is posting.
 *
 * ## Discard is `DELETE`, and it is only ever a draft
 *
 * `DELETE /v1/invoices/{id}` on a draft deletes it, exactly as `discardDraft` does
 * and for the same reason (D-19): nothing about it reached the ledger and it holds
 * no number, so removing it restates nothing and leaves no gap. On an approved
 * document it is a `precondition_failed` carrying `document_approved` — the
 * correction is a credit note or a void, and a `DELETE` that sometimes reversed a
 * journal would be a deletion that is not one.
 *
 * ## The response carries the settlement, and it is computed
 *
 * `settlement.allocated` and `settlement.outstanding` are on every document
 * response and on every list summary, and neither is a column: they are the total
 * minus the allocations applied, computed on read (D-34). They are returned rather
 * than left to the client because a client that summed `allocations` itself would
 * be a second definition of outstanding — the exact divergence C2 exists to catch —
 * and because a list that could not show what is owed is a list nobody can use.
 * `documentSettlementSchema` says so in the published document, so the property is
 * stated to an integrator and not only here.
 *
 * ## Allocation is not in this file
 *
 * `POST /v1/credit-notes/{id}/allocations` lives in `payments.ts`, because it calls
 * `allocateCreditNote` — D-39's single mechanism, shared with payments and vendor
 * credits. Routing it here would put two of the three sources of an allocation in
 * one place and the third somewhere else, which is how a second definition of
 * outstanding gets written.
 */

const INVOICE_TAG = 'invoices';
const CREDIT_NOTE_TAG = 'credit-notes';

const invoiceParamsSchema = z.strictObject({ invoiceId: z.uuid() });
const creditNoteParamsSchema = z.strictObject({ creditNoteId: z.uuid() });

/**
 * Local and carrying no `id`, for `listAccountsWireQuerySchema`'s reason: a
 * querystring is emitted as individual `parameters`, so a component for one would be
 * referenced by nothing — and the shared schema takes real booleans because it is
 * reachable from a JSON body too.
 */
const listInvoicesWireQuerySchema = z.strictObject({
  contactId: z.uuid().optional(),
  status: documentStatusSchema.optional().meta({
    description:
      'Filters on a value that is computed rather than stored (D-38), so this is a join against ' +
      'allocations rather than an index lookup. That is D-34’s accepted cost.',
  }),
  from: calendarDateSchema.optional(),
  to: calendarDateSchema.optional(),
  dueBefore: calendarDateSchema.optional().meta({
    description:
      'Only invoices due strictly before this date — “what is late”. Separate from `from`/`to`, ' +
      'which bound the issue date.',
  }),
  limit: pageLimitQuery('invoices'),
  cursor: pageCursorSchema.optional(),
});

const listCreditNotesWireQuerySchema = z.strictObject({
  contactId: z.uuid().optional(),
  status: documentStatusSchema.optional(),
  from: calendarDateSchema.optional(),
  to: calendarDateSchema.optional(),
  unappliedOnly: z
    .stringbool()
    .optional()
    .meta({
      description:
        'Only credit notes with something left on them — `settlement.outstanding` non-zero. This ' +
        'is what an “apply a credit” screen lists. Accepts `true`/`false` (and `1`/`0`, ' +
        '`yes`/`no`, `on`/`off`).',
    }),
  limit: pageLimitQuery('credit notes'),
  cursor: pageCursorSchema.optional(),
});

export function registerInvoiceRoutes(app: App): void {
  app.post(
    '/v1/invoices',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'createInvoice',
        summary: 'Create a draft invoice',
        description:
          'Creates a draft. Nothing is posted and no number is allocated — a number reserved by a ' +
          'draft that was then discarded would leave a gap, and a gap in a document series is ' +
          'indistinguishable from a deletion (D-36). `dueDate` defaults to `issueDate`.',
        tags: [INVOICE_TAG],
        headers: idempotencyKeyHeaderSchema,
        body: createInvoiceRequestSchema,
        response: { 201: invoiceSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const result = await withIdempotency(
        { endpoint: 'createInvoice', request: request.body, successStatus: 201 },
        () => createInvoice(request.body, ctx),
      );

      const invoice = idempotentBody<Invoice>(result);
      return reply
        .status(result.status)
        .header('location', `/v1/invoices/${invoice.id}`)
        .send(invoice);
    },
  );

  app.get(
    '/v1/invoices',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listInvoices',
        summary: 'List invoices',
        description:
          'One page of headers with totals and settlement, and no lines. Ordered by ' +
          '`(created_at, id)` and not by document number: a draft has none until approval, and ' +
          '`issueDate` is editable while it is a draft — a keyset over a mutable column silently ' +
          'drops the rows that moved behind the cursor.',
        tags: [INVOICE_TAG],
        querystring: listInvoicesWireQuerySchema,
        response: { 200: invoicePageSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<InvoicePage> => {
      const { contactId, status, from, to, dueBefore, limit, cursor } = request.query;
      return listInvoices(
        {
          limit,
          ...(cursor === undefined ? {} : { cursor }),
          ...(contactId === undefined ? {} : { contactId }),
          ...(status === undefined ? {} : { status }),
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to }),
          ...(dueBefore === undefined ? {} : { dueBefore }),
        },
        getContext(),
      );
    },
  );

  app.get(
    '/v1/invoices/:invoiceId',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getInvoice',
        summary: 'One invoice, with its lines and allocations',
        description:
          '`status` and `settlement` are computed from the journals and the allocations on every ' +
          'read (D-34, D-38). Neither is stored, and neither may be written back.',
        tags: [INVOICE_TAG],
        params: invoiceParamsSchema,
        response: { 200: invoiceSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<Invoice> => getInvoice(request.params.invoiceId, getContext()),
  );

  app.patch(
    '/v1/invoices/:invoiceId',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'updateInvoice',
        summary: 'Update a draft invoice',
        description:
          'Drafts only. An approved invoice answers `precondition_failed` with ' +
          '`document_approved`: the ledger has been told, and the correction is a credit note ' +
          'or a void (D-38). `lines` replaces the whole set, and changing `taxMode` reprices ' +
          'them rather than converting them.',
        tags: [INVOICE_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: invoiceParamsSchema,
        body: updateInvoiceRequestSchema,
        response: { 200: invoiceSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { invoiceId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'updateInvoice',
          request: { invoiceId, patch: request.body },
          successStatus: 200,
        },
        () => updateInvoice(invoiceId, request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<Invoice>(result));
    },
  );

  app.delete(
    '/v1/invoices/:invoiceId',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'discardInvoice',
        summary: 'Discard a draft invoice',
        description:
          'Deletes a draft and its lines. Nothing in the ledger changes, because nothing about ' +
          'this invoice ever reached it, and no number is freed because none was allocated. An ' +
          'approved invoice is refused with `document_approved` — void it instead.',
        tags: [INVOICE_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: invoiceParamsSchema,
        response: { 204: noContentSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { invoiceId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'discardInvoice', request: { invoiceId }, successStatus: 204 },
        () => discardInvoice(invoiceId, ctx),
      );

      return reply.status(result.status).send(idempotentBody<null>(result));
    },
  );

  app.post(
    '/v1/invoices/:invoiceId/approve',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'approveInvoice',
        summary: 'Approve an invoice and post its journal',
        description:
          'The irreversible step (D-38), and the only thing on this path that writes to the ' +
          'ledger (C1): in one transaction it allocates the gapless document number, posts a ' +
          'balanced journal debiting the org’s receivables control account, and records both. No ' +
          'body — the entry date is the invoice’s own `issueDate` and the actor is the session. ' +
          'Refusals worth branching on: `receivable_control_account_not_set` and ' +
          '`receivable_control_account_unusable` are `precondition_failed` naming the org ' +
          'setting to fix, and an invoice that is already approved is a `409 conflict` — ' +
          'approval posts to the ledger and happens once.',
        tags: [INVOICE_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: invoiceParamsSchema,
        response: { 200: invoiceSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { invoiceId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'approveInvoice', request: { invoiceId }, successStatus: 200 },
        () => approveInvoice(invoiceId, ctx),
      );

      return reply.status(result.status).send(idempotentBody<Invoice>(result));
    },
  );

  app.post(
    '/v1/invoices/:invoiceId/void',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'voidInvoice',
        summary: 'Void an approved invoice',
        description:
          'Posts a reversing journal and records it on the invoice. Nothing is deleted: the ' +
          'invoice, its number and its original journal all stay visible, because a voided ' +
          'document that vanished would make the gapless sequence a lie (D-16, D-38, C7). The ' +
          'reversal takes its own `date`, which must fall in an open period. An invoice with ' +
          'allocations against it is refused with `document_has_allocations` — un-apply them first, or ' +
          'the payment would read as fully applied while the receivable had been reversed.',
        tags: [INVOICE_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: invoiceParamsSchema,
        body: voidDocumentRequestSchema,
        response: { 200: invoiceSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { invoiceId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'voidInvoice', request: { invoiceId, void: request.body }, successStatus: 200 },
        () => voidInvoice(invoiceId, request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<Invoice>(result));
    },
  );

  app.post(
    '/v1/credit-notes',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'createCreditNote',
        summary: 'Create a draft credit note',
        description:
          'A credit note is a document, not a negative invoice (D-39): its lines are positive and ' +
          'the direction is what the type carries. There is no `dueDate` — nothing about a credit ' +
          'note falls due, and aging never ages one.',
        tags: [CREDIT_NOTE_TAG],
        headers: idempotencyKeyHeaderSchema,
        body: createCreditNoteRequestSchema,
        response: { 201: creditNoteSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const result = await withIdempotency(
        { endpoint: 'createCreditNote', request: request.body, successStatus: 201 },
        () => createCreditNote(request.body, ctx),
      );

      const creditNote = idempotentBody<CreditNote>(result);
      return reply
        .status(result.status)
        .header('location', `/v1/credit-notes/${creditNote.id}`)
        .send(creditNote);
    },
  );

  app.get(
    '/v1/credit-notes',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listCreditNotes',
        summary: 'List credit notes',
        description:
          'One page of headers, ordered by `(created_at, id)` for `listInvoices`’ reasons. ' +
          '`settlement.outstanding` here reads as “credit still available to apply” — the same ' +
          'arithmetic as an invoice’s “still owed” (D-34).',
        tags: [CREDIT_NOTE_TAG],
        querystring: listCreditNotesWireQuerySchema,
        response: { 200: creditNotePageSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<CreditNotePage> => {
      const { contactId, status, from, to, unappliedOnly, limit, cursor } = request.query;
      return listCreditNotes(
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
    '/v1/credit-notes/:creditNoteId',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getCreditNote',
        summary: 'One credit note, with its lines and allocations',
        tags: [CREDIT_NOTE_TAG],
        params: creditNoteParamsSchema,
        response: { 200: creditNoteSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<CreditNote> =>
      getCreditNote(request.params.creditNoteId, getContext()),
  );

  app.patch(
    '/v1/credit-notes/:creditNoteId',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'updateCreditNote',
        summary: 'Update a draft credit note',
        description: 'Drafts only, and `lines` replaces the whole set. See `updateInvoice`.',
        tags: [CREDIT_NOTE_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: creditNoteParamsSchema,
        body: updateCreditNoteRequestSchema,
        response: { 200: creditNoteSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { creditNoteId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'updateCreditNote',
          request: { creditNoteId, patch: request.body },
          successStatus: 200,
        },
        () => updateCreditNote(creditNoteId, request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<CreditNote>(result));
    },
  );

  app.delete(
    '/v1/credit-notes/:creditNoteId',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'discardCreditNote',
        summary: 'Discard a draft credit note',
        tags: [CREDIT_NOTE_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: creditNoteParamsSchema,
        response: { 204: noContentSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { creditNoteId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'discardCreditNote', request: { creditNoteId }, successStatus: 204 },
        () => discardCreditNote(creditNoteId, ctx),
      );

      return reply.status(result.status).send(idempotentBody<null>(result));
    },
  );

  app.post(
    '/v1/credit-notes/:creditNoteId/approve',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'approveCreditNote',
        summary: 'Approve a credit note and post its journal',
        description:
          'Allocates the credit note’s own gapless number — a separate series from invoices, ' +
          'because they are separate series to the people who read them (D-36) — and posts the ' +
          'mirror of an invoice’s journal, crediting receivables. Approving makes the credit ' +
          'available; it does not apply it to anything. That is a separate fact (D-39): see ' +
          '`POST /v1/credit-notes/{creditNoteId}/allocations`.',
        tags: [CREDIT_NOTE_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: creditNoteParamsSchema,
        response: { 200: creditNoteSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { creditNoteId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'approveCreditNote', request: { creditNoteId }, successStatus: 200 },
        () => approveCreditNote(creditNoteId, ctx),
      );

      return reply.status(result.status).send(idempotentBody<CreditNote>(result));
    },
  );

  app.post(
    '/v1/credit-notes/:creditNoteId/void',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'voidCreditNote',
        summary: 'Void an approved credit note',
        description:
          'A reversing journal, never a deletion. A credit note that has been applied to an ' +
          'invoice is refused with `document_has_allocations`.',
        tags: [CREDIT_NOTE_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: creditNoteParamsSchema,
        body: voidDocumentRequestSchema,
        response: { 200: creditNoteSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { creditNoteId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'voidCreditNote',
          request: { creditNoteId, void: request.body },
          successStatus: 200,
        },
        () => voidCreditNote(creditNoteId, request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<CreditNote>(result));
    },
  );
}
