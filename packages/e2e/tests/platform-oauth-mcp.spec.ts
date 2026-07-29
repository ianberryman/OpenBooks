import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

import { chartByCode } from './support/banking';
import { currentMonth, newRegistration } from './support/books';

/**
 * The M5 platform narrative (OB-108; ROADMAP D-26) — the one test that proves the platform
 * surfaces (OAuth 2.1 + PKCE, MCP, the agent review queue, the change feed, `external_refs`)
 * compose into a single story rather than five independently-correct pieces: register a
 * client, authorize it against a scope, have an agent propose an entry over MCP, have a
 * human approve it in the review queue, and correlate the resulting journal back through
 * `external_refs`.
 *
 * The one browsing human in this story registers the OAuth client (`integrations.write`),
 * grants it consent (their own session), and later reviews the proposal it produced
 * (`agents.review` + `journals.post`) — the seeded Owner role holds the whole catalog
 * (`0001_tenancy.ts`), so one registration is enough to play every part.
 *
 * ## `page` versus `request`, and why each stage is which
 *
 * Register/sign-in, applying the starter chart, and approving the proposal are the human's
 * own screens, so they run through `page` — the same "prove the screen" argument every other
 * narrative in this directory makes. Registering the OAuth client is a step this project
 * offers two doors for (`/oauth-clients` or `POST /v1/oauth-clients`); it goes through the API
 * here because `oauth-clients.test.tsx` already proves the screen renders the secret
 * exactly once, and a second browser proof of the same dialog would not add assurance to a
 * narrative about the seam *between* surfaces. Authorize, consent, the token exchange, and
 * the MCP call are all `request`: PKCE and a JSON-RPC body are exactly the "genuinely awkward
 * in a browser" case this file's own brief calls out, and — RFC 6749 wire shapes carrying no
 * this-project envelope — none of the four has a typed client method to call through anyway
 * (`oauth-flow.ts`'s own header: every one of them is `{ hide: true }`).
 *
 * ## Why the OAuth/MCP calls dial the API origin directly, bypassing the web dev proxy
 *
 * `vite.config.ts`'s dev proxy forwards exactly four prefixes — `/v1`, `/health`, `/public`,
 * `/artifacts` — and no rule for `/oauth` or `/mcp`. A relative request from `page.request`
 * (bound to `playwright.config.ts`'s `WEB_ORIGIN`) would not 404 there, it would hit Vite's
 * SPA fallback and get back `index.html` with a `200` — a client-side JSON-parse failure
 * naming neither the path nor the missing rule, exactly the failure mode `vite.config.ts`'s
 * own comments describe for `/health`/`/public`/`/artifacts`. This is also the more faithful
 * shape for what this narrative is actually proving: a real OAuth client and a real MCP
 * caller are a third party talking to the API directly, never through this app's own
 * dev-only proxy (in a hosted deployment the API and the SPA are the same origin, per that
 * same file's comment — the split into two ports exists only so `yarn dev` and this suite do
 * not collide, `playwright.config.ts`'s own header). `API_ORIGIN` below is `playwright.
 * config.ts`'s `API_PORT` restated, for the same "no `process.env` outside `src/config/`,
 * no suite whose ports depend on a developer's shell" reason that file gives for its own
 * literals — reached over `localhost` rather than the `127.0.0.1` the API actually binds to
 * (`playwright.config.ts`'s `stackEnv.HTTP_HOST`), because the session cookie the register
 * step sets is host-only for whatever host the browser saw, which is `localhost`
 * (`WEB_ORIGIN`) — `cookie.ts`'s own note that a deployment which sets no `cookieDomain` (this
 * stack sets none) "gets host-only scoping from the browser's default anyway." Cookies are
 * never port-scoped, so `http://localhost:3110` — a different port on the *same* host —
 * still carries it, letting `authorize`/`consent` see the browsing human's session without
 * ever touching `vite.config.ts`. `token` and `/mcp` need no cookie at all (bearer- and
 * code-authenticated respectively) but are dialed the same way for one less thing to track.
 *
 * ## What this narrative does not claim
 *
 * **No change-feed event results from this posting, and the change-feed step says so rather
 * than assuming otherwise.** `emitEvent` (`modules/events/outbox.ts`) is called from exactly
 * four places — `payments.service.ts`, `ar-documents.service.ts`, `bills.service.ts`,
 * `reconciliation.service.ts` — never from `modules/ledger/posting.service.ts` or
 * `modules/drafts`/`modules/agents`. `JournalPostedV1`/`JournalReversedV1` are declared in
 * `plugin-api`'s event union but, as of this ticket, nothing publishes either: a manual
 * journal post — typed by hand or, as here, proposed by an agent and approved by a human —
 * reaches the ledger without ever writing an `event_log` row. So this narrative proves the
 * change feed is reachable, correctly scoped, and shaped the way `changeFeedPageSchema`
 * promises, and stops short of asserting an event this system does not yet emit — the same
 * discipline `recurring-and-dunning.spec.ts`'s header applies to a materialisation sweep with
 * no HTTP-observable "done" signal. The posted journal's id is instead read directly off the
 * network response the review-queue's own "Approve and post" button produces
 * (`page.waitForResponse`), which is what makes the `external_refs` correlation in the last
 * step possible regardless.
 *
 * This also does not exercise `refresh_token`, `/oauth/revoke`, the `alreadyConsented`
 * return-trip branch, or the `/oauth-clients`/`/connected-apps` screens themselves — each has
 * its own component test, and D-26 is spent on the seam none of those cover.
 *
 * `oauth-consent.tsx`'s own header flags a "known gap" — that `/oauth/consent` had no
 * form-urlencoded parser and a native form post would fail before `grantAuthorization` ever
 * ran. Reading `oauth-flow.ts` as it stands today, `consent`, `token`, and `revoke` are all
 * registered on the *same* child Fastify instance that adds that parser, so the gap that
 * comment describes reads as already closed — but this narrative drives the consent decision
 * over `request` with an explicit `application/x-www-form-urlencoded` body (see the PKCE
 * section below), not by loading the React screen and clicking its own buttons, so it cannot
 * be the thing that proves that comment stale. Flagged for the orchestrator rather than
 * silently relied upon.
 */

