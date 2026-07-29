import type {
  ConnectedApp,
  ConnectedAppPage,
  OAuthAuthorizeQuery,
  OAuthClient,
  OAuthClientPage,
  OAuthClientWithSecret,
  OAuthConsentDecision,
  OAuthRevocationRequest,
  OAuthTokenError,
  OAuthTokenRequest,
  OAuthTokenResponse,
  RegisterOAuthClientRequest,
} from '@openbooks/shared-types';
import {
  oauthAuthorizeQuerySchema,
  oauthConsentDecisionSchema,
  oauthRevocationRequestSchema,
  oauthTokenRequestSchema,
  registerOAuthClientRequestSchema,
} from '@openbooks/shared-types';

import type { RequestContext } from '../../context';
import type { TenantDatabase } from '../../db';
import {
  bufferToUuid,
  resolvePageLimit,
  selectOAuthGrantByCodeHash,
  selectOAuthTokenByHash,
  tryUuidToBuffer,
  uuidToBuffer,
} from '../../db';
import {
  assertFound,
  NotFoundError,
  parseInput,
  UnauthenticatedError,
  ValidationError,
} from '../../errors';
import { sessionTokenHash } from '../auth/tokens';
import type { PermissionKey } from '../permissions';
import { isPermissionKey, requirePermission } from '../permissions';
import {
  mintAuthorizationCode,
  mintCredential,
  mintPublicClientId,
  verifyPkce,
} from './credentials';
import type { ConnectedAppRow, OAuthClientRow } from './oauth.repository';
import {
  consumeOAuthGrant,
  deactivateOAuthClientRow,
  insertOAuthClient,
  insertOAuthGrant,
  insertOAuthToken,
  insertSecurityEvent,
  OAUTH_CLIENT_RESOURCE,
  orgScope,
  orgScopeOf,
  revokeOAuthConsent,
  revokeOAuthTokenById,
  revokeOAuthTokensForClientUser,
  selectConnectedAppsPage,
  selectOAuthClientById,
  selectOAuthClientByPublicId,
  selectOAuthClientsPage,
  selectOAuthConsent,
  upsertOAuthConsent,
} from './oauth.repository';

/**
 * The OAuth 2.1 authorization server's service layer (OB-098; ROADMAP D-53, D-54,
 * D-61): client registration, the authorize/consent exchange, the token endpoint,
 * and revocation. The bearer identity resolver that reads what this issues lives in
 * `modules/auth/oauth-identity.ts`; the scope∩role narrowing seam it depends on is
 * in `modules/permissions/permissions.service.ts`.
 *
 * ## Two registers, and why the split runs through the middle of this file
 *
 * `registerOAuthClient` through `revokeConnectedApp` are this project's own JSON
 * shapes — camelCase, `requirePermission` first, `NotFoundError`/`ValidationError`
 * on failure, exactly like every other service in `src/modules/`. `exchangeToken`
 * and `revokeToken` are RFC 6749/7009 wire endpoints: snake_case, form-encoded on
 * the wire (OB-104's problem, not this file's), and **must never throw** one of
 * this project's envelope errors — `shared-types/platform/oauth.ts`'s header states
 * why, and the two functions return a typed result the route maps to the RFC
 * status/body instead. Every other function below throws in the ordinary way.
 *
 * ## Why the token/revocation endpoints never read `tenantDb(ctx)`
 *
 * They are called with no session — the caller is the third-party client's own
 * software, presenting a code or a bearer token, not a person who has logged in.
 * There is no `orgId` to scope by until one of those two credentials has been
 * resolved, which is exactly `../../db/oauth-lookup.ts`'s reason to exist:
 * `selectOAuthGrantByCodeHash` and `selectOAuthTokenByHash` are the two pre-org
 * reads, and `orgScopeOf` opens a `TenantDatabase` from the org either one names.
 * `ctx` is accepted on both functions' signatures for the seam's sake (a future
 * caller might have one) but is not read by either.
 */

