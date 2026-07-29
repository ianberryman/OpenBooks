import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { destroyDatabase, initializeDatabase, isDatabaseInitialized } from '../../src/db/index';
import {
  resolveApiKeyIdentity,
  resolveOAuthIdentity,
  resolveSessionIdentity,
} from '../../src/modules/auth';
import { sessionTokenHash } from '../../src/modules/auth/tokens';
import { OWNER_ROLE_ID } from '../../src/modules/orgs';
import type { App, IdentityResolver } from '../../src/transport';
import type { TestDatabase } from '../db';
import { newUuidBuffer, SYSTEM_ROLE_UUIDS, useTestDatabase, uuidToBuffer } from '../db';
import { buildTestApp } from '../transport/harness';
import type { Session } from '../transport/v1-support';
import { authorizedWrite, createAccount, registerUser } from '../transport/v1-support';

/**
 * The M5 security guarantees, as behaviour rather than review items (spec §8, §12;
 * ROADMAP D-53…D-61) — F1/F2 (a token never exceeds its granting user, recomputed
 * live), F4 (revocation is effective on the next request and logged), F5 (the MCP
 * transport refuses exactly what the REST route refuses, role for role), F6 (a
 * propose-only tool lands a draft, never a ledger write), and one F10 read
 * `cross-org.test.ts`'s path-parameter matrix cannot see because its id travels in
 * a query.
 *
 * ## Its own harness, not `useV1App`
 *
 * `test/transport/v1-support.ts` wires only the session resolver — every other
 * enforcement suite authenticates through a cookie, which is all A7/B11 need. F1,
 * F2, F4, and F5 need a bearer OAuth token or an API key on the wire, so this file
 * composes all three resolvers in the exact order `src/entrypoints/api.ts` does —
 * OAuth bearer, then API key, then session cookie — so a request here is
 * authenticated the same way a production request is, not a shortcut this suite
 * invented.
 *
 * ## Why tokens and memberships are inserted directly rather than minted through
 * the RFC flow
 *
 * Exchanging a code for a token needs a registered redirect, a PKCE verifier, a
 * consent POST, and a code exchange — the *mechanics* of D-53's flow, which is
 * `oauth.service.ts`'s own claim to prove and is not what F1/F2/F4 are about. What
 * those criteria need is a live `oauth_tokens` row with a known scope, tied to a
 * known user — so it is inserted directly, `cross-org.test.ts`'s `bankingScene`
 * and `captureScene` giving the precedent for exactly this move: a fixture the app
 * itself could have written (append-only, the identity a real token row has),
 * built without exercising the mechanism that is somebody else's test's subject.
 * Same reasoning for a narrowed-role membership: `db.factories.orgMember` writes
 * the row `acceptInvite` would have written, without the invite/accept round trip
 * — see `test/enforcement/permission-matrix.test.ts`'s own `scene()` for the same
 * shortcut.
 */

function composedIdentity(): IdentityResolver {
  return async (request) => {
    const oauth = await resolveOAuthIdentity(request);
    if (oauth !== null) return oauth;
    const apiKey = await resolveApiKeyIdentity(request);
    if (apiKey !== null) return apiKey;
    return resolveSessionIdentity(request);
  };
}

interface PlatformHarness {
  readonly db: TestDatabase;
  app(): App;
}

function usePlatformApp(): PlatformHarness {
  const db = useTestDatabase();
  let app: App | undefined;

  beforeAll(async () => {
    if (!isDatabaseInitialized()) initializeDatabase(db.appConnectionConfig);
    const built = await buildTestApp({ resolveIdentity: composedIdentity() });
    app = built.app;
  });

  afterAll(async () => {
    await app?.close();
    app = undefined;
    await destroyDatabase();
  });

  return {
    db,
    app: () => {
      if (app === undefined) throw new Error('usePlatformApp() builds in beforeAll.');
      return app;
    },
  };
}

const harness = usePlatformApp();

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/** Registers a third-party client as `owner` and returns its REST and public ids. */
async function issueOAuthClient(
  app: App,
  owner: Session,
  nonce: string,
): Promise<{ readonly id: string; readonly clientId: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/oauth-clients',
    headers: authorizedWrite(owner, `platform-client-${nonce}`),
    payload: {
      name: `Platform Client ${nonce}`,
      redirectUris: ['https://example.invalid/callback'],
    },
  });
  if (response.statusCode !== 201) {
    throw new Error(`oauth client setup failed: ${String(response.statusCode)} ${response.body}`);
  }
  return response.json<{ id: string; clientId: string }>();
}

