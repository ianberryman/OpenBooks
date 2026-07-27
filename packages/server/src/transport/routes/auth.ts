import {
  callerIdentityResponseSchema,
  identityResponseSchema,
  loginRequestSchema,
  registerRequestSchema,
} from '@openbooks/shared-types';
import type { CallerIdentityResponse, IdentityResponse } from '@openbooks/shared-types';

import type { Config } from '../../config';
import type { SessionCookie } from '../../modules/auth';
import {
  clearedSessionCookie,
  login,
  logout,
  me,
  readSessionToken,
  register,
  sessionCookie,
} from '../../modules/auth';
import { withGlobalIdempotency } from '../../modules/idempotency';
import { currentPermissions } from '../../modules/permissions';
import { requireIdempotencyKey } from '../idempotency';
import type { App } from '../types';
import {
  ERROR_RESPONSES,
  idempotencyKeyHeaderSchema,
  idempotentBody,
  noContentSchema,
  wireList,
} from './support';

/**
 * `/v1/auth` — register, login, logout, and `me` (spec §5).
 *
 * ## These are the routes that must work without credentials
 *
 * The identity resolver runs as an `onRequest` hook for *every* route, so it cannot
 * know which one it is on; refusing an unauthenticated request is a per-route
 * decision. `register` and `login` make no `requirePermission` call and read no
 * tenant data, so they run in the pre-auth scope and are reachable with no cookie —
 * which is not merely a convenience. `resolveSessionIdentity` returns `null` rather
 * than throwing for an *expired* session precisely so that a user whose session ran
 * out can still reach the endpoint that fixes it; a resolver or a route that refused
 * them would lock them out until they cleared cookies by hand.
 *
 * ## Why the session token is never in a response body
 *
 * `IssuedSession.sessionToken` is the only moment the token exists in the process,
 * and it leaves here as an `HttpOnly` cookie. Putting it in the body as well would
 * hand it to script, which is the single property `HttpOnly` provides, and would put
 * a live credential into every client's logs and error reporters. The cookie's name,
 * lifetime, and attributes are decided in `src/modules/auth/cookie.ts`; this file
 * hands what that module returns to `reply.setCookie` and adds no attributes of its
 * own.
 *
 * ## The writes here are guarded in the org-less namespace (OB-028)
 *
 * `withGlobalIdempotency` and not `withIdempotency`: these operations either predate
 * the org (register) or would record the claim against the org the caller is leaving
 * (see `../orgs.ts`), so the claim goes in the namespace `claim_scope` exists for —
 * migration `0003` argues the schema, `src/modules/idempotency/` the behaviour. Until
 * this ticket they accepted the header and ignored it, which is worse than not
 * accepting one: a double-submitted registration made two attempts at the same
 * account.
 *
 * ## A replay does not re-issue a session cookie
 *
 * The cookie is set from `IssuedSession.sessionToken`, which exists only while the
 * guarded operation runs and is deliberately never stored (D-03) — putting a live
 * credential in a `response_body` column for seven days is not a trade worth making
 * for a retry. So the cookie is captured in the closure below and set only when the
 * operation actually executed.
 *
 * That is right for the case the guard is for. A double-submitted form is two
 * requests from a browser that already holds the cookie the first one set, and the
 * second must not mint a second session. The case it does not serve is a client that
 * lost the original response entirely: it replays, gets the identity, and has no
 * session — and its way forward is to log in, which is a different logical request
 * and therefore a different key. Recorded here rather than in the module because it
 * is a property of *these* routes and not of idempotency.
 */

const TAG = 'auth';