/**
 * Token lifetimes (RFC 6749 §4.1/§6 conventions). Constants, not configuration —
 * D-61's whole argument for opaque, database-backed tokens over a JWT is that
 * revocation takes effect on the next request regardless of how long a token
 * *would* have lived, so there is no deployment whose correctness depends on a
 * shorter or longer window. `accessTokenTtlSeconds` is also what `expires_in`
 * reports on the wire (RFC 6749 §5.1), so it is named here once rather than
 * restated at the response.
 */
const OAUTH_TOKEN_CONFIG = {
  accessTokenTtlSeconds: 3600,
  refreshTokenTtlSeconds: 2592000,
} as const;

/** The authorization code's lifetime — short, because it crosses the user's browser once. */
const AUTHORIZATION_CODE_TTL_MS = 60 * 1000;

const CLIENT_SECRET_PREFIX = 'obs_';
const ACCESS_TOKEN_PREFIX = 'oba_';
const REFRESH_TOKEN_PREFIX = 'obr_';

// ---------------------------------------------------------------------------
// Client management — this project's own JSON shapes, under `integrations.*`
// ---------------------------------------------------------------------------

/**
 * Registers a third-party client (D-53: admin-registered, never self-service).
 *
 * `createdByUserId` is nullable on the row and, deliberately, here too:
 * `integrations.write` is also held by an API-key context (D-55), which carries no
 * `userId` at all, so a script registering a client is not an error case to guard
 * against — it is the automation actor the permission already admits.
 */
export async function registerOAuthClient(
  input: RegisterOAuthClientRequest,
  ctx: RequestContext,
): Promise<OAuthClientWithSecret> {
  await requirePermission(ctx, 'integrations.write');
  const request = parseInput(registerOAuthClientRequestSchema, input);

  const db = orgScope(ctx);
  const secret = mintCredential(CLIENT_SECRET_PREFIX);
  const createdByUserId = ctx.userId === null ? null : uuidToBuffer(ctx.userId);

  const row = await insertOAuthClient(db, {
    clientId: mintPublicClientId(),
    name: request.name,
    secretPrefix: secret.keyPrefix,
    secretHash: secret.hash,
    redirectUris: request.redirectUris,
    createdByUserId,
  });

  await insertSecurityEvent(db, {
    eventType: 'oauth_client.registered',
    actorUserId: createdByUserId,
    credentialType: 'oauth_client',
    credentialId: row.id,
  });

  return { ...toOAuthClient(row), clientSecret: secret.token };
}

export interface ListOAuthClientsQuery {
  readonly limit?: number;
  readonly cursor?: string;
}

export async function listOAuthClients(
  query: ListOAuthClientsQuery,
  ctx: RequestContext,
): Promise<OAuthClientPage> {
  await requirePermission(ctx, 'integrations.read');
  const limit = resolvePageLimit(query.limit);

  const page = await selectOAuthClientsPage(orgScope(ctx), limit, query.cursor);
  return { items: page.rows.map(toOAuthClient), nextCursor: page.nextCursor };
}

/**
 * `id` is the client's REST resource id (`oauthClientSchema.id`, a UUID) — not the
 * public `client_id` OAuth string, which `revokeConnectedApp` below takes instead.
 * The two differ because the callers differ: an admin managing `/v1/oauth/clients`
 * addresses a row the way every other resource in this codebase is addressed,
 * while a user's "connected apps" list (`connectedAppSchema`) never carries the
 * row id at all — only the public id the OAuth flow itself uses.
 *
 * Deactivating an already-deactivated client is not a conflict — a retry of a
 * deactivation is a retry, matching `deactivateContact`'s note — so this returns
 * the current row unchanged rather than refusing, and logs `security_events` only
 * for the call that actually flipped it.
 */