/**
 * `playwright.config.ts`'s `API_PORT`, dialed over `localhost` rather than the `127.0.0.1`
 * the API process actually binds — see the file header for why that hostname is what makes
 * the session cookie travel to a route `vite.config.ts` does not proxy.
 */
const API_ORIGIN = 'http://localhost:3110';

/**
 * A redirect URI this client is registered for and the one this narrative reads a code off
 * of — never dialed. A real agent would be a loopback listener on some local port; this test
 * only ever inspects the `Location` header RFC 6749 §4.1.2 says the authorization server
 * sends there, so an unreachable port is exactly as good as a live one and does not risk
 * colliding with anything else `playwright.config.ts` binds (`API_PORT` 3110, `WEB_PORT`
 * 5183, or a developer's own `yarn dev` on 5173/3100).
 */
const AGENT_REDIRECT_URI = 'http://127.0.0.1:8743/callback';

const CLIENT_NAME = 'Ledger Agent';
const PROPOSAL_MEMO = 'Agent-proposed retainer settlement (OB-108)';
/** Minor units (D-13): $500.00, split evenly so the two-line draft balances by construction. */
const LINE_AMOUNT = '50000';

/** `Idempotency-Key`, lower-cased as `openapi.json` names it — `banking.ts`'s own helper. */
function writeHeaders(): Record<string, string> {
  return { 'idempotency-key': randomUUID() };
}

