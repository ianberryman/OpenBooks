/**
 * How an HTTP request becomes a request context (spec §4), and the seam OB-015
 * plugs authentication into.
 *
 * `src/context/` owns the carrier and the scoping rules; this file owns only the
 * mapping from a Fastify request onto them. Nothing here reads a session or a
 * cookie — that is OB-015's job, expressed as an `IdentityResolver`.
 */
import type { ActorType, InvocationMode } from '@openbooks/plugin-api';
import type { FastifyRequest } from 'fastify';

import type { ContextOverrides, RequestContext } from '../context';
import { createRequestContext, UNAUTHENTICATED_ID } from '../context';
import type { PermissionKey } from '../modules/permissions';
import { readIdempotencyKey } from './idempotency';

/**
 * Correlation id in, correlation id out.
 *
 * Accepted from the client so a caller that already has a trace id can find its
 * own request in our logs, which is the difference between a support ticket that
 * takes minutes and one that takes days. Validated rather than trusted: the value
 * lands in every log line for the request and is echoed in a response header, so
 * an unbounded or newline-bearing value is a log-forgery and header-splitting
 * vector. It is a correlation aid and never an identity — nothing authorizes off
 * it, so a client choosing its own is not a privilege.
 */
const REQUEST_ID_HEADER = 'x-request-id';
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Echoed on every response, including error responses. */
export const REQUEST_ID_RESPONSE_HEADER = 'x-request-id';

/**
 * The pre-auth scope every request starts in.
 *
 * The constant and its test now live in `src/context/authentication.ts`, which
 * carries the reasoning for the nil UUID and for the move. The short version is
 * that `src/modules/` may not import `src/transport/` — OB-016's permission check
 * and OB-015's identity resolver both need this, and `src/context/` is the module
 * both layers may reach.
 *
 * Only routes that touch no tenant data may run in it: `GET /health`, and OB-023's
 * identity-establishing routes — the ones whose `RouteDefinition.permission` is
 * `null`. Every other route runs in the scope derived by the identity resolver
 * below.
 *
 * Re-exported so the transport surface in `src/transport/index.ts` is unchanged.
 */
export { isAuthenticatedContext } from '../context';

/**
 * What OB-015 must produce from a request, and nothing more.
 *
 * A separate type from `RequestContext` on purpose: `requestId` and
 * `idempotencyKey` are properties of the *request*, already resolved by the time
 * a resolver runs, and handing them to the resolver would let authentication
 * rewrite the correlation id of the request it is authenticating.
 */
export interface RequestIdentity {
  readonly orgId: string;
  /** Null for automation and agent callers not acting as an org member. */
  readonly userId: string | null;
  readonly roleId: string;
  readonly actorType: ActorType;
  readonly actorId: string;
  /** Absent means unrecorded. plugin-api is explicit that it must not default to `interactive`. */
  readonly invocationMode?: InvocationMode;
  /**
   * The OAuth scope∩role ceiling (OB-098; D-54/F2) — see `ResolvedIdentity`'s own
   * comment in `modules/auth/identity.ts`, which this mirrors structurally for the
   * boundary reason at the top of this file. Absent for a session or an API key.
   */
  readonly scopeLimit?: readonly PermissionKey[];
}

/**
 * The authentication seam (OB-015).
 *
 * Returning `null` means "no usable identity on this request", and is not an
 * error: unauthenticated requests are legal and reach `/health` and the login
 * routes. Refusing an unauthenticated request is a per-route decision (OB-016's
 * permission check), not something the resolver can make on the resolver's own —
 * it has no idea which route it is on.
 *
 * A resolver that decides the credentials it *did* find are invalid throws
 * `UnauthenticatedError`; the error handler turns that into a 401. The
 * distinction matters: "no cookie" and "a forged cookie" are different events and
 * only the second is worth an alert.
 *
 * Async because it will read a session row. It is called once per request, before
 * validation, and its result is applied with `runInDerivedContext`, so the
 * `requestId` established below is preserved rather than re-minted.
 */
export type IdentityResolver = (request: FastifyRequest) => Promise<RequestIdentity | null>;

function inboundRequestId(request: FastifyRequest): string | undefined {
  const raw = request.headers[REQUEST_ID_HEADER];
  // A repeated header means two contradictory correlation ids; generate our own
  // rather than pick.
  if (typeof raw !== 'string') return undefined;
  return SAFE_REQUEST_ID.test(raw) ? raw : undefined;
}

/**
 * The correlation id for this request. Cannot fail.
 *
 * `request.id` is the fallback rather than letting `createRequestContext` generate
 * one, so the id in the context is the same id Fastify would use if anything ever
 * logs through `request.log`.
 *
 * Separate from `initialContext` because the response header has to be set before
 * anything that can reject the request, and because a correlation id is the one
 * thing that must exist for every outcome including the earliest rejection.
 */
export function resolveRequestId(request: FastifyRequest): string {
  return inboundRequestId(request) ?? request.id;
}

/**
 * Reads the `Idempotency-Key`, or returns the error that rejects the request.
 *
 * Returning the failure instead of throwing is deliberate. This runs in the same
 * hook that opens the context scope, and a throw here would happen *before* the
 * scope exists — so the rejection would be the one outcome in the system logged
 * without a `requestId`, which is exactly the outcome a client is going to ask
 * about. `src/transport/app.ts` opens the scope with a null key and then surfaces
 * this from inside it.
 */
export function readIdempotencyKeyOrFailure(request: FastifyRequest): {
  readonly key: string | null;
  readonly failure?: Error;
} {
  try {
    return { key: readIdempotencyKey(request) };
  } catch (error) {
    return {
      key: null,
      failure: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * The scope every request starts in.
 *
 * `idempotencyKey` is a parameter rather than read here so that this function
 * cannot fail — see `readIdempotencyKeyOrFailure`. It is on the context for the
 * whole request because spec §12's key travels via
 * `OperationContext.idempotencyKey` and never as an argument, which is what lets
 * `withIdempotency` in `src/modules/idempotency/` find it.
 */
export function initialContext(requestId: string, idempotencyKey: string | null): RequestContext {
  return createRequestContext({
    requestId,
    orgId: UNAUTHENTICATED_ID,
    userId: null,
    roleId: UNAUTHENTICATED_ID,
    actorType: 'user',
    actorId: UNAUTHENTICATED_ID,
    idempotencyKey,
  });
}

/**
 * Projects an identity onto the overrides that re-scope the request.
 *
 * Deliberately does not spread `identity`: a resolver that grew an extra field
 * would otherwise silently start overwriting whatever `ContextOverrides` names
 * next.
 */
export function identityOverrides(identity: RequestIdentity): ContextOverrides {
  return {
    orgId: identity.orgId,
    userId: identity.userId,
    roleId: identity.roleId,
    actorType: identity.actorType,
    actorId: identity.actorId,
    ...(identity.invocationMode === undefined ? {} : { invocationMode: identity.invocationMode }),
    ...(identity.scopeLimit === undefined ? {} : { scopeLimit: identity.scopeLimit }),
  };
}
