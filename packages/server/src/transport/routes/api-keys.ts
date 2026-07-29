import {
  apiKeyPageSchema,
  apiKeySchema,
  apiKeyWithSecretSchema,
  createApiKeyRequestSchema,
  pageCursorSchema,
} from '@openbooks/shared-types';
import type { ApiKey, ApiKeyPage, ApiKeyWithSecret } from '@openbooks/shared-types';
import { z } from 'zod';

import { getContext } from '../../context';
import { createApiKey, listApiKeys, revokeApiKey } from '../../modules/api-keys';
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
 * `/v1/api-keys` — first-party, role-bound server-to-server credentials (OB-099,
 * OB-104; ROADMAP D-55, D-61).
 *
 * Handlers map arguments and hold no logic (spec §2.4): `api-keys.service.ts` is
 * everything — the mint, the hash, the role-in-this-org check, and the
 * `security_events` row. There is no `GET /v1/api-keys/{apiKeyId}`: a key is
 * managed from the list, the same shape `dunning.ts` gives a policy, and nothing
 * about one key needs its own page beyond what `listApiKeys` already returns.
 */

const TAG = 'api-keys';

const apiKeyParamsSchema = z.strictObject({ apiKeyId: z.uuid() });

/** Local and carrying no `id`: a querystring is emitted as individual `parameters`. */
const listApiKeysWireQuerySchema = z.strictObject({
  limit: pageLimitQuery('API keys'),
  cursor: pageCursorSchema.optional(),
});

export function registerApiKeyRoutes(app: App): void {
  app.post(
    '/v1/api-keys',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'createApiKey',
        summary: 'Issue an API key',
        description:
          'Issues a key bound to `roleId` — not the issuer’s own role (D-55). The full opaque ' +
          'value is returned exactly once, in this response; every later read shows only ' +
          '`keyPrefix`.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        body: createApiKeyRequestSchema,
        response: { 201: apiKeyWithSecretSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const result = await withIdempotency(
        { endpoint: 'createApiKey', request: request.body, successStatus: 201 },
        () => createApiKey(request.body, ctx),
      );

      const key = idempotentBody<ApiKeyWithSecret>(result);
      return reply.status(result.status).header('location', `/v1/api-keys/${key.id}`).send(key);
    },
  );

  app.get(
    '/v1/api-keys',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listApiKeys',
        summary: 'List API keys',
        description:
          'One page of the org’s keys, revoked ones included — a management view, not a live ' +
          'credential list.',
        tags: [TAG],
        querystring: listApiKeysWireQuerySchema,
        response: { 200: apiKeyPageSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<ApiKeyPage> => {
      const { limit, cursor } = request.query;
      return listApiKeys({ limit, ...(cursor === undefined ? {} : { cursor }) }, getContext());
    },
  );

  app.post(
    '/v1/api-keys/:apiKeyId/revoke',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'revokeApiKey',
        summary: 'Revoke an API key',
        description:
          'Effective on the next request (D-61) — there is no blocklist to propagate, because ' +
          'the key is an opaque lookup, not a self-validating token. Idempotent: an ' +
          'already-revoked key is returned unchanged rather than refused.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: apiKeyParamsSchema,
        response: { 200: apiKeySchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { apiKeyId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'revokeApiKey', request: { apiKeyId }, successStatus: 200 },
        () => revokeApiKey(apiKeyId, ctx),
      );

      return reply.status(result.status).send(idempotentBody<ApiKey>(result));
    },
  );
}