export async function deactivateOAuthClient(id: string, ctx: RequestContext): Promise<OAuthClient> {
  await requirePermission(ctx, 'integrations.write');

  const db = orgScope(ctx);
  const key = tryUuidToBuffer(id);
  const existing = key === undefined ? undefined : await selectOAuthClientById(db, key);
  const row = assertFound(existing, OAUTH_CLIENT_RESOURCE);

  if (row.deactivatedAt === null) {
    const now = new Date();
    const changed = await deactivateOAuthClientRow(db, row.id, now);
    if (changed) {
      await insertSecurityEvent(db, {
        eventType: 'oauth_client.deactivated',
        actorUserId: ctx.userId === null ? null : uuidToBuffer(ctx.userId),
        credentialType: 'oauth_client',
        credentialId: row.id,
      });
      return toOAuthClient({ ...row, deactivatedAt: now });
    }
  }

  return toOAuthClient(row);
}

function toOAuthClient(row: OAuthClientRow): OAuthClient {
  return {
    id: bufferToUuid(row.id),
    name: row.name,
    clientId: row.clientId,
    redirectUris: [...row.redirectUris],
    createdAt: row.createdAt.toISOString(),
    deactivatedAt: row.deactivatedAt === null ? null : row.deactivatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Authorize + consent — the browser-facing half of the code+PKCE flow
// ---------------------------------------------------------------------------

export interface OAuthAuthorizationDecision {
  readonly client: OAuthClient;
  /** The requested scope, narrowed to recognised permission keys (D-54). */
  readonly scopes: readonly PermissionKey[];
  /** Whether an existing, live consent already covers every requested scope. */
  readonly alreadyConsented: boolean;
}

/**
 * Validates an `authorize` request and reports what the consent screen (OB-105)
 * needs to render. Mints nothing: a `GET` that minted a code would let a prefetch,
 * a browser prerender, or a referrer-following crawler spend a user's authorization
 * code before the user ever saw the consent screen. Only the consent POST
 * (`grantAuthorization`) issues one.
 */
export async function authorizeRequest(
  query: OAuthAuthorizeQuery,
  ctx: RequestContext,
): Promise<OAuthAuthorizationDecision> {
  if (ctx.userId === null) throw new UnauthenticatedError();
  const request = parseInput(oauthAuthorizeQuerySchema, query);

  const db = orgScope(ctx);
  const client = await resolveActiveClient(db, request.clientId);
  requireExactRedirectUri(client, request.redirectUri);
  const scopes = requireKnownScope(request.scope);

  const existing = await selectOAuthConsent(db, client.id, uuidToBuffer(ctx.userId));
  const alreadyConsented =
    existing !== undefined &&
    existing.revokedAt === null &&
    isScopeSuperset(parseScope(existing.scope), scopes);

  return { client: toOAuthClient(client), scopes, alreadyConsented };
}

export type OAuthGrantOutcome =
  | {
      readonly approved: true;
      readonly code: string;
      readonly redirectUri: string;
      readonly state: string;
    }
  | { readonly approved: false; readonly redirectUri: string; readonly state: string };

/**
 * The consent POST. Re-validates everything `authorizeRequest` did — the decision
 * is submitted by the user's own browser, not held server-side between the two
 * requests, so nothing here trusts that an earlier `authorizeRequest` call ever
 * happened for these exact parameters.
 *
 * `approve: false` mints nothing and returns early, before the scope is even
 * parsed: a refusal names no permissions and grants nothing, so there is nothing
 * for D-54's "refused at grant time" check to run against.
 */
export async function grantAuthorization(
  decision: OAuthConsentDecision,
  ctx: RequestContext,
): Promise<OAuthGrantOutcome> {
  if (ctx.userId === null) throw new UnauthenticatedError();
  const request = parseInput(oauthConsentDecisionSchema, decision);

  const db = orgScope(ctx);
  const client = await resolveActiveClient(db, request.clientId);
  requireExactRedirectUri(client, request.redirectUri);

  if (!request.approve) {
    return { approved: false, redirectUri: request.redirectUri, state: request.state };
  }

  const scopes = requireKnownScope(request.scope);
  const userId = uuidToBuffer(ctx.userId);

  const existing = await selectOAuthConsent(db, client.id, userId);
  const unionScope =
    existing === undefined ? scopes : mergeScope(parseScope(existing.scope), scopes);

  const consentId = await upsertOAuthConsent(db, {
    clientId: client.id,
    userId,
    scope: serializeScope(unionScope),
  });

  await insertSecurityEvent(db, {
    eventType: 'oauth_consent.granted',
    actorUserId: userId,
    credentialType: 'oauth_consent',
    credentialId: consentId,
  });

  const minted = mintAuthorizationCode();
  await insertOAuthGrant(db, {
    clientId: client.id,
    userId,
    codeHash: minted.hash,
    redirectUri: request.redirectUri,
    // The *code's* scope is what this authorization requested, not the wider
    // accumulated consent — a client that has previously been granted more must
    // still ask for what it wants this time, matching RFC 6749's "the client MAY
    // request a smaller scope than what was previously granted".
    scope: serializeScope(scopes),
    codeChallenge: request.codeChallenge,
    codeChallengeMethod: request.codeChallengeMethod,
    expiresAt: new Date(Date.now() + AUTHORIZATION_CODE_TTL_MS),
  });

  return {
    approved: true,
    code: minted.code,
    redirectUri: request.redirectUri,
    state: request.state,
  };
}

/** Resolves a client by its public id, within the caller's own org (A7: 404, not 403). */
async function resolveActiveClient(
  db: TenantDatabase,
  publicClientId: string,
): Promise<OAuthClientRow> {
  const client = await selectOAuthClientByPublicId(db, publicClientId);
  if (client === undefined || client.deactivatedAt !== null) {
    throw new NotFoundError(OAUTH_CLIENT_RESOURCE);
  }
  return client;
}

/**
 * OAuth 2.1: exact match only. `redirectUris.includes` is a `===` comparison per
 * entry — no prefix, no query-string-stripped comparison, no scheme-relative
 * matching — because every one of those laxer rules is a documented open-redirect
 * technique the exact-match requirement exists specifically to close.
 */
function requireExactRedirectUri(client: OAuthClientRow, redirectUri: string): void {
  if (!client.redirectUris.includes(redirectUri)) {
    throw new ValidationError('This redirect URI is not registered for this client.', [
      {
        path: 'redirectUri',
        message: 'Must exactly match one of the client’s registered redirect URIs.',
      },
    ]);
  }
}

// ---------------------------------------------------------------------------
// Scope: the permission catalog, parsed off the wire (D-54)
// ---------------------------------------------------------------------------

function parseScope(scope: string): string[] {
  return [...new Set(scope.split(/\s+/).filter((token) => token.length > 0))];
}

function serializeScope(keys: readonly string[]): string {
  return [...new Set(keys)].sort().join(' ');
}

function mergeScope(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])];
}

