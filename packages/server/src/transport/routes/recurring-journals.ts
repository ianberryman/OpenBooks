import {
  createRecurringJournalTemplateRequestSchema,
  pageCursorSchema,
  recurringJournalTemplatePageSchema,
  recurringJournalTemplateSchema,
  updateRecurringJournalTemplateRequestSchema,
} from '@openbooks/shared-types';
import type {
  RecurringJournalTemplate,
  RecurringJournalTemplatePage,
} from '@openbooks/shared-types';
import { z } from 'zod';

import { getContext } from '../../context';
import { withIdempotency } from '../../modules/idempotency';
import {
  createRecurringJournalTemplate,
  deactivateRecurringJournalTemplate,
  getRecurringJournalTemplate,
  listRecurringJournalTemplates,
  updateRecurringJournalTemplate,
} from '../../modules/recurring-journals';
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
 * `/v1/recurring-journals` — recurring GL journal templates (OB-167, transport for
 * `modules/recurring-journals`).
 *
 * `recurring-invoices.ts` is this file's sibling and the pattern it mirrors down to the
 * shape of every route: create/list/get/update carry the usual five, and deactivate is
 * its own `POST …/deactivate` rather than reachable through `PATCH { isActive: false }`,
 * for the same symmetry-with-the-rest-of-the-surface reason given there. Handlers map
 * arguments and hold no logic (spec §2.4): every refusal, the balanced-lines rule, and
 * the whole materialisation engine live in the service and in `engine.ts`, which the
 * daily tick reaches directly and never through HTTP.
 *
 * A GL template has no counterparty of its own — `contactId` lives on the line, not the
 * header (D-90's fixed-line scope) — so unlike a recurring invoice template there is
 * nothing here shaped like a customer lookup; the whole request is the schedule and the
 * lines.
 */

const TAG = 'recurring-journals';

const recurringJournalTemplateParamsSchema = z.strictObject({ templateId: z.uuid() });

/**
 * Local and carrying no `id`, `listRecurringInvoiceTemplatesWireQuerySchema`'s reason: a
 * querystring is emitted as individual `parameters`, so a component for one would be
 * referenced by nothing.
 */
const listRecurringJournalTemplatesWireQuerySchema = z.strictObject({
  isActive: z.stringbool().optional().meta({
    description: 'Only active templates when `true`, only retired ones when `false`.',
  }),
  limit: pageLimitQuery('recurring journal templates'),
  cursor: pageCursorSchema.optional(),
});

export function registerRecurringJournalRoutes(app: App): void {
  app.post(
    '/v1/recurring-journals',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'createRecurringJournalTemplate',
        summary: 'Create a recurring GL journal template',
        description:
          'A schedule and the balanced lines it posts, verbatim, each cycle (D-90). At least ' +
          'two lines and debits equal credits are checked at authoring time — the same rule the ' +
          'ledger kernel would otherwise refuse each cycle. `startDate` seeds `nextRunDate` and ' +
          'is not stored as its own field — the response carries `nextRunDate`/`lastRunDate` ' +
          'instead, the schedule state the engine advances.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        body: createRecurringJournalTemplateRequestSchema,
        response: { 201: recurringJournalTemplateSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const result = await withIdempotency(
        { endpoint: 'createRecurringJournalTemplate', request: request.body, successStatus: 201 },
        () => createRecurringJournalTemplate(request.body, ctx),
      );

      const template = idempotentBody<RecurringJournalTemplate>(result);
      return reply
        .status(result.status)
        .header('location', `/v1/recurring-journals/${template.id}`)
        .send(template);
    },
  );

  app.get(
    '/v1/recurring-journals',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listRecurringJournalTemplates',
        summary: 'List recurring GL journal templates',
        description: 'One page of templates, ordered by `(created_at, id)`, oldest first.',
        tags: [TAG],
        querystring: listRecurringJournalTemplatesWireQuerySchema,
        response: { 200: recurringJournalTemplatePageSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<RecurringJournalTemplatePage> => {
      const { isActive, limit, cursor } = request.query;
      return listRecurringJournalTemplates(
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
    '/v1/recurring-journals/:templateId',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getRecurringJournalTemplate',
        summary: 'One recurring GL journal template, with its lines',
        tags: [TAG],
        params: recurringJournalTemplateParamsSchema,
        response: { 200: recurringJournalTemplateSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<RecurringJournalTemplate> =>
      getRecurringJournalTemplate(request.params.templateId, getContext()),
  );

  app.patch(
    '/v1/recurring-journals/:templateId',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'updateRecurringJournalTemplate',
        summary: 'Update a recurring GL journal template',
        description:
          'An absent field is unchanged, and `lines` — when present — replaces the whole set and ' +
          'must itself balance. Changing the schedule reaches only the *next* cycle — a cycle ' +
          'already materialised is an ordinary journal from here on and this endpoint cannot ' +
          'reach it.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: recurringJournalTemplateParamsSchema,
        body: updateRecurringJournalTemplateRequestSchema,
        response: { 200: recurringJournalTemplateSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { templateId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'updateRecurringJournalTemplate',
          request: { templateId, patch: request.body },
          successStatus: 200,
        },
        () => updateRecurringJournalTemplate(templateId, request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<RecurringJournalTemplate>(result));
    },
  );

  app.post(
    '/v1/recurring-journals/:templateId/deactivate',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'deactivateRecurringJournalTemplate',
        summary: 'Retire a recurring GL journal template',
        description:
          'The engine stops materialising journals from this template. Idempotent: an ' +
          'already-inactive template is returned unchanged rather than refused. Nothing already ' +
          'materialised is affected — this reaches only future cycles.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: recurringJournalTemplateParamsSchema,
        response: { 200: recurringJournalTemplateSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { templateId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'deactivateRecurringJournalTemplate',
          request: { templateId },
          successStatus: 200,
        },
        () => deactivateRecurringJournalTemplate(templateId, ctx),
      );

      return reply.status(result.status).send(idempotentBody<RecurringJournalTemplate>(result));
    },
  );
}
