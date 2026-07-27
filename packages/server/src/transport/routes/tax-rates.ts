import {
  TAX_RATE_APPLICABILITIES,
  createTaxRateRequestSchema,
  pageCursorSchema,
  taxRatePageSchema,
  taxRateSchema,
  updateTaxRateRequestSchema,
} from '@openbooks/shared-types';
import type { TaxRatePage, TaxRateResponse } from '@openbooks/shared-types';
import { z } from 'zod';

import { getContext } from '../../context';
import { withIdempotency } from '../../modules/idempotency';
import {
  archiveTaxRate,
  createTaxRate,
  deleteTaxRate,
  getTaxRate,
  listTaxRates,
  unarchiveTaxRate,
  updateTaxRate,
} from '../../modules/tax';
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
 * `/v1/tax-rates` — the per-org rate list (OB-067, for OB-066; ROADMAP D-35).
 *
 * The same shape the chart of accounts has, and for the same reasons, so
 * `accounts.ts` carries most of the argument. Three things are specific to a rate.
 *
 * **There is no way to change a percentage, and the route surface says so by having
 * no path for it.** `updateTaxRateRequestSchema` has no `percentage`, so the
 * published `UpdateTaxRateRequest` has no such property and a client generated from
 * `openapi.json` cannot express the request. That is deliberate rather than an
 * omission: a document's tax was computed from the rate once and posted to an
 * immutable journal, so a rate that changed would restate documents the customer
 * already holds. Correcting a mistake is a new rate plus an archive; a jurisdiction
 * moving VAT from 17.5% to 20% is two rates, because both are true of different
 * dates.
 *
 * **Archive and unarchive are their own routes, not a flag on the patch**, for
 * `deactivateAccount`'s reason exactly — a state change every future document's rate
 * picker depends on should not be a side effect of renaming something — and
 * unarchive exists so archiving is not a one-way door.
 *
 * **`DELETE` and archive are for different situations and both are needed.** Delete
 * is for a rate that was never used, and what makes it safe is the database:
 * `fk_ar_document_lines_tax_rate` and `fk_ap_document_lines_tax_rate` are
 * `ON DELETE RESTRICT`, so a cited rate cannot be removed whatever the service
 * believes. It exists at all because `uq_tax_rates_org_name` covers archived rows —
 * without a delete, a setup typo would hold its name forever, and the create-only
 * percentage would make every mistyped rate permanent.
 *
 * The `appliesTo` filter is a *usability* predicate rather than an equality: asking
 * for `sales` returns the unrestricted (`both`) rates too, since a sales document
 * may cite one. That is the service's decision and the description states it,
 * because a client that assumed equality would build a picker missing half the list.
 */

const TAG = 'tax-rates';

const taxRateParamsSchema = z.strictObject({ taxRateId: z.uuid() });

/**
 * Local and carrying no `id`, and `isActive` coerced here rather than in the shared
 * schema for `listAccountsWireQuerySchema`'s reason: `'false'` is truthy in every
 * language an integrator might use, so a shared schema that accepted the string
 * would accept it from a JSON body too.
 */
const listTaxRatesWireQuerySchema = z.strictObject({
  isActive: z
    .stringbool()
    .optional()
    .meta({
      description:
        'Omitted matches active and archived rates alike. Accepts `true`/`false` (and `1`/`0`, ' +
        '`yes`/`no`, `on`/`off`).',
    }),
  appliesTo: z
    .enum(TAX_RATE_APPLICABILITIES)
    .optional()
    .meta({
      description:
        'Which documents the rate may be used on. A usability predicate rather than an equality: ' +
        '`sales` returns the unrestricted `both` rates as well, because a sales document may ' +
        'cite one.',
    }),
  limit: pageLimitQuery('tax rates'),
  cursor: pageCursorSchema.optional(),
});