export function registerAuthRoutes(app: App, config: Config): void {
  /**
   * 201, because this creates a user, an org, an Owner membership, and a session —
   * four rows that are one fact. No `Location`: the created principal has no
   * addressable route of its own, and `GET /v1/auth/me` is not "the created
   * resource", it is a projection of the caller.
   */
  app.post(
    '/v1/auth/register',
    {
      onRequest: requireIdempotencyKey,
      schema: {
        operationId: 'register',
        summary: 'Register a user and their first organization',
        description:
          'Creates a user, their first organization, an Owner membership, and a session, ' +
          'atomically. Sets an `HttpOnly` session cookie; the token is never in the body. ' +
          'Reachable without credentials.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        body: registerRequestSchema,
        response: { 201: identityResponseSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const { org } = request.body;
      let issuedCookie: SessionCookie | undefined;

      const result = await withGlobalIdempotency(
        { endpoint: 'register', request: request.body, successStatus: 201 },
        async () => {
          const issued = await register({
            email: request.body.email,
            password: request.body.password,
            displayName: request.body.displayName,
            org: {
              name: org.name,
              // Spread, not `fiscalYearStartMonth: org.fiscalYearStartMonth`:
              // exactOptionalPropertyTypes makes an explicit `undefined` a different
              // type from an absent key, and the service defaults on absence. The same
              // shape carries `chartTemplateId` (D-23), which this handler forwards
              // rather than rebuilds around — an omitted field here is a field the
              // published schema accepts and the server silently discards, which is the
              // failure `requireIdempotencyKey` exists to prevent one layer up.
              ...(org.fiscalYearStartMonth === undefined
                ? {}
                : { fiscalYearStartMonth: org.fiscalYearStartMonth }),
              ...(org.chartTemplateId === undefined
                ? {}
                : { chartTemplateId: org.chartTemplateId }),
            },
          });

          issuedCookie = sessionCookie(issued.sessionToken, config.session);
          return { ...issued.identity, memberships: wireList(issued.identity.memberships) };
        },
      );

      // Set only when the operation ran. See the note at the top of this file.
      const response = reply.status(result.status);
      if (issuedCookie !== undefined) {
        response.setCookie(issuedCookie.name, issuedCookie.value, issuedCookie.options);
      }
      return response.send(idempotentBody<IdentityResponse>(result));
    },
  );

  app.post(
    '/v1/auth/login',
    {
      onRequest: requireIdempotencyKey,
      schema: {
        operationId: 'login',
        summary: 'Exchange a password for a session',
        description:
          'Sets an `HttpOnly` session cookie. Every failure answers `unauthenticated` with no ' +
          'detail and takes the same time, because a faster answer for an unknown address is a ' +
          'user-enumeration oracle regardless of what the body says. Reachable without ' +
          'credentials.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        body: loginRequestSchema,
        response: { 200: identityResponseSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      let issuedCookie: SessionCookie | undefined;

      const result = await withGlobalIdempotency(
        { endpoint: 'login', request: request.body, successStatus: 200 },
        async () => {
          const issued = await login(request.body);
          issuedCookie = sessionCookie(issued.sessionToken, config.session);
          return { ...issued.identity, memberships: wireList(issued.identity.memberships) };
        },
      );

      const response = reply.status(result.status);
      if (issuedCookie !== undefined) {
        response.setCookie(issuedCookie.name, issuedCookie.value, issuedCookie.options);
      }
      return response.send(idempotentBody<IdentityResponse>(result));
    },
  );

  /**
   * 204 and no body, and it succeeds whether or not the cookie names a live session.
   *
   * `readSessionToken(request) ?? ''` rather than a branch on absence, so there is no
   * decision here at all: the service's contract is that a token naming nothing is a
   * no-op and not a `404` — logout is the one operation a client legitimately calls
   * with a stale cookie, and reporting a miss would both break that and confirm which
   * tokens were once real. An empty string is such a token.
   */
  app.post(
    '/v1/auth/logout',
    {
      onRequest: requireIdempotencyKey,
      schema: {
        operationId: 'logout',
        summary: 'Revoke the current session',
        description:
          'Revokes the session named by the cookie and clears it. Succeeds whether or not the ' +
          'cookie names a live session — a stale cookie is the ordinary case for this call.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        response: { 204: noContentSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const result = await withGlobalIdempotency(
        { endpoint: 'logout', request: {}, successStatus: 204 },
        async () => {
          await logout(readSessionToken(request) ?? '');
          return null;
        },
      );

      // Sent alongside the revocation, not instead of it, and on a replay as well:
      // the revocation ends the session, this only stops the browser presenting a
      // credential that no longer works, and there is no state in which the client
      // should be left holding one.
      const cookie = clearedSessionCookie(config.session);
      return reply
        .status(result.status)
        .setCookie(cookie.name, cookie.value, cookie.options)
        .send(null);
    },
  );

  /**
   * Gated on being a signed-in person, not on having an org — and the difference is
   * the point. A user who has just been removed from their only org has a valid
   * session and no org scope, so `isAuthenticatedContext` is false for them and every
   * tenant route refuses them. This is the call such a user needs in order to work:
   * it is what tells a client to render "you are not a member of any organization"
   * instead of bouncing to a login form that will succeed and change nothing. The
   * gate is `me()`'s, in the service, not this route's.
   */
  app.get(
    '/v1/auth/me',
    {
      schema: {
        operationId: 'getCurrentIdentity',
        summary: 'The caller, their organizations, the active one, and what they may do in it',
        description:
          'Answers for any live session, including one whose user is a member of no ' +
          'organization — `activeOrgId` is then null and `permissions` is empty. ' +
          '`permissions` is advisory: it is what a screen hides buttons with, never what ' +
          'authorizes an operation (ROADMAP D-25).',
        tags: [TAG],
        response: { 200: callerIdentityResponseSchema, ...ERROR_RESPONSES },
      },
    },
    async (): Promise<CallerIdentityResponse> => {
      const identity = await me();
      return {
        ...identity,
        memberships: wireList(identity.memberships),
        permissions: [...(await currentPermissions())],
      };
    },
  );
}