function isScopeSuperset(granted: readonly string[], requested: readonly PermissionKey[]): boolean {
  const grantedSet = new Set(granted);
  return requested.every((key) => grantedSet.has(key));
}

/**
 * D-54: "A scope naming a key outside the catalog is refused at grant time, not at
 * first use." — the strict half of the split with `resolveOAuthIdentity`'s
 * deliberately lenient read of an *already-granted* scope back off `oauth_tokens`.
 */
function requireKnownScope(scope: string): PermissionKey[] {
  const requested = parseScope(scope);
  const unknown = requested.filter((key) => !isPermissionKey(key));

  if (unknown.length > 0) {
    throw new ValidationError(
      'Scope names a permission outside the catalog.',
      unknown.map((key) => ({ path: 'scope', message: `Unknown permission key: ${key}` })),
    );
  }

  return requested.filter(isPermissionKey);
}

// ---------------------------------------------------------------------------
// Token endpoint — RFC 6749 §5, form-encoded, never the project's envelope
// ---------------------------------------------------------------------------

export interface OAuthTokenSuccessResult {
  readonly status: 200;
  readonly body: OAuthTokenResponse;
}

export interface OAuthTokenErrorResult {
  readonly status: 400 | 401;
  readonly body: OAuthTokenError;
}

export type OAuthTokenResult = OAuthTokenSuccessResult | OAuthTokenErrorResult;

