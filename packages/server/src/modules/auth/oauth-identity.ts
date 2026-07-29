import { bufferToUuid, selectOAuthTokenByHash, tenantDb } from '../../db';
import { UnauthenticatedError } from '../../errors';
import { getLogger } from '../../logging';
import { selectOAuthClientById, touchOAuthTokenLastUsed } from '../oauth';
import type { PermissionKey } from '../permissions';
import { isPermissionKey, resolveMembership } from '../permissions';
import type { ResolvedIdentity } from './identity';
import { sessionTokenHash } from './tokens';

/**
 * Turns a bearer OAuth access token into a request context (OB-098 filling OB-022's
 * `IdentityResolver` seam a second time — `identity.ts` is the first, for sessions).
 *
 * ## `null` versus `UnauthenticatedError`, restated for a bearer token
 *
 * `resolveSessionIdentity`'s header draws this line for a cookie, and it transfers
 * here with one addition at the front: the dispatcher (OB-104) tries every
 * registered resolver in turn, so a credential that is simply not *this* resolver's
 * concern has to say so without being treated as a rejected one.
 *
 *  - **No `Authorization` header, or a scheme other than `Bearer`, or a `Bearer`
 *    value not starting with `oba_`** — `null`. Not an OAuth access token at all;
 *    the dispatcher falls through to the API-key resolver (OB-099) and then to
 *    nothing, and a route with no matching credential answers `401` on its own.
 *  - **Names no `oauth_tokens` row** — throws. Nothing this system issued produces
 *    a hash matching no row: a forged, mangled, or foreign-deployment token.
 *  - **Revoked, expired, not an access token, or its client has been
 *    deactivated** — throws. Every one of these is "credentials found and
 *    rejected", and D-61 requires each to take effect on the very next request —
 *    there is no cache here to make stale.
 *  - **The granting user is no longer a member of the token's org** — throws. F2's
 *    whole point: narrowing (or removing) the user's membership narrows the token
 *    with no row in `oauth_tokens` touched, because this resolver re-derives
 *    membership on every call rather than trusting anything the token carries.
 *
 * ## Why the role and the scope are both re-derived here, live
 *
 * `oauth_tokens.scope` is the scope *granted* at consent time — a ceiling, not an
 * entitlement. D-54's rule is that a token's effective permissions are the granted
 * scope **intersected with the granting user's current role**, recomputed on every
 * request exactly the way `resolveSessionIdentity` already recomputes a session's
 * org and role rather than trusting `sessions.active_org_id`. This function does
 * its half — re-deriving `roleId` from `resolveMembership` rather than storing one
 * — and hands the granted scope onward as `scopeLimit`;
 * `permissionsForContext` (`modules/permissions/permissions.service.ts`) does the
 * other half, intersecting `scopeLimit` with the live role's permissions on every
 * `requirePermission` call. Neither half alone is F2; the two together are.
 */
export async function resolveOAuthIdentity(
  request: BearerTokenCarrier,
): Promise<ResolvedIdentity | null> {
  const token = readBearerToken(request);
  if (token === undefined || !token.startsWith(ACCESS_TOKEN_PREFIX)) return null;

  const row = await selectOAuthTokenByHash(sessionTokenHash(token));
  if (row === undefined) throw new UnauthenticatedError();
  if (row.tokenType !== 'access') throw new UnauthenticatedError();
  if (row.revokedAt !== null) throw new UnauthenticatedError();

  const now = new Date();
  if (row.expiresAt.getTime() <= now.getTime()) throw new UnauthenticatedError();

  const db = tenantDb(row.orgId);
  const client = await selectOAuthClientById(db, row.clientId);
  if (client === undefined || client.deactivatedAt !== null) throw new UnauthenticatedError();

  const orgId = bufferToUuid(row.orgId);
  const userId = bufferToUuid(row.userId);
  const membership = await resolveMembership(userId, orgId);
  if (!membership.isMember) throw new UnauthenticatedError();

  if (shouldTouchLastUsed(row.lastUsedAt, now)) {
    try {
      await touchOAuthTokenLastUsed(db, row.id, now);
    } catch (error) {
      // Best-effort: an audit convenience, not a correctness property. Failing to
      // record when a token was last used must never fail the request the token is
      // authenticating.
      getLogger().warn({ err: error }, 'Failed to update oauth_tokens.last_used_at.');
    }
  }

  return {
    orgId,
    userId,
    roleId: membership.roleId,
    actorType: 'user',
    actorId: userId,
    scopeLimit: parseScopeLimit(row.scope),
  };
}

/**
 * A request carrying an `Authorization` header, structurally — the `CookieCarrier`
 * pattern applied to a bearer credential, so this resolver stays callable from a
 * test (or a future transport) without naming `FastifyRequest`
 * (`.dependency-cruiser.cjs`'s `services-do-not-import-transport`).
 */
export interface BearerTokenCarrier {
  readonly headers: { readonly authorization?: string | undefined };
}

const BEARER_SCHEME = 'Bearer ';
const ACCESS_TOKEN_PREFIX = 'oba_';

function readBearerToken(request: BearerTokenCarrier): string | undefined {
  const header = request.headers.authorization;
  if (header === undefined || !header.startsWith(BEARER_SCHEME)) return undefined;

  const token = header.slice(BEARER_SCHEME.length).trim();
  return token.length === 0 ? undefined : token;
}

/**
 * How stale `last_used_at` is allowed to get before this resolver bothers writing
 * it again: **15 minutes**, `auth.repository.ts`'s `LAST_SEEN_THROTTLE_MS` for the
 * same reason — every authenticated request would otherwise turn into a write on
 * the hottest path in the system, for a value whose consumers (a connected-apps
 * list) do not care about the difference between "now" and "ten minutes ago".
 */
const LAST_USED_THROTTLE_MS = 15 * 60 * 1000;

function shouldTouchLastUsed(lastUsedAt: Date | null, now: Date): boolean {
  return lastUsedAt === null || now.getTime() - lastUsedAt.getTime() >= LAST_USED_THROTTLE_MS;
}

/**
 * `oauth_tokens.scope` back into `PermissionKey[]`, dropping anything the current
 * catalog does not recognise (F5: "a scope naming no permission grants nothing").
 * Deliberately the lenient half of the split with `oauth.service.ts`'s
 * `requireKnownScope`, which refuses an unrecognised key at *grant* time — by the
 * time a token is being used, the only question left is what it is still good for,
 * and a permission removed from the catalog since the grant should silently stop
 * being covered rather than fail every request the token makes.
 */
function parseScopeLimit(scope: string): readonly PermissionKey[] {
  return scope.split(/\s+/).filter((token): token is PermissionKey => isPermissionKey(token));
}
