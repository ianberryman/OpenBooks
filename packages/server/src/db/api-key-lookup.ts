import { rawDb } from './client';
import { ambientTransaction } from './transaction-scope';

/**
 * A second unauthenticated read, alongside `delivery-lookup.ts`'s (OB-121, D-74):
 * resolving a presented API key to the `api_keys` row it names, before any org is
 * known (OB-099, D-55, D-61).
 *
 * `api_keys` is a tenant table (`tenant-tables.ts`) and every other reader of it
 * goes through `tenantDb(orgId)`. This one cannot — `resolveApiKeyIdentity` is
 * what *establishes* which org the request belongs to, so it has nothing but the
 * presented key to start from. That is the same shape `verifyDeliveryToken` is in,
 * and the fix is the same one: a single, narrow, well-documented exception living
 * in `src/db/` rather than a service reaching for `systemDb()` on a table that
 * table's own doc comment says is not what `systemDb()` is for.
 *
 * The lookup itself is simpler than the delivery token's. `key_hash` carries its
 * own unique index (`uq_api_keys_hash`, `0001_tenancy.ts`) rather than sitting
 * behind a bare `key_prefix`, so this is a direct equality probe and needs no
 * separate `timingSafeEqual` step — `key_hash` is `sessionTokenHash` of 256 bits of
 * `crypto.randomBytes` (`modules/auth/tokens.ts`'s reasoning, reused verbatim by
 * the key), so it is already the deterministic, non-guessable index `sessions`
 * uses for the identical purpose.
 *
 * Once the row resolves, `resolveApiKeyIdentity` reaches everything else —
 * including the best-effort `last_used_at` touch — through `tenantDb(row.orgId)`,
 * exactly as `public-invoice.service.ts` does once a delivery token has named an
 * org. This file is the one exception, not a pattern to repeat.
 */
export interface ApiKeyCredentialRow {
  readonly id: Buffer;
  readonly orgId: Buffer;
  readonly roleId: Buffer;
  readonly revokedAt: Date | null;
}

export async function selectApiKeyByHash(
  keyHash: string,
): Promise<ApiKeyCredentialRow | undefined> {
  // Joins an ambient transaction for the reason `tenantDb`/`systemDb` do
  // (`transaction-scope.ts`): a caller reached from inside one — a test harness,
  // principally, since production serves this from a bare request with no ambient
  // scope — must not land on a second connection that cannot see what the first
  // has not committed.
  const row = await (ambientTransaction() ?? rawDb())
    .selectFrom('api_keys')
    .select(['id', 'org_id', 'role_id', 'revoked_at'])
    .where('key_hash', '=', keyHash)
    .executeTakeFirst();

  if (row === undefined) return undefined;

  return { id: row.id, orgId: row.org_id, roleId: row.role_id, revokedAt: row.revoked_at };
}
