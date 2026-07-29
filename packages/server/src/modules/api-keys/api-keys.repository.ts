import type { Expression, SqlBool } from 'kysely';
import { sql } from 'kysely';

import type { ApiKey } from '@openbooks/shared-types';

import type { RequestContext } from '../../context';
import type { KeysetOrdering, KeysetPage, OrgId, TenantDatabase } from '../../db';
import {
  applyKeyset,
  bufferToUuid,
  instantKey,
  newUuidBuffer,
  orgScope as toOrgId,
  systemDb,
  tenantDb,
  toKeysetPage,
  tryUuidToBuffer,
  uuidKey,
} from '../../db';
import { InternalError } from '../../errors';

/**
 * Data access for `api_keys`, and the `security_events` rows their issuance and
 * revocation write (OB-099; ROADMAP D-55, D-61).
 *
 * Everything but role validation goes through `tenantDb`, so `org_id = ctx.orgId`
 * is on every statement before this file adds a predicate — the same A7 argument
 * `dimensions.repository.ts` makes. Role validation is the one exception, and it
 * is documented at `selectAssignableRoleId` below, for the same reason
 * `members.repository.ts` documents its own copy of the same predicate.
 */

/** The resource token an unknown or cross-org key id reports (A7). */
export const API_KEY_RESOURCE = 'api_key';

/** The resource token a `roleId` naming no assignable role reports. */
export const ROLE_RESOURCE = 'role';

/** `security_events.credential_type` for every row this module writes. */
export const API_KEY_CREDENTIAL_TYPE = 'api_key';

const API_KEY_COLUMNS = [
  'id',
  'name',
  'role_id',
  'key_prefix',
  'created_by_user_id',
  'created_at',
  'last_used_at',
  'revoked_at',
] as const;

export interface ApiKeyRow {
  readonly id: Buffer;
  readonly name: string;
  readonly role_id: Buffer;
  readonly key_prefix: string;
  readonly created_by_user_id: Buffer | null;
  readonly created_at: Date;
  readonly last_used_at: Date | null;
  readonly revoked_at: Date | null;
}

export interface NewApiKeyRow {
  readonly name: string;
  readonly roleId: Buffer;
  readonly keyPrefix: string;
  readonly keyHash: string;
  readonly createdByUserId: Buffer | null;
}

export interface NewSecurityEventRow {
  readonly eventType: string;
  readonly actorUserId: Buffer | null;
  readonly credentialId: Buffer;
}

/** The scope every operation in this module runs in (spec §4 — never a parameter). */
export function orgScope(ctx: RequestContext): TenantDatabase {
  return tenantDb(toOrgId(ctx.orgId));
}

/**
 * A client-supplied id as bytes, or `undefined` when it is not a UUID.
 *
 * Undefined rather than a throw, so the service routes a malformed id through
 * `assertFound` to the same 404 a nonexistent one produces (A7) — matching
 * `dimensionIdBytes` and `idBytes` elsewhere in the tree.
 */
export function apiKeyIdBytes(id: string): Buffer | undefined {
  return tryUuidToBuffer(id);
}

export async function insertApiKey(db: TenantDatabase, input: NewApiKeyRow): Promise<ApiKeyRow> {
  const id = newUuidBuffer();

  // No duplicate-key translation, unlike `insertDimension`: `uq_api_keys_hash`
  // guards a SHA-256 digest of 256 random bits (`tokens.ts`'s reasoning), so a
  // collision is not a case this service prepares a message for any more than
  // `insertSession` does for `uq_sessions_token`.
  await db
    .insertInto('api_keys')
    .values({
      id,
      name: input.name,
      role_id: input.roleId,
      key_prefix: input.keyPrefix,
      key_hash: input.keyHash,
      created_by_user_id: input.createdByUserId,
    })
    .execute();

  const row = await selectApiKeyById(db, id);
  if (row === undefined) {
    throw new InternalError('The API key inserted by this statement could not be read back.');
  }
  return row;
}

export async function selectApiKeyById(
  db: TenantDatabase,
  id: Buffer,
): Promise<ApiKeyRow | undefined> {
  return db.selectFrom('api_keys').select(API_KEY_COLUMNS).where('id', '=', id).executeTakeFirst();
}

/**
 * `(created_at, id)` — both immutable, matching every other keyset in this
 * codebase (`keyset.ts`'s file header). Issuance order, not `key_prefix`, because
 * `key_prefix` is not unique in general (two keys can theoretically collide on
 * their first `KEY_PREFIX_VISIBLE_CHARS` characters — see `api-keys.service.ts`)
 * and is not the axis an operator manages keys by regardless.
 */
