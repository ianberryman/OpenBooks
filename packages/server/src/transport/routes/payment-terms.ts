import {
  calendarDateSchema,
  createPaymentTermRequestSchema,
  discountSuggestionSchema,
  paymentTermListSchema,
  paymentTermSchema,
  updatePaymentTermRequestSchema,
} from '@openbooks/shared-types';
import type { DiscountSuggestion, PaymentTerm, PaymentTermList } from '@openbooks/shared-types';
import { z } from 'zod';

import { getContext } from '../../context';
import { withIdempotency } from '../../modules/idempotency';
import {
  createPaymentTerm,
  deactivatePaymentTerm,
  getPaymentTerm,
  listPaymentTerms,
  suggestDiscount,
  updatePaymentTerm,
} from '../../modules/payment-terms';
import type { App } from '../types';
import {
  ERROR_RESPONSES,
  ORG_SCOPED_WRITE_HOOKS,
  idempotencyKeyHeaderSchema,
  idempotentBody,
  noContentSchema,
  requireOrgScope,
  wireList,
} from './support';

/**
 * `/v1/payment-terms` and the discount-suggestion preview (OB-139; initiative I,
 * Cash application; ROADMAP D-79, D-106, D-107, D-108).
 *
 * `terms.service.ts` carries the CRUD and `orgs.read`/`orgs.write` (D-107: no new
 * catalog key — a term nomination is settings-like exactly as the control
 * accounts and the discount accounts beside it in `settings.ts` are). This file
 * only maps arguments (spec §2.4); every refusal and every permission check is
 * the service's.
 *
 * ## Deactivate is its own route, `deactivateAccount`'s reason
 *
 * `isActive` is reachable through `PATCH` on nothing else here — deactivating a
 * term is given its own `POST …/deactivate`, matching `deactivateAccount` and
 * `deactivateRecurringInvoiceTemplate`: a state change every future document's
 * term picker depends on should not be a side effect of a rename, and idempotency
 * matters here for the same reason it matters there — a retried deactivate
 * returns the term unchanged rather than failing on the state it was trying to
 * reach.
 *
 * ## The discount-suggestion preview answers `204`, not an error, when nothing applies
 *
 * `GET /v1/payment-terms/discount-suggestion` is a preview a bank-match workbench
 * or the manual money-in screen calls before a human confirms a `discount`
 * clearing entry (D-106) — never written here, never auto-posted (D-43). A
 * document with no term, a simple term, or a rich term whose window has already
 * passed relative to `asOfDate` is not a refusal; it is the ordinary answer "no
 * discount currently applies", and modelling that as `204 No Content` keeps this
 * an ordinary idempotent read rather than inventing an error token for a state
 * that is ordinary.
 *
 * It takes `payments_received.read` rather than `banking.match` — the ticket's
 * own choice of *a* read over the write that gates actually clearing a bank
 * line — because a preview computes and posts nothing, and `payments_received.read`
 * is the permission both call sites already hold: the bank-match workbench reads
 * proposals before it ever reaches `banking.match`'s clearing write, and the
 * manual money-in screen reads the invoice and its payments before recording one.
 * `banking.match` would make the preview unreachable from money-in, which never
 * touches the bank feed at all. **Assumption, flagged for the orchestrator**: CA
 * builds only the AR-side suggestion (D-108), so `payments_received.read` is
 * correct for every `targetType` this route can currently resolve
 * (`suggestDiscount` answers `null` for a `bill` today); the Pay-Bills-side call
 * site landing with PB will need its own gate (`payments_made.read`) alongside
 * this one, not instead of it.
 */

const TAG = 'payment-terms';

const paymentTermParamsSchema = z.strictObject({ paymentTermId: z.uuid() });

/** Local and carrying no `id`: a querystring is emitted as individual `parameters`. */
const listPaymentTermsWireQuerySchema = z.strictObject({
  includeInactive: z.stringbool().optional().meta({
    description:
      'Every term, active and archived. Defaults to active-only (`false`) — an archived term ' +
      'stays on every document that used it and is never offered for a new one, so the ordinary ' +
      'caller, a document’s term picker, never wants it.',
  }),
});

/**
 * The two document kinds a discount suggestion can be asked about (D-108). Only
 * `invoice` resolves today — `bill` is accepted for the shared AP+AR shape
 * `suggestDiscount` already takes, and answers `null` until the Pay-Bills-side
 * suggestion lands.
 */
const discountSuggestionTargetTypeSchema = z.enum(['invoice', 'bill']);