/**
 * The token endpoint's core (RFC 6749 §5): exchanges an authorization code or a
 * refresh token for an access token. `request` is `unknown` and re-validated here
 * with `safeParse` rather than `parseInput` — spec §12's "validate at the service
 * boundary" without the one exception this endpoint has to make, which is that a
 * validation failure becomes `invalid_request` in the RFC's own error shape rather
 * than a thrown `ValidationError`. `ctx` is unused: see the file header for why
 * there is no session to read one from.
 */
export async function exchangeToken(
  request: unknown,
  _ctx?: RequestContext,
): Promise<OAuthTokenResult> {
  const parsed = oauthTokenRequestSchema.safeParse(request);
  if (!parsed.success) {
    return tokenError(400, 'invalid_request', 'The token request is malformed.');
  }

  return parsed.data.grant_type === 'authorization_code'
    ? exchangeAuthorizationCode(parsed.data)
    : exchangeRefreshToken(parsed.data);
}

async function exchangeAuthorizationCode(
  request: Extract<OAuthTokenRequest, { readonly grant_type: 'authorization_code' }>,
): Promise<OAuthTokenResult> {
  const grant = await selectOAuthGrantByCodeHash(sessionTokenHash(request.code));
  if (grant === undefined) {
    return tokenError(400, 'invalid_grant', 'The authorization code is unknown.');
  }

  const now = new Date();
  if (grant.consumedAt !== null) {
    return tokenError(400, 'invalid_grant', 'The authorization code was already used.');
  }
  if (grant.expiresAt.getTime() <= now.getTime()) {
    return tokenError(400, 'invalid_grant', 'The authorization code has expired.');
  }
  if (grant.redirectUri !== request.redirect_uri) {
    return tokenError(400, 'invalid_grant', 'redirect_uri does not match the authorization.');
  }
  if (!verifyPkce(request.code_verifier, grant.codeChallenge)) {
    return tokenError(400, 'invalid_grant', 'code_verifier does not match the authorization.');
  }

  const db = orgScopeOf(grant.orgId);
  const client = await selectOAuthClientById(db, grant.clientId);
  const clientOk =
    client !== undefined && client.deactivatedAt === null && client.clientId === request.client_id;
  if (!clientOk) {
    return tokenError(400, 'invalid_client', 'Unknown or inactive client.');
  }

  return db.transaction(async (trx): Promise<OAuthTokenResult> => {
    // Loses the single-use race the same way a first-time replay does: nothing was
    // written by this attempt, so there is nothing to roll back and no reason to
    // distinguish "raced" from "already spent" in the response.
    const consumed = await consumeOAuthGrant(trx, grant.id, now);
    if (!consumed) {
      return tokenError(400, 'invalid_grant', 'The authorization code was already used.');
    }

    const issued = await mintTokenPair(trx, {
      clientId: grant.clientId,
      userId: grant.userId,
      scope: grant.scope,
    });

    await insertSecurityEvent(trx, {
      eventType: 'oauth_token.issued',
      actorUserId: grant.userId,
      credentialType: 'oauth_token',
      credentialId: issued.accessTokenId,
    });

    return { status: 200, body: issued.response };
  });
}

