import {
  createRecurringInvoiceTemplateRequestSchema,
  pageCursorSchema,
  recurringInvoiceTemplatePageSchema,
  recurringInvoiceTemplateSchema,
  updateRecurringInvoiceTemplateRequestSchema,
} from '@openbooks/shared-types';
import type {
  RecurringInvoiceTemplate,
  RecurringInvoiceTemplatePage,
} from '@openbooks/shared-types';
import { z } from 'zod';

import { getContext } from '../../context';
import { withIdempotency } from '../../modules/idempotency';
import {
  createRecurringInvoiceTemplate,
  deactivateRecurringInvoiceTemplate,
  getRecurringInvoiceTemplate,
  listRecurringInvoiceTemplates,
  updateRecurringInvoiceTemplate,
} from '../../modules/invoicing';
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
 * `/v1/recurring-invoices` — recurring invoice templates (OB-128, transport for
 * `modules/invoicing`).
 *
 * Handlers map arguments and hold no logic (spec §2.4): every refusal, every
 * permission check and the whole materialisation engine live in the service and
 * in `engine.ts`, which the daily tick reaches directly and never through HTTP.
 * This file is only the five requests a person or an integrator makes about a
 * template — create it, read it, list it, edit it, retire it.
 *
 * ## Deactivate is its own route, `deactivateAccount`'s reason
 *
 * `isActive` is reachable through `PATCH`, unlike an account's, because a
 * template's deactivation is not the ledger-adjacent event an account's is — nothing
 * about it has ever posted. It is still given its own `POST …/deactivate` for
 * symmetry with the rest of this surface (`deactivateAccount`, `closeFiscalPeriod`)
 * and because idempotency matters here for the same reason it matters there: a
 * retried deactivate must return the template unchanged rather than fail on the
 * state it was trying to reach.
 */

const TAG = 'recurring-invoices';

const recurringInvoiceTemplateParamsSchema = z.strictObject({ templateId: z.uuid() });

/**
 * Local and carrying no `id`, `listInvoicesWireQuerySchema`'s reason: a
 * querystring is emitted as individual `parameters`, so a component for one would
 * be referenced by nothing.
 */
const listRecurringInvoiceTemplatesWireQuerySchema = z.strictObject({
  isActive: z.stringbool().optional().meta({
    description: 'Only active templates when `true`, only retired ones when `false`.',
  }),
  limit: pageLimitQuery('recurring invoice templates'),
  cursor: pageCursorSchema.optional(),
});

export function registerRecurringInvoiceRoutes(app: App): void {
  app.post(
    '/v1/recurring-invoices',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'createRecurringInvoiceTemplate',
        summary: 'Create a recurring invoice template',
        description:
          'A customer, a schedule, and how to raise the invoice each cycle (D-75, D-76). ' +
          '`startDate` seeds `nextRunDate` and is not stored as its own field — the response ' +
          'carries `nextRunDate`/`lastRunDate` instead, the schedule state the engine advances.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        body: createRecurringInvoiceTemplateRequestSchema,
        response: { 201: recurringInvoiceTemplateSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const result = await withIdempotency(
        { endpoint: 'createRecurringInvoiceTemplate', request: request.body, successStatus: 201 },
        () => createRecurringInvoiceTemplate(request.body, ctx),
      );

      const template = idempotentBody<RecurringInvoiceTemplate>(result);
      return reply
        .status(result.status)
        .header('location', `/v1/recurring-invoices/${template.id}`)
        .send(template);
    },
  );

  app.get(
    '/v1/recurring-invoices',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listRecurringInvoiceTemplates',
        summary: 'List recurring invoice templates',
        description: 'One page of templates, ordered by `(created_at, id)`, oldest first.',
        tags: [TAG],
        querystring: listRecurringInvoiceTemplatesWireQuerySchema,
        response: { 200: recurringInvoiceTemplatePageSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<RecurringInvoiceTemplatePage> => {
      const { isActive, limit, cursor } = request.query;
      return listRecurringInvoiceTemplates(
        {
          limit,
          ...(cursor === undefined ? {} : { cursor }),
          ...(isActive === undefined ? {} : { isActive }),
        },
        getContext(),
      );
    },
  );

  app.get(
    '/v1/recurring-invoices/:templateId',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getRecurringInvoiceTemplate',
        summary: 'One recurring invoice template, with its lines',
        tags: [TAG],
        params: recurringInvoiceTemplateParamsSchema,
        response: { 200: recurringInvoiceTemplateSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<RecurringInvoiceTemplate> =>
      getRecurringInvoiceTemplate(request.params.templateId, getContext()),
  );

  app.patch(
    '/v1/recurring-invoices/:templateId',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'updateRecurringInvoiceTemplate',
        summary: 'Update a recurring invoice template',
        description:
          'An absent field is unchanged, `null` clears a nullable one, and `lines` replaces the ' +
          'whole set. Changing the schedule reaches only the *next* cycle — a cycle already ' +
          'materialised is an ordinary invoice from here on and this endpoint cannot reach it.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: recurringInvoiceTemplateParamsSchema,
        body: updateRecurringInvoiceTemplateRequestSchema,
        response: { 200: recurringInvoiceTemplateSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { templateId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'updateRecurringInvoiceTemplate',
          request: { templateId, patch: request.body },
          successStatus: 200,
        },
        () => updateRecurringInvoiceTemplate(templateId, request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<RecurringInvoiceTemplate>(result));
    },
  );

  app.post(
    '/v1/recurring-invoices/:templateId/deactivate',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'deactivateRecurringInvoiceTemplate',
        summary: 'Retire a recurring invoice template',
        description:
          'The engine stops raising invoices from this template. Idempotent: an already-inactive ' +
          'template is returned unchanged rather than refused. Nothing already materialised is ' +
          'affected — this reaches only future cycles.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: recurringInvoiceTemplateParamsSchema,
        response: { 200: recurringInvoiceTemplateSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { templateId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'deactivateRecurringInvoiceTemplate',
          request: { templateId },
          successStatus: 200,
        },
        () => deactivateRecurringInvoiceTemplate(templateId, ctx),
      );

      return reply.status(result.status).send(idempotentBody<RecurringInvoiceTemplate>(result));
    },
  );
}