/** Issues an API key as `owner` and returns the plaintext value. */
async function issueApiKey(
  app: App,
  owner: Session,
  input: { readonly name: string; readonly roleId: string },
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/api-keys',
    headers: authorizedWrite(owner, `platform-key-${input.name}`),
    payload: input,
  });
  if (response.statusCode !== 201) {
    throw new Error(`api key setup failed: ${String(response.statusCode)} ${response.body}`);
  }
  return response.json<{ key: string }>().key;
}

/**
 * Inserts an `oauth_tokens` row directly — see the file header for why this is not
 * minted through the RFC exchange — and returns the plaintext bearer value.
 */
async function mintAccessToken(
  db: TestDatabase,
  input: {
    readonly orgId: string;
    readonly clientRowId: string;
    readonly userId: Buffer;
    readonly scope: string;
    readonly plaintext: string;
  },
): Promise<void> {
  const now = Date.now();
  await db.app
    .insertInto('oauth_tokens')
    .values({
      id: newUuidBuffer(),
      org_id: uuidToBuffer(input.orgId),
      client_id: uuidToBuffer(input.clientRowId),
      user_id: input.userId,
      token_type: 'access',
      key_prefix: input.plaintext.slice(0, 12),
      token_hash: sessionTokenHash(input.plaintext),
      scope: input.scope,
      refresh_token_id: null,
      expires_at: new Date(now + 60 * 60 * 1000),
      revoked_at: null,
      last_used_at: null,
    })
    .execute();
}

interface WireResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/**
 * `GET /v1/auth/me`'s status and body — `permissions` is sorted
 * (`currentPermissions()`'s own sort).
 */
async function permissionsFor(app: App, headers: Record<string, string>): Promise<WireResult> {
  const response = await app.inject({ method: 'GET', url: '/v1/auth/me', headers });
  return { status: response.statusCode, body: response.json<Record<string, unknown>>() };
}

describe('F1/F2 — a token never exceeds its granting user, recomputed live', () => {
  it('resolves the scope∩role intersection, live, on every request', async () => {
    const app = harness.app();
    const owner = await registerUser(app, {
      email: 'f1f2-owner@example.invalid',
      orgName: 'F1F2 Owner',
    });
    const client = await issueOAuthClient(app, owner, 'f1f2');

    // A second member of the owner's org, seeded straight to `bookkeeper` — holds
    // almost the whole catalog (0001_tenancy excludes only org administration), so
    // the token's *scope* is the binding constraint at first, not the role.
    const grantee = await harness.db.factories.user();
    await harness.db.factories.orgMember({
      orgId: uuidToBuffer(owner.orgId),
      userId: grantee.id,
      role: 'bookkeeper',
    });

    // `orgs.write` is a permission `bookkeeper` never holds (0001_tenancy's own
    // exclusion list) — carried in the granted scope from the start, so its absence
    // from the very first read is F1's "a scope naming a permission the role lacks
    // grants nothing," not merely a side effect of the narrowing below.
    const scope = 'accounts.read invoices.read contacts.read orgs.write';
    const token = 'oba_f1f2-test-token-0123456789abcdef';
    await mintAccessToken(harness.db, {
      orgId: owner.orgId,
      clientRowId: client.id,
      userId: grantee.id,
      scope,
      plaintext: token,
    });

    const granted = await permissionsFor(app, bearer(token));
    expect(granted).toEqual({
      status: 200,
      body: expect.objectContaining({
        permissions: ['accounts.read', 'contacts.read', 'invoices.read'],
      }),
    });

    // Narrow the *user's role* — nothing about the token row changes. `ap_only`
    // holds `accounts.read` and `contacts.read` but not `invoices.read` (it is the
    // payables role), so the next resolve must lose exactly that one permission.
    const narrowed = await app.inject({
      method: 'PATCH',
      url: `/v1/members/${grantee.uuid}`,
      headers: authorizedWrite(owner, 'f1f2-narrow'),
      payload: { roleId: SYSTEM_ROLE_UUIDS.apOnly },
    });
    if (narrowed.statusCode !== 200) {
      throw new Error(`role narrowing failed: ${String(narrowed.statusCode)} ${narrowed.body}`);
    }

    // The *same* bearer token, same plaintext, no row in `oauth_tokens` touched —
    // F2's whole claim is that the ceiling moves because the role does, not
    // because anything about the credential was re-issued.
    const afterNarrowing = await permissionsFor(app, bearer(token));
    expect(afterNarrowing).toEqual({
      status: 200,
      body: expect.objectContaining({
        permissions: ['accounts.read', 'contacts.read'],
      }),
    });
  });
});