const API_KEY_KEYSET: KeysetOrdering<ApiKeyRow> = [
  instantKey('api_keys.created_at', (row) => row.created_at),
  uuidKey('api_keys.id', (row) => row.id),
];

/**
 * Every key this org has issued, revoked or not — listing is a management view
 * (OB-099's spec), so a revoked key stays visible with `revokedAt` set rather than
 * disappearing from the page it was issued on.
 */
export async function selectApiKeysPage(
  db: TenantDatabase,
  limit: number,
  cursor: string | undefined,
): Promise<KeysetPage<ApiKeyRow>> {
  const query = db.selectFrom('api_keys').select(API_KEY_COLUMNS);
  const rows = await applyKeyset(query, API_KEY_KEYSET, limit, cursor).execute();

  return toKeysetPage(rows, API_KEY_KEYSET, limit);
}

/**
 * Sets `revoked_at`, but only if it is not already set.
 *
 * Returns whether this call is the one that took effect, the same shape
 * `markInviteRevoked` uses and for the same reason: revocation is idempotent
 * (OB-099's spec says so explicitly), so a retry that finds the key already
 * revoked must succeed without writing a second `security_events` row for the
 * same act. The caller uses the return value for exactly that — see
 * `revokeApiKey` in `api-keys.service.ts`.
 */
export async function revokeApiKeyRow(db: TenantDatabase, id: Buffer, at: Date): Promise<boolean> {
  const result = await db
    .updateTable('api_keys')
    .set({ revoked_at: at })
    .where('id', '=', id)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();

  return result.numUpdatedRows > 0n;
}

/**
 * Best-effort: the caller of `resolveApiKeyIdentity` must not fail authentication
 * because this write did. Not routed through here — see
 * `modules/auth/api-key-identity.ts`, which calls `tenantDb` directly once it
 * holds the org id the credential named, the same way `public-invoice.service.ts`
 * does once a delivery token has resolved one.
 */
export async function insertSecurityEvent(
  db: TenantDatabase,
  input: NewSecurityEventRow,
): Promise<void> {
  await db
    .insertInto('security_events')
    .values({
      id: newUuidBuffer(),
      event_type: input.eventType,
      actor_user_id: input.actorUserId,
      credential_type: API_KEY_CREDENTIAL_TYPE,
      credential_id: input.credentialId,
      detail: null,
    })
    .execute();
}

/**
 * Whether `roleId` may be bound to a key issued by `orgId`: a seeded system role
 * (`org_id IS NULL`) or a role belonging to this org itself. Returns the role's own
 * id, so the caller can insert with a value this function has already validated
 * rather than re-trusting the request.
 *
 * A third copy of `(roles.org_id = <org> OR roles.org_id IS NULL)`.
 * `permissions.repository.ts:roleVisibleToOrg` answers a different question —
 * "what does this role grant the caller, here" — and
 * `members.repository.ts:roleVisibleTo` answers "may this org hand this role to a
 * member". This one answers "may this org bind a key to this role", a third
 * question with the same shape. `members.repository.ts` already flags the pair as
 * worth hoisting once a third caller arrived; it has, and the hoist is still not
 * this ticket's to make — flagged again in the OB-099 report.
 *
 * `roles` is read through `systemDb`, never `tenantDb`: it is the one table
 * deliberately excluded from the tenant set (`tenant-tables.ts`), because its
 * `org_id` is nullable and NULL means "shared by every org" — a bare
 * `tenantDb` equality would hide all six seeded roles.
 */
export async function selectAssignableRoleId(
  orgId: OrgId,
  roleId: Buffer,
): Promise<Buffer | undefined> {
  const row = await systemDb()
    .selectFrom('roles')
    .select('id')
    .where('id', '=', roleId)
    .where(roleVisibleTo(orgId))
    .executeTakeFirst();

  return row?.id;
}

function roleVisibleTo(orgId: OrgId): Expression<SqlBool> {
  return sql<SqlBool>`(${sql.ref('roles.org_id')} = ${orgId} OR ${sql.ref('roles.org_id')} IS NULL)`;
}

export function toApiKey(row: ApiKeyRow): ApiKey {
  return {
    id: bufferToUuid(row.id),
    name: row.name,
    roleId: bufferToUuid(row.role_id),
    keyPrefix: row.key_prefix,
    createdByUserId: row.created_by_user_id === null ? null : bufferToUuid(row.created_by_user_id),
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at === null ? null : row.last_used_at.toISOString(),
    revokedAt: row.revoked_at === null ? null : row.revoked_at.toISOString(),
  };
}
