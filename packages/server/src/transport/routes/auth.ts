import {
  identityResponseSchema,
  loginRequestSchema,
  registerRequestSchema,
} from '@openbooks/shared-types';
import type { IdentityResponse } from '@openbooks/shared-types';

import type { Config } from '../../config';
import {
  clearedSessionCookie,
  login,
  logout,
  me,
  readSessionToken,
  register,
  sessionCookie,
} from '../../modules/auth';
import { requireIdempotencyKey } from '../idempotency';
import type { App } from '../types';
import { ERROR_RESPONSES, idempotencyKeyHeaderSchema, noContentSchema, wireList } from './support';

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
 * ## Why every write here requires an `Idempotency-Key` but is not replay-guarded
 *
 * See the block on `registerV1Routes` in `./index.ts`. The short version: the claim
 * row is org-scoped (`idempotency_keys.org_id` → `orgs.id`, migration `0003`) and
 * these operations either predate the org or would be recorded against the wrong
 * one. The header is still required — it is also what makes a cross-site form POST
 * unable to reach a write (see the `sameSite` note in `src/transport/app.ts`).
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
      const issued = await register({
        email: request.body.email,
        password: request.body.password,
        displayName: request.body.displayName,
        org: {
          name: org.name,
          // Spread, not `fiscalYearStartMonth: org.fiscalYearStartMonth`:
          // exactOptionalPropertyTypes makes an explicit `undefined` a different type
          // from an absent key, and the service defaults on absence.
          ...(org.fiscalYearStartMonth === undefined
            ? {}
            : { fiscalYearStartMonth: org.fiscalYearStartMonth }),
        },
      });

      const cookie = sessionCookie(issued.sessionToken, config.session);
      return reply
        .status(201)
        .setCookie(cookie.name, cookie.value, cookie.options)
        .send({ ...issued.identity, memberships: wireList(issued.identity.memberships) });
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
      const issued = await login(request.body);

      const cookie = sessionCookie(issued.sessionToken, config.session);
      return reply
        .status(200)
        .setCookie(cookie.name, cookie.value, cookie.options)
        .send({ ...issued.identity, memberships: wireList(issued.identity.memberships) });
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
      await logout(readSessionToken(request) ?? '');

      // Sent alongside the revocation, not instead of it. The revocation ends the
      // session; this only stops the browser presenting a credential that no longer
      // works.
      const cookie = clearedSessionCookie(config.session);
      return reply.status(204).setCookie(cookie.name, cookie.value, cookie.options).send(null);
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
        summary: 'The caller, their organizations, and the active one',
        description:
          'Answers for any live session, including one whose user is a member of no ' +
          'organization — `activeOrgId` is then null.',
        tags: [TAG],
        response: { 200: identityResponseSchema, ...ERROR_RESPONSES },
      },
    },
    async (): Promise<IdentityResponse> => {
      const identity = await me();
      return { ...identity, memberships: wireList(identity.memberships) };
    },
  );
}