/** Local and carrying no `id`, for `listPaymentTermsWireQuerySchema`'s own reason. */
const discountSuggestionWireQuerySchema = z.strictObject({
  targetType: discountSuggestionTargetTypeSchema.meta({
    description: 'Which kind of document `targetId` names.',
  }),
  targetId: z.uuid().meta({
    description: 'The invoice or bill a human is about to settle.',
  }),
  asOfDate: calendarDateSchema.meta({
    description:
      'The date to evaluate the discount window against — “if this were paid today”. The ' +
      'bank-match workbench and money-in both send the date the money is applied, not today’s ' +
      'date, so a receipt entered a day late still sees the discount live when it landed.',
  }),
});

export function registerPaymentTermsRoutes(app: App): void {
  app.post(
    '/v1/payment-terms',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'createPaymentTerm',
        summary: 'Create a payment term',
        description:
          'A net-days figure and, optionally, a paired early-pay discount (`discountRatePpm`/' +
          '`discountWindowDays` — both or neither). Created active.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        body: createPaymentTermRequestSchema,
        response: { 201: paymentTermSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const result = await withIdempotency(
        { endpoint: 'createPaymentTerm', request: request.body, successStatus: 201 },
        () => createPaymentTerm(request.body, ctx),
      );

      const term = idempotentBody<PaymentTerm>(result);
      return reply
        .status(result.status)
        .header('location', `/v1/payment-terms/${term.id}`)
        .send(term);
    },
  );

  app.get(
    '/v1/payment-terms',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listPaymentTerms',
        summary: 'List the org’s payment terms',
        description:
          'Every term the org has defined, active ones first by name — a picker list, not ' +
          'paged (the catalog is small and bounded, unlike the documents that reference it).',
        tags: [TAG],
        querystring: listPaymentTermsWireQuerySchema,
        response: { 200: paymentTermListSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<PaymentTermList> => ({
      paymentTerms: wireList(
        await listPaymentTerms(request.query.includeInactive ?? false, getContext()),
      ),
    }),
  );

  app.get(
    '/v1/payment-terms/:paymentTermId',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getPaymentTerm',
        summary: 'One payment term',
        tags: [TAG],
        params: paymentTermParamsSchema,
        response: { 200: paymentTermSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<PaymentTerm> =>
      getPaymentTerm(request.params.paymentTermId, getContext()),
  );

  app.patch(
    '/v1/payment-terms/:paymentTermId',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'updatePaymentTerm',
        summary: 'Update a payment term',
        description:
          'An absent field is unchanged. There is no way to clear an existing discount back to a ' +
          'simple term here — a term a document has already used must not have its arithmetic ' +
          'change retroactively; deactivate it and create a replacement instead.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: paymentTermParamsSchema,
        body: updatePaymentTermRequestSchema,
        response: { 200: paymentTermSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { paymentTermId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'updatePaymentTerm',
          request: { paymentTermId, patch: request.body },
          successStatus: 200,
        },
        () => updatePaymentTerm(paymentTermId, request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<PaymentTerm>(result));
    },
  );

  app.post(
    '/v1/payment-terms/:paymentTermId/deactivate',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'deactivatePaymentTerm',
        summary: 'Archive a payment term',
        description:
          'The term stays on every document that already used it and is never offered again. Not ' +
          'a delete — `fk_ar_documents_payment_term`/`fk_ap_documents_payment_term`/' +
          '`fk_contacts_default_payment_term` are all `ON DELETE RESTRICT`, so a term any ' +
          'document or contact still names could not be removed regardless. Idempotent: an ' +
          'already-inactive term is returned unchanged rather than refused.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: paymentTermParamsSchema,
        response: { 200: paymentTermSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { paymentTermId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'deactivatePaymentTerm', request: { paymentTermId }, successStatus: 200 },
        () => deactivatePaymentTerm(paymentTermId, ctx),
      );

      return reply.status(result.status).send(idempotentBody<PaymentTerm>(result));
    },
  );

  app.get(
    '/v1/payment-terms/discount-suggestion',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'suggestDiscount',
        summary: 'Preview the early-pay discount available on a document',
        description:
          'Computed from the document’s resolved term against `asOfDate` — never written by ' +
          'this read and never auto-posted (D-43); a human confirms it as a `discount` clearing ' +
          'entry (`clearBankStatementLine`) or a discount allocation on a manual receipt. `204` ' +
          '(not an error) when the document carries no term, a simple term, or a rich term whose ' +
          'window has already passed relative to `asOfDate`.',
        tags: [TAG],
        querystring: discountSuggestionWireQuerySchema,
        response: { 200: discountSuggestionSchema, 204: noContentSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const { targetType, targetId, asOfDate } = request.query;
      const suggestion: DiscountSuggestion | null = await suggestDiscount(getContext(), {
        targetType,
        targetId,
        asOfDate,
      });

      if (suggestion === null) {
        return reply.status(204).send(null);
      }
      return reply.status(200).send(suggestion);
    },
  );
}
