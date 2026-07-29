import {
  connectedAppPageSchema,
  oauthAuthorizationDetailsSchema,
  oauthAuthorizeQuerySchema,
  oauthClientPageSchema,
  oauthClientSchema,
  oauthClientWithSecretSchema,
  pageCursorSchema,
  registerOAuthClientRequestSchema,
} from '@openbooks/shared-types';
import type {
  ConnectedAppPage,
  OAuthAuthorizationDetails,
  OAuthClient,
  OAuthClientPage,
  OAuthClientWithSecret,
} from '@openbooks/shared-types';
import { z } from 'zod';

import { getContext } from '../../context';
import { withIdempotency } from '../../modules/idempotency';
import {
  authorizeRequest,
  deactivateOAuthClient,
  listConnectedApps,
  listOAuthClients,
  registerOAuthClient,
  revokeConnectedApp,
} from '../../modules/oauth';
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
 * `/v1/oauth-clients` and `/v1/connected-apps` — the OAuth 2.1 authorization
 * server's admin-facing management routes (OB-098, OB-104; ROADMAP D-53, D-54,
 * D-61). The RFC 6749/7009 flow itself — `authorize`, the consent POST, `token`,
 * `revoke` — is wired outside `/v1` in `oauth-flow.ts`; this file is only this
 * project's own JSON shapes, exactly the split `oauth.service.ts`'s header draws.
 *
 * ## Two resource ids on this one file, and neither is optional
 *
 * `deactivateOAuthClient` takes the client's REST resource id (`oauthClientId`, a
 * UUID an admin addresses through `/v1/oauth-clients`), while `revokeConnectedApp`
 * takes the public `client_id` OAuth string (`clientId` in the path) — a user's
 * "connected apps" list never carries the row id at all. `oauth.service.ts`'s own
 * commentary on `deactivateOAuthClient` calls this out as the asymmetry OB-098
 * flagged; the two path parameter names below say which is which.
 */

const TAG = 'oauth-clients';
const CONNECTED_APPS_TAG = 'connected-apps';

const oauthClientParamsSchema = z.strictObject({ oauthClientId: z.uuid() });
const connectedAppParamsSchema = z.strictObject({ clientId: z.string().min(1) });

/** Local and carrying no `id`: a querystring is emitted as individual `parameters`. */
const listOAuthClientsWireQuerySchema = z.strictObject({
  limit: pageLimitQuery('OAuth clients'),
  cursor: pageCursorSchema.optional(),
});

const listConnectedAppsWireQuerySchema = z.strictObject({
  limit: pageLimitQuery('connected apps'),
  cursor: pageCursorSchema.optional(),
});

export function registerOAuthClientRoutes(app: App): void {
  app.post(
    '/v1/oauth-clients',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'registerOAuthClient',
        summary: 'Register an OAuth client',
        description:
          'Admin-registered and never self-service (D-53) — there is no public dynamic ' +
          'client registration. The secret is returned exactly once, in this response.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        body: registerOAuthClientRequestSchema,
        response: { 201: oauthClientWithSecretSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const result = await withIdempotency(
        { endpoint: 'registerOAuthClient', request: request.body, successStatus: 201 },
        () => registerOAuthClient(request.body, ctx),
      );

      const client = idempotentBody<OAuthClientWithSecret>(result);
      return reply
        .status(result.status)
        .header('location', `/v1/oauth-clients/${client.id}`)
        .send(client);
    },
  );

  app.get(
    '/v1/oauth-clients',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listOAuthClients',
        summary: 'List OAuth clients',
        tags: [TAG],
        querystring: listOAuthClientsWireQuerySchema,
        response: { 200: oauthClientPageSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<OAuthClientPage> => {
      const { limit, cursor } = request.query;
      return listOAuthClients({ limit, ...(cursor === undefined ? {} : { cursor }) }, getContext());
    },
  );

  app.post(
    '/v1/oauth-clients/:oauthClientId/deactivate',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'deactivateOAuthClient',
        summary: 'Deactivate an OAuth client',
        description:
          'A deactivated client cannot obtain a new token (D-61). Idempotent: an ' +
          'already-deactivated client is returned unchanged rather than refused.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: oauthClientParamsSchema,
        response: { 200: oauthClientSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { oauthClientId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'deactivateOAuthClient', request: { oauthClientId }, successStatus: 200 },
        () => deactivateOAuthClient(oauthClientId, ctx),
      );

      return reply.status(result.status).send(idempotentBody<OAuthClient>(result));
    },
  );

  app.get(
    '/v1/connected-apps',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listConnectedApps',
        summary: 'List the caller’s connected apps',
        description:
          'A user’s own view of what they have authorized — gated `integrations.read` ' +
          'advisorily; the real boundary is that this only ever touches the caller’s own ' +
          'consent and tokens (`oauth.service.ts`).',
        tags: [CONNECTED_APPS_TAG],
        querystring: listConnectedAppsWireQuerySchema,
        response: { 200: connectedAppPageSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<ConnectedAppPage> => {
      const { limit, cursor } = request.query;
      return listConnectedApps(
        { limit, ...(cursor === undefined ? {} : { cursor }) },
        getContext(),
      );
    },
  );

  app.post(
    '/v1/connected-apps/:clientId/revoke',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'revokeConnectedApp',
        summary: 'Revoke a connected app',
        description:
          'Revokes the caller’s own consent and every token it produced. A client never ' +
          'consented to, or already revoked, is a no-op rather than a `not_found` — reporting ' +
          'existence of someone else’s consent is exactly what A7 avoids.',
        tags: [CONNECTED_APPS_TAG],
        headers: idempotencyKeyHeaderSchema,
        params: connectedAppParamsSchema,
        response: { 204: noContentSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { clientId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'revokeConnectedApp', request: { clientId }, successStatus: 204 },
        async () => {
          await revokeConnectedApp(clientId, ctx);
          return null;
        },
      );

      return reply.status(result.status).send(idempotentBody<null>(result));
    },
  );

  // The consent screen's data source. Session-authenticated with no permission of its own —
  // a user deciding whether to delegate *their own* access is not an `integrations.*` admin
  // act — so it is gated like `GET /v1/auth/me`: the identity resolver is the only gate, and
  // `authorizeRequest` validates the client + redirect + PKCE the same way `GET /oauth/authorize`
  // does before it ever reaches here. Cross-org holds for free: `authorizeRequest` resolves the
  // client through the caller's own org, so a client in another org reads as nonexistent (A7).
  app.get(
    '/v1/oauth/authorization-details',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getOAuthAuthorizationDetails',
        summary: 'The client name and scopes the consent screen renders',
        description:
          'Backs the consent screen `GET /oauth/authorize` redirects a logged-in user to. ' +
          'Validates the authorize request and returns the client’s display name, the exact ' +
          'scopes requested, and whether the user already consented to a superset.',
        tags: [CONNECTED_APPS_TAG],
        querystring: oauthAuthorizeQuerySchema,
        response: { 200: oauthAuthorizationDetailsSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<OAuthAuthorizationDetails> => {
      const { client, scopes, alreadyConsented } = await authorizeRequest(
        request.query,
        getContext(),
      );
      return { clientName: client.name, scope: [...scopes], alreadyConsented };
    },
  );
}