async function exchangeRefreshToken(
  request: Extract<OAuthTokenRequest, { readonly grant_type: 'refresh_token' }>,
): Promise<OAuthTokenResult> {
  const token = await selectOAuthTokenByHash(sessionTokenHash(request.refresh_token));
  const now = new Date();

  if (token === undefined || token.tokenType !== 'refresh') {
    return tokenError(400, 'invalid_grant', 'The refresh token is unknown.');
  }
  if (token.revokedAt !== null) {
    return tokenError(400, 'invalid_grant', 'The refresh token has been revoked.');
  }
  if (token.expiresAt.getTime() <= now.getTime()) {
    return tokenError(400, 'invalid_grant', 'The refresh token has expired.');
  }

  const db = orgScopeOf(token.orgId);
  const client = await selectOAuthClientById(db, token.clientId);
  const clientOk =
    client !== undefined && client.deactivatedAt === null && client.clientId === request.client_id;
  if (!clientOk) {
    return tokenError(400, 'invalid_client', 'Unknown or inactive client.');
  }

  // Rotation: the presented refresh token is revoked and a fresh pair minted,
  // rather than reusing it. A refresh token that keeps working after being
  // presented is a credential that cannot detect its own replay; rotating it is
  // what turns "the token was stolen and used" into "the legitimate holder's next
  // refresh fails", which is the one signal a stolen opaque credential can raise.
  //
  // The granted *scope* carries forward unchanged — D-54's intersection against
  // the user's current role happens live, in `resolveOAuthIdentity`, every time the
  // token is used, never by editing what a stored row says it was granted.
  return db.transaction(async (trx): Promise<OAuthTokenResult> => {
    const revoked = await revokeOAuthTokenById(trx, token.id, now);
    if (!revoked) {
      return tokenError(400, 'invalid_grant', 'The refresh token has been revoked.');
    }

    const issued = await mintTokenPair(trx, {
      clientId: token.clientId,
      userId: token.userId,
      scope: token.scope,
    });

    await insertSecurityEvent(trx, {
      eventType: 'oauth_token.issued',
      actorUserId: token.userId,
      credentialType: 'oauth_token',
      credentialId: issued.accessTokenId,
    });

    return { status: 200, body: issued.response };
  });
}

interface MintedTokenPair {
  readonly accessTokenId: Buffer;
  readonly response: OAuthTokenResponse;
}

/** Always mints both — RFC 6749 §5.1's `refresh_token` is optional on the wire, not here. */
async function mintTokenPair(
  trx: TenantDatabase,
  input: { readonly clientId: Buffer; readonly userId: Buffer; readonly scope: string },
): Promise<MintedTokenPair> {
  const now = Date.now();

  const refresh = mintCredential(REFRESH_TOKEN_PREFIX);
  const refreshTokenId = await insertOAuthToken(trx, {
    clientId: input.clientId,
    userId: input.userId,
    tokenType: 'refresh',
    keyPrefix: refresh.keyPrefix,
    tokenHash: refresh.hash,
    scope: input.scope,
    refreshTokenId: null,
    expiresAt: new Date(now + OAUTH_TOKEN_CONFIG.refreshTokenTtlSeconds * 1000),
  });

  const access = mintCredential(ACCESS_TOKEN_PREFIX);
  const accessTokenId = await insertOAuthToken(trx, {
    clientId: input.clientId,
    userId: input.userId,
    tokenType: 'access',
    keyPrefix: access.keyPrefix,
    tokenHash: access.hash,
    scope: input.scope,
    refreshTokenId,
    expiresAt: new Date(now + OAUTH_TOKEN_CONFIG.accessTokenTtlSeconds * 1000),
  });

  return {
    accessTokenId,
    response: {
      access_token: access.token,
      token_type: 'Bearer',
      expires_in: OAUTH_TOKEN_CONFIG.accessTokenTtlSeconds,
      refresh_token: refresh.token,
      scope: input.scope,
    },
  };
}

function tokenError(status: 400 | 401, error: string, description: string): OAuthTokenErrorResult {
  return { status, body: { error, error_description: description } };
}

// ---------------------------------------------------------------------------
// Revocation — RFC 7009, idempotent by design
// ---------------------------------------------------------------------------

/**
 * RFC 7009 §2.2: the server responds `200` whether or not `token` named anything,
 * so this returns rather than throws for every way the request can fail to match a
 * live token — an unknown hash, a token belonging to a different client than the
 * one presented, an already-revoked row. None of those is reported back, on
 * purpose: a revocation endpoint that answered differently for "not yours" than for
 * "does not exist" would be a probe an attacker could use to enumerate tokens.
 */