describe('F4 — revocation is effective on the next request, and logged', () => {
  it('refuses the very next resolve and writes a security_events row', async () => {
    const app = harness.app();
    const owner = await registerUser(app, {
      email: 'f4-owner@example.invalid',
      orgName: 'F4 Owner',
    });
    const client = await issueOAuthClient(app, owner, 'f4');

    const token = 'oba_f4-test-token-0123456789abcdef01';
    await mintAccessToken(harness.db, {
      orgId: owner.orgId,
      clientRowId: client.id,
      userId: uuidToBuffer(owner.userId),
      scope: 'accounts.read',
      plaintext: token,
    });

    const before = await permissionsFor(app, bearer(token));
    expect(before.status).toBe(200);

    // RFC 7009's own wire endpoint, form-encoded — the real revocation path a
    // third-party client library calls, not a shortcut this suite invented (see
    // `oauth-flow.ts`). `revokeToken` never throws (RFC 7009 §2.2: always `200`),
    // so this is not itself the assertion — the *next resolve* is.
    const revokeBody = new URLSearchParams({ token, client_id: client.clientId }).toString();
    const revoked = await app.inject({
      method: 'POST',
      url: '/oauth/revoke',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: revokeBody,
    });
    expect(revoked.statusCode).toBe(200);

    // No parked transaction to prove contention against here (CLAUDE.md: "prove
    // contention where relevant") — D-61's guarantee is about the *next* request on
    // an opaque, database-backed lookup, not about a race with an in-flight one;
    // there is no lock analogous to the period lock for a sequential check to miss.
    const after = await permissionsFor(app, bearer(token));
    expect(after).toEqual({
      status: 401,
      body: expect.objectContaining({
        error: expect.objectContaining({ code: 'unauthenticated' }),
      }),
    });

    const events = await harness.db.app
      .selectFrom('security_events')
      .select(['event_type', 'credential_type'])
      .where('org_id', '=', uuidToBuffer(owner.orgId))
      .where('event_type', '=', 'oauth_token.revoked')
      .execute();
    expect(events).toEqual([{ event_type: 'oauth_token.revoked', credential_type: 'oauth_token' }]);
  });
});

describe('F5 — the MCP transport refuses exactly what the REST route refuses', () => {
  it('refuses a caller lacking the permission on both, allows one holding it on both', async () => {
    const app = harness.app();
    const owner = await registerUser(app, {
      email: 'f5-owner@example.invalid',
      orgName: 'F5 Owner',
    });

    // `ap_only` — the payables role — never holds `invoices.read`; `owner` holds
    // the entire catalog. Both are API keys: no person behind either, so the
    // comparison is purely about the permission the tool and the route each
    // declare (`invoices.read`, `invoicesListTool.permission` and
    // `GET /v1/invoices`'s `RouteDefinition.permission`), never about who is asking.
    const lackingKey = await issueApiKey(app, owner, {
      name: 'F5 lacking key',
      roleId: SYSTEM_ROLE_UUIDS.apOnly,
    });
    const holdingKey = await issueApiKey(app, owner, {
      name: 'F5 holding key',
      roleId: OWNER_ROLE_ID,
    });

    interface McpErrorBody {
      readonly error: { readonly data: { readonly details: { readonly permission: string } } };
    }
    interface RestErrorBody {
      readonly error: { readonly details: { readonly permission: string } };
    }

    const mcpCall = (key: string): Promise<WireResult> =>
      app
        .inject({
          method: 'POST',
          url: '/mcp',
          headers: bearer(key),
          payload: {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'invoices.list', arguments: {} },
          },
        })
        .then((response) => ({
          status: response.statusCode,
          body: response.json<Record<string, unknown>>(),
        }));

    const restCall = (key: string): Promise<WireResult> =>
      app.inject({ method: 'GET', url: '/v1/invoices', headers: bearer(key) }).then((response) => ({
        status: response.statusCode,
        body: response.json<Record<string, unknown>>(),
      }));

    const [mcpRefused, restRefused] = await Promise.all([
      mcpCall(lackingKey),
      restCall(lackingKey),
    ]);
    expect(mcpRefused.status).toBe(403);
    expect(restRefused.status).toBe(403);
    expect((mcpRefused.body as unknown as McpErrorBody).error.data.details.permission).toBe(
      'invoices.read',
    );
    expect((restRefused.body as unknown as RestErrorBody).error.details.permission).toBe(
      'invoices.read',
    );

    const [mcpAllowed, restAllowed] = await Promise.all([
      mcpCall(holdingKey),
      restCall(holdingKey),
    ]);
    expect(mcpAllowed.status).toBe(200);
    expect(restAllowed.status).toBe(200);
  });
});