interface OAuthClientWithSecret {
  readonly id: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

interface OAuthTokenResponse {
  readonly access_token: string;
  readonly token_type: string;
  readonly scope: string;
}

interface McpToolCallResponse {
  readonly result?: { readonly kind: string; readonly proposal?: { readonly summary: string } };
  readonly error?: { readonly message: string };
}

interface PostedJournalResponse {
  readonly journalId: string;
}

interface ChangeFeedEvent {
  readonly position: string;
  readonly name: string;
  readonly payload: Record<string, unknown>;
}

interface ChangeFeedPage {
  readonly events: readonly ChangeFeedEvent[];
  readonly nextCursor: string | null;
}

interface ExternalRef {
  readonly id: string;
  readonly entityId: string;
}

/** `trialBalanceSchema`'s two totals — minor-units strings (D-13), narrowed to what this
 * narrative reads: whether anything has posted yet. */
interface TrialBalanceTotals {
  readonly totalDebits: string;
  readonly totalCredits: string;
}

test('a client is registered, authorized over PKCE, an agent proposes over MCP, a human approves it, and the posting is correlated via external_refs', async ({
  page,
}) => {
  const registration = newRegistration();
  const month = currentMonth();
  const todayIso = month.day(new Date().getDate());

  let client: OAuthClientWithSecret;
  let authorizationCode: string;
  let accessToken: string;
  let checkingAccountId: string;
  let revenueAccountId: string;
  let journalId: string;

  await test.step('register, which creates the login and the first organization together', async () => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Create an account instead' }).click();

    await page.getByLabel('Your name').fill(registration.displayName);
    await page.getByLabel('Email').fill(registration.email);
    await page.getByLabel('Password').fill(registration.password);
    await page.getByLabel('Organization name').fill(registration.orgName);
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Chart of accounts' })).toBeVisible();
  });

  await test.step('apply the starter chart, for the two accounts the proposed entry will post to', async () => {
    // D-23: a fresh org holds no accounts until this is opted into by hand — the same wall
    // every other narrative in this directory hits first.
    await expect(page.getByText('This organization has no accounts yet.')).toBeVisible();

    await page.getByRole('button', { name: 'Apply a starter chart' }).click();
    await page.getByRole('radio', { name: /General small business/ }).check();
    await page.getByRole('button', { name: 'Apply', exact: true }).click();

    await expect(page.getByText('that is the whole chart')).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Service revenue' })).toBeVisible();

    const chart = await chartByCode(page.request);
    checkingAccountId = chart.get('1010') ?? '';
    revenueAccountId = chart.get('4020') ?? '';
    const chartHas = (code: string, id: string): void => {
      expect(id, `account ${code} missing from the starter chart`).not.toBe('');
    };
    chartHas('1010', checkingAccountId);
    chartHas('4020', revenueAccountId);
  });

  await test.step('generate the fiscal year — nothing can be posted before this (D-17)', async () => {
    // The same wall `month-of-books.spec.ts` and `banking.spec.ts` hit first: `journals.
    // period_id` is `NOT NULL`, and generation is explicit, never a side effect of posting.
    // Skipping this step would not fail until the review-queue approval, further down, tries
    // to post `todayIso` into a period that does not exist — this is the step that makes
    // that failure legible instead.
    await page.getByRole('link', { name: 'Settings' }).click();
    const periods = page.getByRole('region', { name: 'Fiscal periods' });

    await periods.getByRole('button', { name: 'Generate 12 periods' }).click();
    await expect(periods.getByText('Generated 12 periods')).toBeVisible();
    await expect(periods.getByRole('cell', { name: month.periodName })).toBeVisible();
  });

  await test.step('register an OAuth client for the agent to authenticate as (integrations.write)', async () => {
    // Through the API rather than the `/oauth-clients` screen — see the file header for why.
    const response = await page.request.post('/v1/oauth-clients', {
      headers: writeHeaders(),
      data: { name: CLIENT_NAME, redirectUris: [AGENT_REDIRECT_URI] },
    });
    expect(response.status(), `POST /v1/oauth-clients → ${String(response.status())}`).toBe(201);
    client = (await response.json()) as OAuthClientWithSecret;
    expect(client.clientId.length).toBeGreaterThan(0);
    expect(client.clientSecret.length).toBeGreaterThan(0);
  });

  // PKCE (RFC 7636), S256 — the one cryptographic step. `verifyPkce` (`oauth/credentials.ts`)
  // hashes the verifier as `ascii`; `codeVerifier` is base64url, a strict subset of ASCII, so
  // this matches the server's own computation rather than merely producing *a* valid pair.
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
  const state = randomUUID();
  // The one scope the agent's write actually needs — `journal.propose`'s handler requires
  // `journals.post`, and D-54 intersects the granted scope with the user's live role on
  // every call, so a token minted without it could never call the one tool this test drives.
  const scope = 'journals.post';

  await test.step('authorize the client with PKCE and approve on the consent decision (the user’s own session)', async () => {
    // RFC 6749's own snake_case, exactly what a third-party client's redirect would send.
    const authorizeQuery = new URLSearchParams({
      response_type: 'code',
      client_id: client.clientId,
      redirect_uri: AGENT_REDIRECT_URI,
      scope,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    // Mints nothing (`authorizeRequest`'s own header) — this is validation only, and its one
    // observable effect is the redirect to the consent screen `oauth-flow.ts` forwards the
    // same query onto, verbatim.
    const authorizeResponse = await page.request.get(
      `${API_ORIGIN}/oauth/authorize?${authorizeQuery.toString()}`,
      { maxRedirects: 0 },
    );
    expect(authorizeResponse.status(), 'GET /oauth/authorize did not redirect').toBe(302);
    const consentLocation = authorizeResponse.headers()['location'] ?? '';
    expect(consentLocation.startsWith('/oauth/consent?')).toBe(true);

    // The consent decision itself: `oauthConsentDecisionSchema`'s own camelCase, form-encoded
    // — the same shape the React screen's native `<form>` posts (`oauth-consent.tsx`), which
    // is why this is a `form` body and not JSON even though nothing here loads that screen.
    const consentResponse = await page.request.post(`${API_ORIGIN}/oauth/consent`, {
      form: {
        responseType: 'code',
        clientId: client.clientId,
        redirectUri: AGENT_REDIRECT_URI,
        scope,
        state,
        codeChallenge: codeChallenge,
        codeChallengeMethod: 'S256',
        approve: 'true',
      },
      maxRedirects: 0,
    });
    expect(consentResponse.status(), 'POST /oauth/consent did not redirect').toBe(302);
    const grantLocation = consentResponse.headers()['location'];
    expect(grantLocation, 'no Location header on the 302 from /oauth/consent').toBeTruthy();

    const redirectLocation = new URL(grantLocation ?? '');
    expect(redirectLocation.origin + redirectLocation.pathname).toBe(AGENT_REDIRECT_URI);
    expect(redirectLocation.searchParams.get('state')).toBe(state);

    const code = redirectLocation.searchParams.get('code');
    expect(code, 'no `code` on the consent redirect').not.toBeNull();
    authorizationCode = code ?? '';
  });

  await test.step('exchange the code for an access token (RFC 6749 §5, form-encoded)', async () => {
    const tokenResponse = await page.request.post(`${API_ORIGIN}/oauth/token`, {
      form: {
        grant_type: 'authorization_code',
        code: authorizationCode,
        redirect_uri: AGENT_REDIRECT_URI,
        client_id: client.clientId,
        code_verifier: codeVerifier,
      },
    });
    expect(
      tokenResponse.ok(),
      `POST /oauth/token → ${String(tokenResponse.status())}`,
    ).toBeTruthy();
    const token = (await tokenResponse.json()) as OAuthTokenResponse;
    expect(token.token_type).toBe('Bearer');
    expect(token.scope).toBe(scope);
    accessToken = token.access_token;
  });

  await test.step('the agent proposes a journal entry over MCP — nothing posts yet (D-60)', async () => {
    const mcpResponse = await page.request.post(`${API_ORIGIN}/mcp`, {
      headers: { authorization: `Bearer ${accessToken}` },
      data: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'journal.propose',
          mode: 'propose',
          arguments: {
            entryDate: todayIso,
            memo: PROPOSAL_MEMO,
            lines: [
              { accountId: checkingAccountId, side: 'debit', amount: LINE_AMOUNT },
              { accountId: revenueAccountId, side: 'credit', amount: LINE_AMOUNT },
            ],
          },
        },
      },
    });
    expect(mcpResponse.ok(), `POST /mcp → ${String(mcpResponse.status())}`).toBeTruthy();
    const body = (await mcpResponse.json()) as McpToolCallResponse;
    expect(body.error).toBeUndefined();
    expect(body.result?.kind).toBe('proposed');

    // The one thing D-60 promises: an agent write never reaches the ledger by itself. The
    // trial balance is the cheapest total-order proof available — a balanced posting would
    // move it, and a draft that is proposed but not yet approved must not.
    const trialBalanceBefore = await page.request.get('/v1/reports/trial-balance');
    expect(trialBalanceBefore.ok()).toBeTruthy();
    const totals = (await trialBalanceBefore.json()) as TrialBalanceTotals;
    expect(totals.totalDebits).toBe('0');
    expect(totals.totalCredits).toBe('0');
  });

  await test.step('a human reviewer approves the proposal in the review queue, posting it', async () => {
    await page.getByRole('link', { name: 'Agent proposals' }).click();
    await expect(page.getByRole('heading', { name: 'Agent proposals' })).toBeVisible();

    const row = page
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: PROPOSAL_MEMO, exact: true }) });
    await row.getByRole('button', { name: 'Review' }).click();

    const dialog = page.getByRole('dialog', { name: 'Review proposal' });
    await expect(dialog.getByText(PROPOSAL_MEMO)).toBeVisible();

    // The approval's own response carries the posted journal's id (`postedJournalSchema`'s
    // `journalId`) — read directly off the network call the click makes, rather than a
    // second lookup, because (see the file header) nothing publishes a change-feed event for
    // this posting to read it back off of instead.
    const [approveResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          /\/v1\/agent-proposals\/.+\/approve$/.test(new URL(response.url()).pathname) &&
          response.request().method() === 'POST',
      ),
      dialog.getByRole('button', { name: 'Approve and post' }).click(),
    ]);
    expect(
      approveResponse.ok(),
      `POST .../approve → ${String(approveResponse.status())}`,
    ).toBeTruthy();
    const posted = (await approveResponse.json()) as PostedJournalResponse;
    journalId = posted.journalId;

    await expect(dialog).not.toBeVisible();
  });

  await test.step('the posting reached the ledger, and the change feed is readable', async () => {
    const trialBalanceAfter = await page.request.get('/v1/reports/trial-balance');
    expect(trialBalanceAfter.ok()).toBeTruthy();
    const totals = (await trialBalanceAfter.json()) as TrialBalanceTotals;
    expect(totals.totalDebits).toBe(LINE_AMOUNT);
    expect(totals.totalCredits).toBe(LINE_AMOUNT);

    const feedResponse = await page.request.get('/v1/change-feed');
    expect(
      feedResponse.ok(),
      `GET /v1/change-feed → ${String(feedResponse.status())}`,
    ).toBeTruthy();
    const feed = (await feedResponse.json()) as ChangeFeedPage;
    // Shaped the way `changeFeedPageSchema` promises, and reachable under `integrations.read`
    // — the part of D-56/D-57 this org's history can actually exercise (see the file header):
    // no operation this narrative performed is one of the four `emitEvent` call sites, so the
    // feed is empty rather than carrying a `journal.posted.v1` this system does not publish.
    expect(feed.events).toEqual([]);
    expect(feed.nextCursor).toBeNull();
  });

  await test.step('correlate the posted journal to an external system, idempotently (D-58)', async () => {
    const externalSystem = 'ledger-agent';
    const externalId = `agent-run-${randomUUID()}`;

    const firstCreate = await page.request.post('/v1/external-refs', {
      headers: writeHeaders(),
      data: { externalSystem, entityType: 'journal', externalId, entityId: journalId },
    });
    expect(firstCreate.status(), `POST /v1/external-refs → ${String(firstCreate.status())}`).toBe(
      201,
    );
    const firstRef = (await firstCreate.json()) as ExternalRef;
    expect(firstRef.entityId).toBe(journalId);

    const lookupQuery = new URLSearchParams({ externalSystem, entityType: 'journal', externalId });
    const lookup = await page.request.get(`/v1/external-refs/lookup?${lookupQuery.toString()}`);
    expect(lookup.ok(), `GET /v1/external-refs/lookup → ${String(lookup.status())}`).toBeTruthy();
    const lookedUp = (await lookup.json()) as ExternalRef;
    expect(lookedUp.id).toBe(firstRef.id);

    // D-58: a create repeating an identity already on file is a retry, not a conflict — the
    // same pair, posted again with a fresh `Idempotency-Key`, must resolve to the same row.
    const secondCreate = await page.request.post('/v1/external-refs', {
      headers: writeHeaders(),
      data: { externalSystem, entityType: 'journal', externalId, entityId: journalId },
    });
    expect(secondCreate.status()).toBe(201);
    const secondRef = (await secondCreate.json()) as ExternalRef;
    expect(secondRef.id).toBe(firstRef.id);
  });
});