export async function revokeToken(request: unknown, _ctx?: RequestContext): Promise<void> {
  const parsed = oauthRevocationRequestSchema.safeParse(request);
  if (!parsed.success) return;

  await revokeParsedToken(parsed.data);
}

async function revokeParsedToken(request: OAuthRevocationRequest): Promise<void> {
  const row = await selectOAuthTokenByHash(sessionTokenHash(request.token));
  if (row === undefined) return;

  const db = orgScopeOf(row.orgId);
  const client = await selectOAuthClientById(db, row.clientId);
  if (client === undefined || client.clientId !== request.client_id) return;

  const now = new Date();
  await db.transaction(async (trx) => {
    const revoked = await revokeOAuthTokenById(trx, row.id, now);
    if (!revoked) return;

    await insertSecurityEvent(trx, {
      eventType: 'oauth_token.revoked',
      actorUserId: row.userId,
      credentialType: 'oauth_token',
      credentialId: row.id,
    });
  });
}

// ---------------------------------------------------------------------------
// Connected apps — a user's own view of what they have authorized
// ---------------------------------------------------------------------------

export interface ListConnectedAppsQuery {
  readonly limit?: number;
  readonly cursor?: string;
}

export async function listConnectedApps(
  query: ListConnectedAppsQuery,
  ctx: RequestContext,
): Promise<ConnectedAppPage> {
  await requirePermission(ctx, 'integrations.read');
  if (ctx.userId === null) throw new UnauthenticatedError();

  const limit = resolvePageLimit(query.limit);
  const page = await selectConnectedAppsPage(
    orgScope(ctx),
    uuidToBuffer(ctx.userId),
    limit,
    query.cursor,
  );

  return { items: page.rows.map(toConnectedApp), nextCursor: page.nextCursor };
}

function toConnectedApp(row: ConnectedAppRow): ConnectedApp {
  return {
    clientId: row.clientId,
    name: row.name,
    scope: parseScope(row.scope),
    consentedAt: row.consentedAt.toISOString(),
    lastUsedAt: row.lastUsedAt === null ? null : row.lastUsedAt.toISOString(),
  };
}

/**
 * `clientId` is the *public* OAuth id, not a row id — `connectedAppSchema` never
 * carries the consent row's own id, only the field the OAuth flow itself uses, so
 * that is the only handle a caller of this function has. Contrast
 * `deactivateOAuthClient`, whose caller is managing `/v1/oauth/clients` and does
 * have the REST resource id.
 *
 * Gated `integrations.read` "advisory" per OB-098's brief: the actual boundary is
 * that this only ever touches `ctx.userId`'s **own** consent and tokens — there is
 * no parameter naming a different user, so nothing here could reach past it even
 * for a caller who holds the permission.
 *
 * A client the caller never consented to (or already revoked) is a no-op, not a
 * 404: reported existence of *someone else's* consent for a client is exactly what
 * A7 exists to avoid, and a repeat of "revoke" is a retry, matching `logout`'s
 * reasoning for the same shape.
 */
export async function revokeConnectedApp(clientId: string, ctx: RequestContext): Promise<void> {
  await requirePermission(ctx, 'integrations.read');
  if (ctx.userId === null) throw new UnauthenticatedError();

  const db = orgScope(ctx);
  const client = await selectOAuthClientByPublicId(db, clientId);
  if (client === undefined) return;

  const userId = uuidToBuffer(ctx.userId);
  const existing = await selectOAuthConsent(db, client.id, userId);
  if (existing === undefined || existing.revokedAt !== null) return;

  const now = new Date();
  await db.transaction(async (trx) => {
    await revokeOAuthConsent(trx, client.id, userId, now);
    await revokeOAuthTokensForClientUser(trx, client.id, userId, now);
    await insertSecurityEvent(trx, {
      eventType: 'oauth_consent.revoked',
      actorUserId: userId,
      credentialType: 'oauth_consent',
      credentialId: existing.id,
    });
  });
}