export function registerTaxRateRoutes(app: App): void {
  app.post(
    '/v1/tax-rates',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'createTaxRate',
        summary: 'Create a tax rate',
        description:
          'Rates are created active. `accountId` must name an active **asset or liability** ' +
          'account: tax collected on a sale is owed to the authority and tax paid on a purchase ' +
          'is reclaimable from it, and both are balance-sheet positions. Revenue, expense and ' +
          'equity are refused with `tax_account_not_a_balance_sheet_account` — tax posted to ' +
          'profit overstates turnover by exactly the amount owed and nothing in the trial ' +
          'balance would show it. A percentage of `"0"` is accepted and means zero-rated, which ' +
          'is not the same as a line carrying no rate at all.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        body: createTaxRateRequestSchema,
        response: { 201: taxRateSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const result = await withIdempotency(
        { endpoint: 'createTaxRate', request: request.body, successStatus: 201 },
        () => createTaxRate(request.body, ctx),
      );

      const rate = idempotentBody<TaxRateResponse>(result);
      return reply.status(result.status).header('location', `/v1/tax-rates/${rate.id}`).send(rate);
    },
  );

  app.get(
    '/v1/tax-rates',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listTaxRates',
        summary: 'List tax rates',
        description:
          'One page, ordered by `(created_at, id)` and not by name: `name` is mutable, and a ' +
          'keyset over a mutable column silently drops the rows that moved behind the cursor. A ' +
          'rate has no immutable code to sort on the way the chart of accounts does (D-27).',
        tags: [TAG],
        querystring: listTaxRatesWireQuerySchema,
        response: { 200: taxRatePageSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<TaxRatePage> => {
      const { isActive, appliesTo, limit, cursor } = request.query;
      return listTaxRates(
        {
          limit,
          ...(cursor === undefined ? {} : { cursor }),
          ...(isActive === undefined ? {} : { isActive }),
          ...(appliesTo === undefined ? {} : { appliesTo }),
        },
        getContext(),
      );
    },
  );

  app.get(
    '/v1/tax-rates/:taxRateId',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getTaxRate',
        summary: 'One tax rate',
        tags: [TAG],
        params: taxRateParamsSchema,
        response: { 200: taxRateSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<TaxRateResponse> => getTaxRate(request.params.taxRateId, getContext()),
  );

  app.patch(
    '/v1/tax-rates/:taxRateId',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'updateTaxRate',
        summary: 'Update a tax rate',
        description:
          '`name`, `accountId` and `appliesTo` only. Neither of the latter two restates a posted ' +
          'journal — repointing a rate changes where future tax posts and leaves every past ' +
          'posting where it was — which is the test the immutable `percentage` fails.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: taxRateParamsSchema,
        body: updateTaxRateRequestSchema,
        response: { 200: taxRateSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { taxRateId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'updateTaxRate',
          request: { taxRateId, patch: request.body },
          successStatus: 200,
        },
        () => updateTaxRate(taxRateId, request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<TaxRateResponse>(result));
    },
  );

  /**
   * Registered from a table for `accounts.ts`'s reason: written out twice they would
   * be sixty lines whose only distinguishing features are a path segment and a
   * function reference, which is how the two drift when one is edited.
   */
  for (const route of [
    {
      path: '/v1/tax-rates/:taxRateId/archive',
      operationId: 'archiveTaxRate',
      summary: 'Archive a tax rate',
      description:
        'Takes the rate out of circulation without removing it from the documents that used it, ' +
        'which is the only form of removal available to a rate a posted document names. ' +
        'Idempotent: an already-archived rate is returned unchanged rather than refused.',
      run: archiveTaxRate,
    },
    {
      path: '/v1/tax-rates/:taxRateId/unarchive',
      operationId: 'unarchiveTaxRate',
      summary: 'Unarchive a tax rate',
      description: 'The counterpart, so that archiving is not a one-way door.',
      run: unarchiveTaxRate,
    },
  ] as const) {
    app.post(
      route.path,
      {
        onRequest: ORG_SCOPED_WRITE_HOOKS,
        schema: {
          operationId: route.operationId,
          summary: route.summary,
          description: route.description,
          tags: [TAG],
          headers: idempotencyKeyHeaderSchema,
          params: taxRateParamsSchema,
          response: { 200: taxRateSchema, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        const ctx = getContext();
        const { taxRateId } = request.params;
        const result = await withIdempotency(
          { endpoint: route.operationId, request: { taxRateId }, successStatus: 200 },
          () => route.run(taxRateId, ctx),
        );

        return reply.status(result.status).send(idempotentBody<TaxRateResponse>(result));
      },
    );
  }

  app.delete(
    '/v1/tax-rates/:taxRateId',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'deleteTaxRate',
        summary: 'Delete a tax rate no document has used',
        description:
          'A rate cited by any document line answers `precondition_failed` with ' +
          '`tax_rate_in_use`, naming whether it is a receivable or a payable that cites it; ' +
          'archive it instead. The guarantee is the database’s `ON DELETE RESTRICT` rather than ' +
          'the pre-check, so losing a race is the same refusal and not a 500.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: taxRateParamsSchema,
        response: { 204: noContentSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { taxRateId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'deleteTaxRate', request: { taxRateId }, successStatus: 204 },
        () => deleteTaxRate(taxRateId, ctx),
      );

      return reply.status(result.status).send(idempotentBody<null>(result));
    },
  );
}
