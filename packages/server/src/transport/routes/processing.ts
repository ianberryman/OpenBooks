import { connectProcessorRequestSchema, processorConnectionSchema } from '@openbooks/shared-types';
import type { ProcessorConnection } from '@openbooks/shared-types';
import { z } from 'zod';

import { getContext } from '../../context';
import { withIdempotency } from '../../modules/idempotency';
import {
  connectProcessor,
  deactivateProcessorConnection,
  getProcessorConnection,
  listProcessorConnections,
  reactivateProcessorConnection,
} from '../../modules/payments-processing';
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
 * `/v1/processing/connections` — an org's own payment-processor connections
 * (OB-150, transport for `modules/payments-processing`; ROADMAP D-82, D-83,
 * D-103).
 *
 * Handlers map arguments and hold no logic (spec §2.4): `connections.service.ts`
 * is everything — the account-nomination checks, the secrets-provider writes,
 * the `processor_already_connected` precondition, and D-83's guarantee that
 * `secretKey`/`webhookSecret` never come back out. This file is only the five
 * requests an org's admin makes about a connection — connect it, read it, list
 * it, take it out of circulation, and put it back.
 *
 * ## `GET /v1/processing/connections` returns a bare array, not a page
 *
 * Every other list on this surface is `{ items, nextCursor }` (D-21). This one
 * is not, for `connections.repository.ts`'s own reason:
 * `uq_processor_connections_org_processor` bounds an org to at most one row per
 * `ProcessorKind` — three today — so a cursor would be paging machinery
 * answering a question this table cannot ask.
 *
 * ## Why deactivate and reactivate are their own routes
 *
 * The same shape `deactivateAccount`/`reactivateAccount` and
 * `deactivateRecurringInvoiceTemplate` give their own resources, for the same
 * reason: idempotency matters here (a retried deactivate must return the
 * connection unchanged rather than fail on the state it was trying to reach —
 * `deactivateProcessorConnection`'s own header says so), and a `PATCH { isActive
 * }` would be a second way to reach the identical transition with no
 * `Idempotency-Key` semantics of its own.
 *
 * ## Where the pay-link route lives
 *
 * `POST /public/invoices/{token}/pay-link` — the customer-facing half of this
 * initiative — is not on this surface at all. It carries no session and no
 * permission (the delivery token is the whole authorization, D-74's shape), so
 * it registers outside `/v1` entirely: see `transport/routes/public-pay-link.ts`.
 */

const TAG = 'processing';

const processorConnectionParamsSchema = z.strictObject({ connectionId: z.uuid() });

export function registerProcessingRoutes(app: App): void {
  app.post(
    '/v1/processing/connections',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'connectProcessor',
        summary: 'Connect a payment processor',
        description:
          'Wires a Stripe or Square account to two existing ledger accounts — a clearing ' +
          'account a charge settles into immediately, and a fee account the processor’s cut ' +
          'posts to (D-82, D-103). `secretKey` and `webhookSecret` are inbound-only: this ' +
          'response, and every later read of this connection, never carries either one back ' +
          'out (D-83). One connection per processor per org — connecting a second one for the ' +
          'same processor is `processor_already_connected`; reconnecting a deactivated one is ' +
          '`POST .../reactivate`, never a second call here.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        body: connectProcessorRequestSchema,
        response: { 201: processorConnectionSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const result = await withIdempotency(
        { endpoint: 'connectProcessor', request: request.body, successStatus: 201 },
        () => connectProcessor(request.body, ctx),
      );

      const connection = idempotentBody<ProcessorConnection>(result);
      return reply
        .status(result.status)
        .header('location', `/v1/processing/connections/${connection.id}`)
        .send(connection);
    },
  );

  app.get(
    '/v1/processing/connections',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listProcessorConnections',
        summary: 'List payment-processor connections',
        description:
          'Every connection the org holds, active and inactive, oldest first. Not a paged ' +
          'collection — see this file’s header for why.',
        tags: [TAG],
        response: { 200: z.array(processorConnectionSchema), ...ERROR_RESPONSES },
      },
    },
    async (): Promise<ProcessorConnection[]> =>
      wireList(await listProcessorConnections(getContext())),
  );

  app.get(
    '/v1/processing/connections/:connectionId',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getProcessorConnection',
        summary: 'One payment-processor connection',
        tags: [TAG],
        params: processorConnectionParamsSchema,
        response: { 200: processorConnectionSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<ProcessorConnection> =>
      getProcessorConnection(request.params.connectionId, getContext()),
  );

  app.post(
    '/v1/processing/connections/:connectionId/deactivate',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'deactivateProcessorConnection',
        summary: 'Take a payment-processor connection out of circulation',
        description:
          'The webhook and the D-85 poll stop writing new payments through this connection; ' +
          'every payment already recorded stays exactly as posted. Idempotent: an ' +
          'already-inactive connection is returned unchanged rather than refused.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: processorConnectionParamsSchema,
        response: { 200: processorConnectionSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { connectionId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'deactivateProcessorConnection',
          request: { connectionId },
          successStatus: 200,
        },
        () => deactivateProcessorConnection(connectionId, ctx),
      );

      return reply.status(result.status).send(idempotentBody<ProcessorConnection>(result));
    },
  );

  app.post(
    '/v1/processing/connections/:connectionId/reactivate',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'reactivateProcessorConnection',
        summary: 'Bring a payment-processor connection back into service',
        description:
          'The only way back in (D-103) — never a second `connectProcessor`, which ' +
          '`processor_already_connected` would refuse. Idempotent: an already-active connection ' +
          'is returned unchanged rather than refused.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: processorConnectionParamsSchema,
        response: { 200: processorConnectionSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { connectionId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'reactivateProcessorConnection',
          request: { connectionId },
          successStatus: 200,
        },
        () => reactivateProcessorConnection(connectionId, ctx),
      );

      return reply.status(result.status).send(idempotentBody<ProcessorConnection>(result));
    },
  );
}
