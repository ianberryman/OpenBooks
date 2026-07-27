import {
  bankRulePageSchema,
  bankRuleSchema,
  createBankRuleRequestSchema,
  pageCursorSchema,
  updateBankRuleRequestSchema,
} from '@openbooks/shared-types';
import type { BankRule, BankRulePage } from '@openbooks/shared-types';
import { z } from 'zod';

import { getContext } from '../../context';
import { createBankRule, getBankRule, listBankRules, updateBankRule } from '../../modules/banking';
import { withIdempotency } from '../../modules/idempotency';
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
 * `/v1/bank-rules` — the classification a matched line gets coded by (OB-084, for
 * OB-086; ROADMAP D-44; acceptance E8).
 *
 * A rule is a lookup, not an engine: same input, same proposal, every time. It proposes
 * and never posts (D-43) — a matched rule produces a `bankMatchProposal` like any other
 * candidate, ranked accordingly, and accepting it is `POST …/clearing`. Editing a rule
 * never restates a posted entry (E8): rules act on proposals, which are evaluated when a
 * line is looked at, so there is no “re-run rules over existing lines” shape and nothing
 * here reaches backwards.
 *
 * Writes take `banking.match` — a rule is a matching decision — and reads `banking.read`,
 * which the service enforces and this file documents (spec §5). Deactivating is an
 * ordinary `PATCH { isActive: false }`: it stops future proposals and cascades to
 * nothing, which is E8 restated.
 */

const TAG = 'bank-rules';

const ruleParamsSchema = z.strictObject({ ruleId: z.uuid() });

/** Local and carrying no `id`: a querystring is emitted as individual `parameters`. */
const listBankRulesWireQuerySchema = z.strictObject({
  isActive: z
    .stringbool()
    .optional()
    .meta({
      description:
        'Accepts `true`/`false` (and `1`/`0`, `yes`/`no`, `on`/`off`). Omitted lists active and ' +
        'inactive rules alike.',
    }),
  bankAccountId: z.uuid().optional(),
  limit: pageLimitQuery('rules'),
  cursor: pageCursorSchema.optional(),
});

export function registerBankRuleRoutes(app: App): void {
  app.post(
    '/v1/bank-rules',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'createBankRule',
        summary: 'Create a bank rule',
        description:
          'A condition (match on description, amount, direction) and an outcome (an account, ' +
          'optionally a contact and tags). `priority` defaults to the end of the list, so a new ' +
          'rule cannot silently pre-empt an old one. An empty condition is refused — it would ' +
          'match every line (D-44).',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        body: createBankRuleRequestSchema,
        response: { 201: bankRuleSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const result = await withIdempotency(
        { endpoint: 'createBankRule', request: request.body, successStatus: 201 },
        () => createBankRule(request.body, ctx),
      );

      const rule = idempotentBody<BankRule>(result);
      return reply.status(result.status).header('location', `/v1/bank-rules/${rule.id}`).send(rule);
    },
  );

  app.get(
    '/v1/bank-rules',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listBankRules',
        summary: 'List bank rules',
        description:
          'One page, in evaluation order — `(priority, created_at, id)`, the only order a rules ' +
          'list is read in. A malformed `bankAccountId` filters to an empty page rather than 404ing ' +
          '(E9).',
        tags: [TAG],
        querystring: listBankRulesWireQuerySchema,
        response: { 200: bankRulePageSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<BankRulePage> => {
      const { isActive, bankAccountId, limit, cursor } = request.query;
      return listBankRules(
        {
          limit,
          ...(cursor === undefined ? {} : { cursor }),
          ...(isActive === undefined ? {} : { isActive }),
          ...(bankAccountId === undefined ? {} : { bankAccountId }),
        },
        getContext(),
      );
    },
  );

  app.get(
    '/v1/bank-rules/:ruleId',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getBankRule',
        summary: 'One bank rule',
        tags: [TAG],
        params: ruleParamsSchema,
        response: { 200: bankRuleSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<BankRule> => getBankRule(request.params.ruleId, getContext()),
  );

  app.patch(
    '/v1/bank-rules/:ruleId',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'updateBankRule',
        summary: 'Update a bank rule',
        description:
          '`condition` and `outcome` are each replaced whole, never patched, so a field-at-a-time ' +
          'patch cannot reach an empty condition. `isActive: false` deactivates — it stops future ' +
          'proposals and touches no posted entry (E8).',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: ruleParamsSchema,
        body: updateBankRuleRequestSchema,
        response: { 200: bankRuleSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { ruleId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'updateBankRule',
          request: { ruleId, patch: request.body },
          successStatus: 200,
        },
        () => updateBankRule(ruleId, request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<BankRule>(result));
    },
  );
}
