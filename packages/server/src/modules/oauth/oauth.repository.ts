import type { JsonValue } from '../../errors';
import type { RequestContext } from '../../context';
import type { KeysetOrdering, KeysetPage, OrgId, TenantDatabase } from '../../db';
import {
  applyKeyset,
  instantKey,
  newUuidBuffer,
  orgScope as toOrgId,
  tenantDb,
  toKeysetPage,
  uuidKey,
} from '../../db';

/**
 * Data access for the OAuth authorization server's own tables (OB-098; `0010_platform`):
 * `oauth_clients`, `oauth_consents`, `oauth_grants`, `oauth_tokens`, and the
 * `security_events` rows their lifecycle writes.
 *
 * Everything here goes through `tenantDb`, so `org_id = ctx.orgId` (or, for the token
 * and revocation endpoints, `= <org resolved from the presented credential>`) is on
 * every statement before this file adds a predicate — see `../../db/oauth-lookup.ts`
 * for the two pre-org reads that resolve which org a bare code or bearer token
 * belongs to, which is the one thing this file cannot do (it only ever holds an
 * already-scoped `TenantDatabase`).
 *
 * A join across two tenant tables (`selectConnectedAppsPage`'s join onto
 * `oauth_clients`, and its subquery onto `oauth_tokens`) restates the org predicate
 * on the second table explicitly — `onRef`/`whereRef` against `oauth_consents.org_id`
 * — for `allocations.repository.ts`'s reason: `tenantDb` only scopes the table named
 * in `selectFrom`, so a join a caller forgets to re-scope is a join across every
 * org's rows on the joined side.
 */

/** The resource token a miss reports (A7). */
export const OAUTH_CLIENT_RESOURCE = 'oauth_client';

const CLIENT_COLUMNS = [
  'id',
  'client_id',
  'name',
  'secret_prefix',
  'secret_hash',
  'redirect_uris',
  'created_at',
  'deactivated_at',
] as const;

export interface OAuthClientRow {
  readonly id: Buffer;
  readonly clientId: string;
  readonly name: string;
  readonly secretPrefix: string;
  readonly secretHash: string;
  readonly redirectUris: readonly string[];
  readonly createdAt: Date;
  readonly deactivatedAt: Date | null;
}

export interface NewOAuthClientRow {
  readonly clientId: string;
  readonly name: string;
  readonly secretPrefix: string;
  readonly secretHash: string;
  readonly redirectUris: readonly string[];
  /**
   * Nullable, matching the column: `ON DELETE SET NULL` (`0010_platform`) means a
   * client survives its registering admin being removed from the org. `null` here
   * on *insert* is a real state too — `integrations.write` is also held by an
   * API-key context (D-55), which carries no `userId` at all.
   */
  readonly createdByUserId: Buffer | null;
}

/**
 * The org-scoped handle for the current operation — the shape every function below
 * wants, so nothing here takes an `orgId` as a loose parameter (spec §4).
 */
export function orgScope(ctx: RequestContext): TenantDatabase {
  return tenantDb(toOrgId(ctx.orgId));
}

/**
 * The scoped handle for an org already resolved from a pre-org credential lookup
 * (a grant's or a token's own `org_id` column) — the token and revocation
 * endpoints' counterpart to `orgScope`, since neither has a `RequestContext` to read
 * an org from.
 */
export function orgScopeOf(orgId: OrgId): TenantDatabase {
  return tenantDb(orgId);
}

