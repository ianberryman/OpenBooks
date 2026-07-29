import { randomBytes } from 'node:crypto';

import type {
  ApiKey,
  ApiKeyPage,
  ApiKeyWithSecret,
  CreateApiKeyRequest,
} from '@openbooks/shared-types';
import { createApiKeyRequestSchema } from '@openbooks/shared-types';

import type { RequestContext } from '../../context';
import { orgScope as toOrgId, resolvePageLimit, uuidToBuffer } from '../../db';
import { assertFound, parseInput } from '../../errors';
import { sessionTokenHash } from '../auth/tokens';
import { requirePermission } from '../permissions';
import {
  API_KEY_RESOURCE,
  apiKeyIdBytes,
  insertApiKey,
  insertSecurityEvent,
  orgScope,
  revokeApiKeyRow,
  ROLE_RESOURCE,
  selectApiKeyById,
  selectApiKeysPage,
  selectAssignableRoleId,
  toApiKey,
} from './api-keys.repository';

/**
 * API-key issuance, listing, and revocation (OB-099; ROADMAP D-55, D-61).
 *
 * A key is first-party and represents no person: it authenticates as an org and a
 * **role**, with `userId: null` throughout the request it drives — see
 * `modules/auth/api-key-identity.ts` for the resolver this module's rows feed. The
 * role is the key's own (`roleId` below), never the issuer's: an issuer later
 * demoted must not leave behind a key that still carries their old authority,
 * which is `0001_tenancy.ts`'s reasoning for the column's existence eight
 * milestones before this ticket gave it a write path.
 *
 * Two things are uniform across every operation and stated once here, matching
 * `dimensions.service.ts`:
 *
 * 1. **`requirePermission` runs first**, before the payload is parsed. A caller
 *    without authority learns that and nothing else.
 * 2. **A miss is `assertFound`**, never a hand-written throw. `tenantDb` has
 *    already confined every read to the context's org, so a cross-org id and a
 *    nonexistent one reach the same line (A7).
 */

/**
 * `obk_` + 256 bits of `crypto.randomBytes`, base64url — the same width and the
 * same reasoning `sessionTokenHash`'s header gives for a bearer credential: the
 * entropy is the whole of the security, and hashing it with anything slower than
 * SHA-256 would buy nothing against a search space this large while turning the
 * lookup from an index probe into a row-by-row scan.
 *
 * `KEY_PREFIX_VISIBLE_CHARS` of the minted string — the `obk_` marker plus eight
 * characters of the secret — is stored in the clear as `key_prefix`
 * (`VARCHAR(16)`), so an operator can tell two keys apart in a list without either
 * holding the secret or this service storing more of it than `sessionTokenHash`
 * already keeps hashed.
 */
const API_KEY_TOKEN_PREFIX = 'obk_';
const API_KEY_SECRET_BYTES = 32;
const KEY_PREFIX_VISIBLE_CHARS = 12;

function mintApiKey(): { readonly key: string; readonly keyPrefix: string } {
  const key = `${API_KEY_TOKEN_PREFIX}${randomBytes(API_KEY_SECRET_BYTES).toString('base64url')}`;
  return { key, keyPrefix: key.slice(0, KEY_PREFIX_VISIBLE_CHARS) };
}

/**
 * Issues a key, returning the full opaque value once — see `apiKeyWithSecretSchema`
 * for why nothing after this response ever carries it again.
 *
 * `roleId` is validated against *this* org before anything is written: `roles` is
 * shared across every org in the system (a seeded system role, or in v2 a custom
 * one), so a role id naming a row is not by itself a role this org may hand to a
 * key. A role from another org is the same 404 a role id that names no row at all
 * produces — A7 applies to a role reference exactly as it applies to any other.
 *
 * One transaction: the key row and its `security_events` row must commit
 * together, or a reader of the audit trail could see a key that was never issued,
 * or an issued key with no record that it happened.
 */
export async function createApiKey(
  input: CreateApiKeyRequest,
  ctx: RequestContext,
): Promise<ApiKeyWithSecret> {
  await requirePermission(ctx, 'api_keys.write');
  const request = parseInput(createApiKeyRequestSchema, input);

  const orgId = toOrgId(ctx.orgId);
  // `request.roleId` is `z.uuid()`-validated by the schema above, so this is a
  // shape conversion, not a trust decision — `selectAssignableRoleId` is what
  // decides whether the id is one this org may use.
  const roleId = uuidToBuffer(request.roleId);
  const assignableRoleId = assertFound(await selectAssignableRoleId(orgId, roleId), ROLE_RESOURCE);

  const { key, keyPrefix } = mintApiKey();
  const createdByUserId = ctx.userId === null ? null : uuidToBuffer(ctx.userId);

  const created = await orgScope(ctx).transaction(async (trx) => {
    const row = await insertApiKey(trx, {
      name: request.name,
      roleId: assignableRoleId,
      keyPrefix,
      keyHash: sessionTokenHash(key),
      createdByUserId,
    });

    await insertSecurityEvent(trx, {
      eventType: 'api_key.issued',
      actorUserId: createdByUserId,
      credentialId: row.id,
    });

    return row;
  });

  return { ...toApiKey(created), key };
}

/**
 * One page of the org's keys, revoked ones included — listing is a management
 * view (OB-099's spec), so a revoked key stays on the page it was issued on
 * rather than disappearing.
 *
 * `limit`/`cursor` are accepted as plain values rather than parsed against a
 * shared zod schema: there is no wire contract for this operation yet (OB-104
 * adds ids and routes), and `resolvePageLimit` is the authority spec §12 requires
 * it to be regardless of what sits in front of it — see its own comment.
 */
export interface ListApiKeysQuery {
  readonly limit?: number;
  readonly cursor?: string;
}

export async function listApiKeys(
  query: ListApiKeysQuery,
  ctx: RequestContext,
): Promise<ApiKeyPage> {
  await requirePermission(ctx, 'api_keys.read');
  const limit = resolvePageLimit(query.limit);

  const page = await selectApiKeysPage(orgScope(ctx), limit, query.cursor);
  return { items: page.rows.map(toApiKey), nextCursor: page.nextCursor };
}

/**
 * Revokes a key. Idempotent: a key already revoked is returned unchanged rather
 * than refused, because a retry of a revocation is a retry and not a conflict —
 * the same rule `archiveDimension` states for archiving an axis.
 *
 * The `security_events` row is written only on the call that actually flips
 * `revoked_at` (`revokeApiKeyRow`'s return value), not on every call: a replay
 * must not fabricate a second revocation event for one act, which would make the
 * audit trail say something happened twice when it happened once.
 */
export async function revokeApiKey(apiKeyId: string, ctx: RequestContext): Promise<ApiKey> {
  await requirePermission(ctx, 'api_keys.write');

  const id = assertFound(apiKeyIdBytes(apiKeyId), API_KEY_RESOURCE);
  const actorUserId = ctx.userId === null ? null : uuidToBuffer(ctx.userId);

  return orgScope(ctx).transaction(async (trx) => {
    assertFound(await selectApiKeyById(trx, id), API_KEY_RESOURCE);

    if (await revokeApiKeyRow(trx, id, new Date())) {
      await insertSecurityEvent(trx, {
        eventType: 'api_key.revoked',
        actorUserId,
        credentialId: id,
      });
    }

    return toApiKey(assertFound(await selectApiKeyById(trx, id), API_KEY_RESOURCE));
  });
}