describe('F6 — a propose-only tool lands a draft, never a ledger write', () => {
  it('journal.propose drafts and never posts, and refuses mode: "execute"', async () => {
    const app = harness.app();
    const owner = await registerUser(app, {
      email: 'f6-owner@example.invalid',
      orgName: 'F6 Owner',
    });
    const cashId = await createAccount(app, owner, {
      code: '1000',
      name: 'Cash',
      type: 'asset',
      normalBalance: 'debit',
    });
    const revenueId = await createAccount(app, owner, {
      code: '4000',
      name: 'Sales',
      type: 'revenue',
      normalBalance: 'credit',
    });

    const propose = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { cookie: owner.cookie },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'journal.propose',
          mode: 'propose',
          arguments: {
            entryDate: '2026-03-31',
            lines: [
              { accountId: cashId, side: 'debit', amount: '150000' },
              { accountId: revenueId, side: 'credit', amount: '150000' },
            ],
          },
        },
      },
    });
    expect(propose.statusCode).toBe(200);
    const proposeBody = propose.json<{ result: { kind: string; proposal: { summary: string } } }>();
    expect(proposeBody.result.kind).toBe('proposed');
    expect(proposeBody.result.proposal.summary).toContain('Drafted a journal entry');

    const orgId = uuidToBuffer(owner.orgId);
    const drafts = await harness.db.app
      .selectFrom('journal_drafts')
      .select('id')
      .where('org_id', '=', orgId)
      .execute();
    expect(drafts).toHaveLength(1);

    const journals = await harness.db.app
      .selectFrom('journals')
      .select('id')
      .where('org_id', '=', orgId)
      .execute();
    expect(journals).toHaveLength(0);

    const execute = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { cookie: owner.cookie },
      payload: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'journal.propose',
          mode: 'execute',
          arguments: {
            entryDate: '2026-03-31',
            lines: [
              { accountId: cashId, side: 'debit', amount: '150000' },
              { accountId: revenueId, side: 'credit', amount: '150000' },
            ],
          },
        },
      },
    });
    expect(execute.statusCode).toBe(400);
    const executeBody = execute.json<{ error: { data: { code: string } } }>();
    expect(executeBody.error.data.code).toBe('validation_failed');

    // Still exactly one draft, no journal: the refused `execute` call landed
    // nothing at all, which is the whole of D-60's "no execute path exists".
    const draftsAfter = await harness.db.app
      .selectFrom('journal_drafts')
      .select('id')
      .where('org_id', '=', orgId)
      .execute();
    expect(draftsAfter).toHaveLength(1);

    const journalsAfter = await harness.db.app
      .selectFrom('journals')
      .select('id')
      .where('org_id', '=', orgId)
      .execute();
    expect(journalsAfter).toHaveLength(0);
  });
});

describe('F10 — a platform read not in the path-parameter matrix', () => {
  it('answers a cross-org client id the same as a nonexistent one', async () => {
    const app = harness.app();
    const owner = await registerUser(app, { email: 'f10-owner@example.invalid', orgName: 'Owner' });
    const stranger = await registerUser(app, {
      email: 'f10-stranger@example.invalid',
      orgName: 'Stranger',
    });
    const client = await issueOAuthClient(app, owner, 'f10');

    const query = (clientId: string): string =>
      '/v1/oauth/authorization-details?' +
      new URLSearchParams({
        responseType: 'code',
        clientId,
        redirectUri: 'https://example.invalid/callback',
        scope: 'accounts.read',
        state: 'xyz',
        codeChallenge: 'a'.repeat(43),
        codeChallengeMethod: 'S256',
      }).toString();

    const crossOrg = await app.inject({
      method: 'GET',
      url: query(client.clientId),
      headers: { cookie: stranger.cookie },
    });
    const nonexistent = await app.inject({
      method: 'GET',
      url: query('oc_does-not-exist'),
      headers: { cookie: stranger.cookie },
    });

    expect(crossOrg.statusCode).toBe(404);
    expect(crossOrg.body).toBe(nonexistent.body);
    expect(crossOrg.headers['content-type']).toBe(nonexistent.headers['content-type']);
    expect(crossOrg.body.includes(client.clientId)).toBe(false);

    // The control: the owner's own call is not a 404, which is what makes the
    // stranger's 404 a statement about ownership rather than a broken path.
    const owned = await app.inject({
      method: 'GET',
      url: query(client.clientId),
      headers: { cookie: owner.cookie },
    });
    expect(owned.statusCode).toBe(200);
  });
});
