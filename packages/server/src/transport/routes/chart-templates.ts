import {
  appliedChartTemplateSchema,
  applyChartTemplateRequestSchema,
  chartTemplateListSchema,
} from '@openbooks/shared-types';
import type { AppliedChartTemplate, ChartTemplateList } from '@openbooks/shared-types';

import { getContext } from '../../context';
import { applyChartTemplate, listChartTemplates } from '../../modules/accounts';
import { withIdempotency } from '../../modules/idempotency';
import type { App } from '../types';
import {
  ERROR_RESPONSES,
  ORG_SCOPED_WRITE_HOOKS,
  idempotencyKeyHeaderSchema,
  idempotentBody,
  requireOrgScope,
  wireList,
} from './support';

/**
 * `/v1/chart-templates` — the opt-in starter charts (OB-039; ROADMAP D-23).
 *
 * Tagged `accounts`, because that is what a template makes. It is a path of its own
 * rather than `/v1/accounts/templates` for the reason D-23 gives about what a
 * template *is*: a constant in the source tree, identical for every org and owned
 * by the build rather than by a tenant. `GET /v1/chart-templates` returns the same
 * document to everybody and would be a strange thing to reach through a collection
 * whose every other entry is the caller's own data.
 *
 * ## Why applying is a `POST` to the template collection and not to `/v1/accounts`
 *
 * The operation creates accounts, so `POST /v1/accounts` with a `templateId` was
 * available. It is refused for the same reason `postJournal` and `postDraft` are
 * separate: one call carries an account and the other names a canned set of
 * sixty-five, and a single endpoint with two mutually exclusive bodies is one a
 * client can send both halves of.
 *
 * `.../apply` rather than `POST /v1/chart-templates/{templateId}` because the
 * template is not the resource being created — the accounts are — and a `POST` to a
 * template's own address reads as creating something *under* the template, which is
 * exactly the ongoing relationship D-23 declines to have.
 *
 * ## What a collision does, and why the route does not soften it
 *
 * Applying to an org that already holds one of the template's codes refuses the
 * whole application and names every colliding code. There is no `merge` or
 * `skipExisting` flag here, and adding one at the transport layer would be
 * inventing product policy in the one place that may hold none: overwriting rewrites
 * accounts that may already carry postings, and skipping produces a chart that is
 * neither the org's nor the template's while reporting success.
 */

const TAG = 'accounts';

export function registerChartTemplateRoutes(app: App): void {
  app.get(
    '/v1/chart-templates',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listChartTemplates',
        summary: 'List the starter charts of accounts',
        description:
          'Takes `accounts.read`. `accountCount` and not the accounts themselves: the number is ' +
          'what makes the choice, while the full list would invite a client to render a ' +
          'preview — and a preview is the first step towards treating a copied chart as ' +
          'something the org stays related to (D-23).',
        tags: [TAG],
        response: { 200: chartTemplateListSchema, ...ERROR_RESPONSES },
      },
    },
    async (): Promise<ChartTemplateList> => ({
      templates: wireList(await listChartTemplates(getContext())),
    }),
  );

  app.post(
    '/v1/chart-templates/apply',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'applyChartTemplate',
        summary: 'Copy a starter chart into this organization',
        description:
          'Takes `accounts.write`. The accounts are written through `createAccount` one at a ' +
          'time in one transaction, so the hierarchy rules, the code-uniqueness conflict and the ' +
          'shared schema apply to a shipped chart exactly as they apply to a hand-typed one — ' +
          'there is no second write path for a template to bypass. A code the org already holds ' +
          'refuses the whole application and names every collision. Nothing records which ' +
          'template was used: the accounts are ordinary accounts from that moment on.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        body: applyChartTemplateRequestSchema,
        response: { 201: appliedChartTemplateSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const result = await withIdempotency(
        { endpoint: 'applyChartTemplate', request: request.body, successStatus: 201 },
        () => applyChartTemplate(request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<AppliedChartTemplate>(result));
    },
  );
}