export async function insertOAuthClient(
  db: TenantDatabase,
  input: NewOAuthClientRow,
): Promise<OAuthClientRow> {
  const id = newUuidBuffer();

  await db
    .insertInto('oauth_clients')
    .values({
      id,
      client_id: input.clientId,
      name: input.name,
      secret_prefix: input.secretPrefix,
      secret_hash: input.secretHash,
      redirect_uris: JSON.stringify(input.redirectUris),
      created_by_user_id: input.createdByUserId,
      deactivated_at: null,
    })
    .execute();

  return toOAuthClientRow(
    await db
      .selectFrom('oauth_clients')
      .select(CLIENT_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirstOrThrow(),
  );
}

export async function selectOAuthClientById(
  db: TenantDatabase,
  id: Buffer,
): Promise<OAuthClientRow | undefined> {
  const row = await db
    .selectFrom('oauth_clients')
    .select(CLIENT_COLUMNS)
    .where('id', '=', id)
    .executeTakeFirst();

  return row === undefined ? undefined : toOAuthClientRow(row);
}

/**
 * Resolves a client by its *public* id, within the caller's own org.
 *
 * Used by the consent flow (`authorizeRequest`, `grantAuthorization`), which always
 * runs with a real session — the user granting or refusing consent is a member of
 * the org the client was registered in, so this is an ordinary `tenantDb` read and
 * not one of the two pre-org lookups in `../../db/oauth-lookup.ts`. A client
 * registered by a different org and named by id here is invisible, the same A7
 * miss a nonexistent one produces.
 */
export async function selectOAuthClientByPublicId(
  db: TenantDatabase,
  clientId: string,
): Promise<OAuthClientRow | undefined> {
  const row = await db
    .selectFrom('oauth_clients')
    .select(CLIENT_COLUMNS)
    .where('client_id', '=', clientId)
    .executeTakeFirst();

  return row === undefined ? undefined : toOAuthClientRow(row);
}

const CLIENT_KEYSET: KeysetOrdering<OAuthClientRow> = [
  instantKey('oauth_clients.created_at', (row) => row.createdAt),
  uuidKey('oauth_clients.id', (row) => row.id),
];

export async function selectOAuthClientsPage(
  db: TenantDatabase,
  limit: number,
  cursor: string | undefined,
): Promise<KeysetPage<OAuthClientRow>> {
  const query = db.selectFrom('oauth_clients').select(CLIENT_COLUMNS);

  const rows = await applyKeyset(query, CLIENT_KEYSET, limit, cursor).execute();
  const page = toKeysetPage(rows.map(toOAuthClientRow), CLIENT_KEYSET, limit);
  return page;
}

/** `true` if the client was active and this call is what deactivated it. */
export async function deactivateOAuthClientRow(
  db: TenantDatabase,
  id: Buffer,
  at: Date,
): Promise<boolean> {
  const result = await db
    .updateTable('oauth_clients')
    .set({ deactivated_at: at })
    .where('id', '=', id)
    .where('deactivated_at', 'is', null)
    .executeTakeFirst();

  return Number(result.numUpdatedRows) === 1;
}

function toOAuthClientRow(row: {
  readonly id: Buffer;
  readonly client_id: string;
  readonly name: string;
  readonly secret_prefix: string;
  readonly secret_hash: string;
  readonly redirect_uris: unknown;
  readonly created_at: Date;
  readonly deactivated_at: Date | null;
}): OAuthClientRow {
  return {
    id: row.id,
    clientId: row.client_id,
    name: row.name,
    secretPrefix: row.secret_prefix,
    secretHash: row.secret_hash,
    redirectUris: toRedirectUris(row.redirect_uris),
    createdAt: row.created_at,
    deactivatedAt: row.deactivated_at,
  };
}

/**
 * `redirect_uris` is `JSON NOT NULL`, written by `insertOAuthClient` above and
 * nowhere else, so a value that is not a string array here is this process's own
 * write having gone wrong rather than anything a caller sent — mysql2 has already
 * parsed the column by the time Kysely hands it back (`Json`'s select type is
 * `JsonValue`, matching `idempotency/response.ts`'s `readStoredResponseBody`).
 */
function toRedirectUris(value: unknown): readonly string[] {
  if (Array.isArray(value) && value.every((item): item is string => typeof item === 'string')) {
    return value;
  }
  throw new TypeError('oauth_clients.redirect_uris did not hold a JSON array of strings.');
}

// ---------------------------------------------------------------------------
// oauth_consents
// ---------------------------------------------------------------------------

export interface OAuthConsentRow {
  readonly id: Buffer;
  readonly clientId: Buffer;
  readonly userId: Buffer;
  readonly scope: string;
  readonly createdAt: Date;
  readonly revokedAt: Date | null;
}

/**
 * The caller's existing consent for this client, live or revoked — the service
 * branches on `revokedAt` because re-consenting after a revocation is a legitimate
 * re-grant, not blocked state.
 */
export async function selectOAuthConsent(
  db: TenantDatabase,
  clientId: Buffer,
  userId: Buffer,
): Promise<OAuthConsentRow | undefined> {
  const row = await db
    .selectFrom('oauth_consents')
    .select(['id', 'client_id', 'user_id', 'scope', 'created_at', 'revoked_at'])
    .where('client_id', '=', clientId)
    .where('user_id', '=', userId)
    .executeTakeFirst();

  if (row === undefined) return undefined;

  return {
    id: row.id,
    clientId: row.client_id,
    userId: row.user_id,
    scope: row.scope,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

/**
 * Writes the caller's full current consent for a client — the scope this call is
 * given is what the row ends up holding, `revoked_at` cleared. The service computes
 * the *union* with whatever the row already held before calling this (`0010_platform`:
 * "the consent screen always shows and grants the client's full current request, not
 * a delta"), so this function stays a mechanical upsert with no policy of its own.
 *
 * Returns the row's id. `ON DUPLICATE KEY UPDATE` leaves an existing row's id
 * untouched — only a fresh insert gets the id generated here — so the id this
 * returns is read back rather than assumed, which is what lets the caller log the
 * *actual* consent row against `security_events` regardless of which branch fired.
 */
export async function upsertOAuthConsent(
  db: TenantDatabase,
  input: { readonly clientId: Buffer; readonly userId: Buffer; readonly scope: string },
): Promise<Buffer> {
  await db
    .insertInto('oauth_consents')
    .values({
      id: newUuidBuffer(),
      client_id: input.clientId,
      user_id: input.userId,
      scope: input.scope,
      revoked_at: null,
    })
    .onDuplicateKeyUpdate({ scope: input.scope, revoked_at: null })
    .execute();

  const row = await db
    .selectFrom('oauth_consents')
    .select('id')
    .where('client_id', '=', input.clientId)
    .where('user_id', '=', input.userId)
    .executeTakeFirstOrThrow();

  return row.id;
}

export async function revokeOAuthConsent(
  db: TenantDatabase,
  clientId: Buffer,
  userId: Buffer,
  at: Date,
): Promise<void> {
  await db
    .updateTable('oauth_consents')
    .set({ revoked_at: at })
    .where('client_id', '=', clientId)
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .execute();
}

// ---------------------------------------------------------------------------
// oauth_grants — authorization codes
// ---------------------------------------------------------------------------

export interface NewOAuthGrantRow {
  readonly clientId: Buffer;
  readonly userId: Buffer;
  readonly codeHash: string;
  readonly redirectUri: string;
  readonly scope: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: string;
  readonly expiresAt: Date;
}

export async function insertOAuthGrant(db: TenantDatabase, input: NewOAuthGrantRow): Promise<void> {
  await db
    .insertInto('oauth_grants')
    .values({
      id: newUuidBuffer(),
      client_id: input.clientId,
      user_id: input.userId,
      code_hash: input.codeHash,
      redirect_uri: input.redirectUri,
      scope: input.scope,
      code_challenge: input.codeChallenge,
      code_challenge_method: input.codeChallengeMethod,
      expires_at: input.expiresAt,
      consumed_at: null,
    })
    .execute();
}

/**
 * Single-use consumption, atomically: the `WHERE consumed_at IS NULL` is the whole
 * guarantee, the same shape `completeClaim` (`modules/idempotency/service.ts`) and
 * `revokeSessionByTokenHash` already use — a second exchange of the same code loses
 * the race against `oauth_grants`' own row rather than against application logic,
 * and `numUpdatedRows === 0` is what tells `exchangeToken` the code was already
 * spent (or never existed in this org) without a second query.
 */
export async function consumeOAuthGrant(
  db: TenantDatabase,
  id: Buffer,
  at: Date,
): Promise<boolean> {
  const result = await db
    .updateTable('oauth_grants')
    .set({ consumed_at: at })
    .where('id', '=', id)
    .where('consumed_at', 'is', null)
    .executeTakeFirst();

  return Number(result.numUpdatedRows) === 1;
}

// ---------------------------------------------------------------------------
// oauth_tokens — access and refresh
// ---------------------------------------------------------------------------

export interface NewOAuthTokenRow {
  readonly clientId: Buffer;
  readonly userId: Buffer;
  readonly tokenType: 'access' | 'refresh';
  readonly keyPrefix: string;
  readonly tokenHash: string;
  readonly scope: string;
  readonly refreshTokenId: Buffer | null;
  readonly expiresAt: Date;
}

export async function insertOAuthToken(
  db: TenantDatabase,
  input: NewOAuthTokenRow,
): Promise<Buffer> {
  const id = newUuidBuffer();

  await db
    .insertInto('oauth_tokens')
    .values({
      id,
      client_id: input.clientId,
      user_id: input.userId,
      token_type: input.tokenType,
      key_prefix: input.keyPrefix,
      token_hash: input.tokenHash,
      scope: input.scope,
      refresh_token_id: input.refreshTokenId,
      expires_at: input.expiresAt,
      revoked_at: null,
      last_used_at: null,
    })
    .execute();

  return id;
}

/** `true` only if this call is what revoked it — an already-revoked token is a no-op. */
export async function revokeOAuthTokenById(
  db: TenantDatabase,
  id: Buffer,
  at: Date,
): Promise<boolean> {
  const result = await db
    .updateTable('oauth_tokens')
    .set({ revoked_at: at })
    .where('id', '=', id)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();

  return Number(result.numUpdatedRows) === 1;
}

/** Every live token this user holds for this client — `revokeConnectedApp`'s write. */
export async function revokeOAuthTokensForClientUser(
  db: TenantDatabase,
  clientId: Buffer,
  userId: Buffer,
  at: Date,
): Promise<void> {
  await db
    .updateTable('oauth_tokens')
    .set({ revoked_at: at })
    .where('client_id', '=', clientId)
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .execute();
}

/**
 * Best-effort: the caller (`resolveOAuthIdentity`) does not let this failing block
 * authentication, and does not re-throttle it beyond what it already decided from
 * the credential row it read.
 */
export async function touchOAuthTokenLastUsed(
  db: TenantDatabase,
  id: Buffer,
  at: Date,
): Promise<void> {
  await db.updateTable('oauth_tokens').set({ last_used_at: at }).where('id', '=', id).execute();
}

// ---------------------------------------------------------------------------
// Connected apps — a user's own view of what they have authorized
// ---------------------------------------------------------------------------

interface ConnectedAppQueryRow {
  readonly consent_id: Buffer;
  readonly client_public_id: string;
  readonly name: string;
  readonly scope: string;
  readonly created_at: Date;
  readonly last_used_at: Date | null;
}

export interface ConnectedAppRow {
  readonly clientId: string;
  readonly name: string;
  readonly scope: string;
  readonly consentedAt: Date;
  readonly lastUsedAt: Date | null;
}

const CONNECTED_APP_KEYSET: KeysetOrdering<ConnectedAppQueryRow> = [
  instantKey('oauth_consents.created_at', (row) => row.created_at),
  uuidKey('oauth_consents.id', (row) => row.consent_id),
];

/**
 * The clients `userId` has live (non-revoked) consent for, each with the most
 * recent `last_used_at` across every access token this user holds for that client.
 *
 * The `last_used_at` aggregate is a scalar subquery rather than a `LEFT JOIN` plus
 * `GROUP BY`: a join would multiply one consent row across every token the user has
 * ever been issued for that client, which `GROUP BY` would then have to collapse
 * back — correct, but a second thing to get right for no benefit over a subquery
 * that never produces the extra rows to begin with. Both the join onto
 * `oauth_clients` and the subquery onto `oauth_tokens` restate
 * `= oauth_consents.org_id` explicitly, for the reason at the top of this file.
 */
export async function selectConnectedAppsPage(
  db: TenantDatabase,
  userId: Buffer,
  limit: number,
  cursor: string | undefined,
): Promise<KeysetPage<ConnectedAppRow>> {
  const query = db
    .selectFrom('oauth_consents')
    .innerJoin('oauth_clients', (join) =>
      join
        .onRef('oauth_clients.id', '=', 'oauth_consents.client_id')
        .onRef('oauth_clients.org_id', '=', 'oauth_consents.org_id'),
    )
    .select([
      'oauth_consents.id as consent_id',
      'oauth_consents.scope',
      'oauth_consents.created_at',
      'oauth_clients.client_id as client_public_id',
      'oauth_clients.name',
    ])
    .select((eb) =>
      eb
        .selectFrom('oauth_tokens')
        .select((inner) => inner.fn.max('oauth_tokens.last_used_at').as('last_used_at'))
        .whereRef('oauth_tokens.client_id', '=', 'oauth_consents.client_id')
        .whereRef('oauth_tokens.user_id', '=', 'oauth_consents.user_id')
        .whereRef('oauth_tokens.org_id', '=', 'oauth_consents.org_id')
        .where('oauth_tokens.token_type', '=', 'access')
        .as('last_used_at'),
    )
    .where('oauth_consents.user_id', '=', userId)
    .where('oauth_consents.revoked_at', 'is', null);

  const rows = await applyKeyset(query, CONNECTED_APP_KEYSET, limit, cursor).execute();
  const page = toKeysetPage(rows, CONNECTED_APP_KEYSET, limit);

  return {
    rows: page.rows.map((row) => ({
      clientId: row.client_public_id,
      name: row.name,
      scope: row.scope,
      consentedAt: row.created_at,
      lastUsedAt: row.last_used_at,
    })),
    nextCursor: page.nextCursor,
  };
}

// ---------------------------------------------------------------------------
// security_events — D-61's append-only issuance/consent/revocation audit
// ---------------------------------------------------------------------------

export type SecurityEventCredentialType = 'oauth_client' | 'oauth_consent' | 'oauth_token';

export interface NewSecurityEventRow {
  readonly eventType: string;
  /** Null for a system-initiated event (an expiry sweep); never null for a user act. */
  readonly actorUserId: Buffer | null;
  readonly credentialType: SecurityEventCredentialType;
  readonly credentialId: Buffer;
  readonly detail?: JsonValue;
}

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
      credential_type: input.credentialType,
      credential_id: input.credentialId,
      detail: input.detail === undefined ? null : JSON.stringify(input.detail),
    })
    .execute();
}
