import { rawDb } from './client';
import { ambientTransaction } from './transaction-scope';

/**
 * The OAuth authorization server's own sanctioned unauthenticated reads (OB-098;
 * ROADMAP D-53, D-54), for `delivery-lookup.ts`'s exact reason: the token endpoint
 * (`grant_type=authorization_code`, `grant_type=refresh_token`) and the revocation
 * endpoint are RFC 6749/7009 form-encoded requests carrying nothing but a code or a
 * token, and the code or token is what *establishes* which org the request belongs
 * to — there is no session, no `orgId`, and nothing to scope `tenantDb` with until
 * one of these has resolved.
 *
 * `oauth_grants` and `oauth_tokens` are both tenant tables (`tenant-tables.ts`), and
 * every other reader of either goes through `tenantDb(orgId)` once the org is known
 * from one of these two reads — `0010_platform`'s `uq_oauth_grants_code` and
 * `uq_oauth_tokens_hash` are globally unique for exactly this: a code or a token
 * hash names at most one row across every org, so an equality lookup on the hash is
 * safe and sufficient without a scope to narrow it by, the same property
 * `sessions.token_hash` already has.
 *
 * `oauth_clients.client_id` does **not** get a third function here. `authorize` and
 * the consent POST both run with a real session already open (a user is logged in to
 * grant or refuse consent), so a client is always resolved through `tenantDb(ctx)`
 * scoped to the consenting user's own org — see `oauth.repository.ts`. The token and
 * revocation endpoints resolve the client *after* the org is known, by reading the
 * grant's or token's own `client_id` column and re-checking the request's public id
 * against it, rather than by a second unauthenticated client lookup.
 */

export interface OAuthGrantCredentialRow {
  readonly id: Buffer;
  readonly orgId: Buffer;
  readonly clientId: Buffer;
  readonly userId: Buffer;
  readonly redirectUri: string;
  readonly scope: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: string;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}

export async function selectOAuthGrantByCodeHash(
  codeHash: string,
): Promise<OAuthGrantCredentialRow | undefined> {
  const row = await (ambientTransaction() ?? rawDb())
    .selectFrom('oauth_grants')
    .select([
      'id',
      'org_id',
      'client_id',
      'user_id',
      'redirect_uri',
      'scope',
      'code_challenge',
      'code_challenge_method',
      'expires_at',
      'consumed_at',
    ])
    .where('code_hash', '=', codeHash)
    .executeTakeFirst();

  if (row === undefined) return undefined;

  return {
    id: row.id,
    orgId: row.org_id,
    clientId: row.client_id,
    userId: row.user_id,
    redirectUri: row.redirect_uri,
    scope: row.scope,
    codeChallenge: row.code_challenge,
    codeChallengeMethod: row.code_challenge_method,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
  };
}

export interface OAuthTokenCredentialRow {
  readonly id: Buffer;
  readonly orgId: Buffer;
  readonly clientId: Buffer;
  readonly userId: Buffer;
  readonly tokenType: 'access' | 'refresh';
  readonly scope: string;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly lastUsedAt: Date | null;
  readonly refreshTokenId: Buffer | null;
}

export async function selectOAuthTokenByHash(
  tokenHash: string,
): Promise<OAuthTokenCredentialRow | undefined> {
  const row = await (ambientTransaction() ?? rawDb())
    .selectFrom('oauth_tokens')
    .select([
      'id',
      'org_id',
      'client_id',
      'user_id',
      'token_type',
      'scope',
      'expires_at',
      'revoked_at',
      'last_used_at',
      'refresh_token_id',
    ])
    .where('token_hash', '=', tokenHash)
    .executeTakeFirst();

  if (row === undefined) return undefined;

  return {
    id: row.id,
    orgId: row.org_id,
    clientId: row.client_id,
    userId: row.user_id,
    tokenType: row.token_type,
    scope: row.scope,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
    refreshTokenId: row.refresh_token_id,
  };
}
