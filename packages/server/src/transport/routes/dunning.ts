import {
  createDunningPolicyRequestSchema,
  dunningPolicyPageSchema,
  dunningPolicySchema,
  pageCursorSchema,
  updateDunningPolicyRequestSchema,
} from '@openbooks/shared-types';
import type { DunningPolicy, DunningPolicyPage } from '@openbooks/shared-types';
import { z } from 'zod';

import { getContext } from '../../context';
import { withIdempotency } from '../../modules/idempotency';
import {
  createDunningPolicy,
  deactivateDunningPolicy,
  getDunningPolicy,
  listDunningPolicies,
  updateDunningPolicy,
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
 * `/v1/dunning-policies` — the ordered ladder of reminders the sweep
 * (`modules/invoicing/dunning/engine.ts`) applies to overdue invoices (OB-129,
 * Phase 4).
 *
 * There is no `DELETE`. A policy that has already sent carries `dunning_sends`
 * rows that `fk_dunning_sends_stage` and `fk_dunning_sends_policy` (by way of
 * `dunning_stages`) `RESTRICT` — a policy that has run cannot be deleted out
 * from under its own history — and a policy that has never run has nothing a
 * deletion would save over `POST …/deactivate`. This is `deactivateAccount`'s
 * argument (`accounts.ts`'s header) applied to a second table: retiring is a
 * two-way door, deleting a row with history is not one this API opens.
 *
 * `PATCH` replaces `stages` wholesale when present, matching `updateInvoice`'s
 * `lines` for the reason `dunning.ts`'s `updateDunningPolicyRequestSchema`
 * states: a ladder edited one rung at a time can end up with two stages
 * claiming the same number with no single request responsible for it.
 */

const DUNNING_TAG = 'dunning';

const dunningPolicyParamsSchema = z.strictObject({ policyId: z.uuid() });

/**
 * Local and carrying no `id`, for `listInvoicesWireQuerySchema`'s reason: a
 * querystring is emitted as individual `parameters`, so a component for it
 * would be referenced by nothing.
 */
const listDunningPoliciesWireQuerySchema = z.strictObject({
  limit: pageLimitQuery('dunning policies'),
  cursor: pageCursorSchema.optional(),
});

export function registerDunningRoutes(app: App): void {
  app.post(
    '/v1/dunning-policies',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'createDunningPolicy',
        summary: 'Create a dunning policy',
        description:
          'Creates a policy with its full ladder of stages, active by default. Takes ' +
          '`invoices.send`: a policy governs sending, the same reason `POST …/send` on an ' +
          'invoice does.',
        tags: [DUNNING_TAG],
        headers: idempotencyKeyHeaderSchema,
        body: createDunningPolicyRequestSchema,
        response: { 201: dunningPolicySchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const result = await withIdempotency(
        { endpoint: 'createDunningPolicy', request: request.body, successStatus: 201 },
        () => createDunningPolicy(request.body, ctx),
      );

      const policy = idempotentBody<DunningPolicy>(result);
      return reply
        .status(result.status)
        .header('location', `/v1/dunning-policies/${policy.id}`)
        .send(policy);
    },
  );

  app.get(
    '/v1/dunning-policies',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listDunningPolicies',
        summary: 'List dunning policies',
        description: 'One page of policies with their stages, ordered by `(created_at, id)`.',
        tags: [DUNNING_TAG],
        querystring: listDunningPoliciesWireQuerySchema,
        response: { 200: dunningPolicyPageSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<DunningPolicyPage> => {
      const { limit, cursor } = request.query;
      return listDunningPolicies(
        { limit, ...(cursor === undefined ? {} : { cursor }) },
        getContext(),
      );
    },
  );

  app.get(
    '/v1/dunning-policies/:policyId',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getDunningPolicy',
        summary: 'One dunning policy, with its stages',
        tags: [DUNNING_TAG],
        params: dunningPolicyParamsSchema,
        response: { 200: dunningPolicySchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<DunningPolicy> =>
      getDunningPolicy(request.params.policyId, getContext()),
  );

  app.patch(
    '/v1/dunning-policies/:policyId',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'updateDunningPolicy',
        summary: 'Update a dunning policy',
        description:
          'An absent field is left unchanged. `stages`, when present, replaces the whole ladder.',
        tags: [DUNNING_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: dunningPolicyParamsSchema,
        body: updateDunningPolicyRequestSchema,
        response: { 200: dunningPolicySchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { policyId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'updateDunningPolicy',
          request: { policyId, patch: request.body },
          successStatus: 200,
        },
        () => updateDunningPolicy(policyId, request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<DunningPolicy>(result));
    },
  );

  app.post(
    '/v1/dunning-policies/:policyId/deactivate',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'deactivateDunningPolicy',
        summary: 'Deactivate a dunning policy',
        description:
          'Removes a policy from the sweep without deleting its history. Idempotent: an ' +
          'already-inactive policy is returned unchanged rather than refused.',
        tags: [DUNNING_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: dunningPolicyParamsSchema,
        response: { 200: dunningPolicySchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { policyId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'deactivateDunningPolicy', request: { policyId }, successStatus: 200 },
        () => deactivateDunningPolicy(policyId, ctx),
      );

      return reply.status(result.status).send(idempotentBody<DunningPolicy>(result));
    },
  );
}
