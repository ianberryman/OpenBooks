import { bufferToUuid, selectApiKeyByHash, tenantDb } from '../../db';
import { UnauthenticatedError } from '../../errors';
import type { ResolvedIdentity } from './identity';
import { sessionTokenHash } from './tokens';

/**
 * Turns a request's `Authorization: Bearer` header into a request context (OB-099
 * filling OB-022's `IdentityResolver` seam, the same seam `identity.ts` fills for a
 * session cookie).
 *
 * ## What this resolver authenticates as, and why
 *
 * D-55: a key is first-party and represents no person. It authenticates as an org
 * and a **role**, never a user — `userId` is always `null` in the identity this
 * returns, which is what lets `chk_journals_invocation_mode` and every other place
 * that branches on `actorType` tell an API-key-driven posting apart from one a
 * human typed. `roleId` is the key's own column (`api_keys.role_id`, unused since
 * `0001_tenancy`), never the issuer's: an issuer later demoted must not leave
 * behind a key that still carries their old authority.
 *
 * `invocationMode` is absent, matching `identity.ts:identityFor`'s reasoning
 * exactly: plugin-api says not to default it, and `chk_journals_invocation_mode`
 * requires the column only for `actor_type = 'agent'` and forbids it for every
 * other actor type — including `automation`, which is what this resolver sets.
 *
 * ## `null` versus `UnauthenticatedError`
 *
 * The same distinction `resolveSessionIdentity` draws, drawn the same way:
 *
 *  - **No `Authorization` header, or a value that is not `obk_`-prefixed** —
 *    `null`. Not our credential. Falling through lets a session cookie on the same
 *    request (or no credential at all, for a route that permits that) decide the
 *    outcome instead of this resolver refusing a request that was never trying to
 *    use an API key.
 *  - **`obk_`-prefixed and names no row** — throws. Nothing this system issued
 *    hashes to a `key_hash` matching no row: it is forged, mangled, or a
 *    foreign-deployment key.
 *  - **Names a row, but `revoked_at` is set** — throws. Found and rejected, not
 *    absent — the same "replay of a credential whose end was affirmative" case
 *    `identity.ts` describes for a revoked session.
 *
 * ## Why the lookup cannot go through `tenantDb`
 *
 * `api_keys` is a tenant table, and this function is what *establishes* which org
 * a request belongs to — there is no org yet to scope a query with. See
 * `db/api-key-lookup.ts` for the narrow, documented exception this borrows, the
 * same shape `delivery-lookup.ts` is for a hosted invoice page's token. Once the
 * row resolves, `orgId` is known, and the `last_used_at` touch below reaches it
 * through `tenantDb(row.orgId)` like any other tenant write.
 */
export interface AuthorizationCarrier {
  readonly headers: { readonly authorization?: string | string[] | undefined };
}

/** `api_keys.key_prefix` and every minted key both start with this (`api-keys.service.ts`). */
const API_KEY_TOKEN_PREFIX = 'obk_';

const BEARER_PREFIX = 'Bearer ';

export async function resolveApiKeyIdentity(
  request: AuthorizationCarrier,
): Promise<ResolvedIdentity | null> {
  const token = readBearerToken(request);
  if (token === undefined || !token.startsWith(API_KEY_TOKEN_PREFIX)) return null;

  const row = await selectApiKeyByHash(sessionTokenHash(token));
  if (row === undefined) throw new UnauthenticatedError();
  if (row.revokedAt !== null) throw new UnauthenticatedError();

  await touchLastUsed(row.orgId, row.id);

  return {
    orgId: bufferToUuid(row.orgId),
    userId: null,
    roleId: bufferToUuid(row.roleId),
    actorType: 'automation',
    actorId: bufferToUuid(row.id),
  };
}

/**
 * A single `Authorization: Bearer <token>` header, or `undefined` for anything
 * else — absent, repeated (Fastify hands back an array for a repeated header, and
 * two contradictory credentials on one request is not this resolver's call to
 * arbitrate), or a scheme other than `Bearer`.
 */
function readBearerToken(request: AuthorizationCarrier): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith(BEARER_PREFIX)) return undefined;

  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length === 0 ? undefined : token;
}

/**
 * Best-effort, deliberately: a request that authenticated correctly must not fail
 * because the usage marker could not be written. `last_used_at` is a convenience
 * for an operator auditing which keys are still active, not a fact anything
 * authorizes off, so losing an update to it is a worse outcome to guard against
 * than the write itself failing.
 */
async function touchLastUsed(orgId: Buffer, id: Buffer): Promise<void> {
  try {
    await tenantDb(orgId)
      .updateTable('api_keys')
      .set({ last_used_at: new Date() })
      .where('id', '=', id)
      .execute();
  } catch {
    // Swallowed on purpose — see the doc comment above.
  }
}
