import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

import { chartByCode } from './support/banking';
import { currentMonth, newRegistration } from './support/books';

/**
 * The Q narrative (OB-210; ROADMAP D-99, D-100, D-118, D-119) — the agent work queue,
 * MCP-only: a person composes an automation that **composes two actions in order**
 * (`[annotate, agent_task]`), the org's own agent polls what that firing enqueued over MCP,
 * submits a structured proposal, and a human approves it into the ledger. Nothing here ever
 * calls a model and nothing an agent submits ever posts by itself (D-100) — the one claim
 * this file exists to prove end to end, the same "no direct write" contract
 * `platform-oauth-mcp.spec.ts` proves for the ad hoc `journal.propose` tool, now for the
 * queued-work pair (`work_queue.poll` / `work_queue.submit_proposal`).
 *
 * ## Why two actions, and how their both having run is observed
 *
 * `modules/automations/engine.ts`'s own header says why the actions run in list order: "so
 * the annotation and the work item from one firing share a `run_token` — how the E2E proves
 * both actions of an `[annotate, agent_task]` automation ran." There is no `GET` route over
 * `automation_annotations` (Q shipped no read surface for it — `automations.ts`'s route file
 * has no such handler), so the annotation itself is not independently fetchable; what is
 * observable, and is what this narrative reads, is `AutomationRunResult` off the `run`
 * response — `annotationsWritten: 1, workItemsEnqueued: 1` from one firing is exactly the
 * claim that both actions of the composed pair ran, in the order composed.
 *
 * ## `page` versus `request`, following `platform-oauth-mcp.spec.ts`'s split exactly
 *
 * Composing the automation, running it, watching the work queue, and approving the
 * proposal are this app's own screens, so they run through `page`. Registering the OAuth
 * client is API-first for the same reason that file gives (`oauth-clients.test.tsx` already
 * proves the secret-once-only dialog). Authorize/consent/token/`POST /mcp` are `request` —
 * PKCE and JSON-RPC bodies are the "genuinely awkward in a browser" case, and every one of
 * those four is `{ hide: true }` in `oauth-flow.ts`, so there is no typed client method to
 * call through regardless.
 *
 * ## Why the OAuth/MCP calls dial the API origin directly
 *
 * See `platform-oauth-mcp.spec.ts`'s header in full — `vite.config.ts`'s dev proxy forwards
 * no `/oauth` or `/mcp` prefix, so a relative request would hit the SPA fallback instead of
 * 404ing legibly. `API_ORIGIN` below is `playwright.config.ts`'s `API_PORT` restated, dialed
 * over `localhost` (matching the browser-set, host-only session cookie) rather than the
 * `127.0.0.1` the API process actually binds to.
 *
 * ## The scope this token carries
 *
 * `work_queue.poll` is gated `workflows.read`, `work_queue.submit_proposal` is gated
 * `journals.post` (`modules/mcp/tools.ts`) — the granted OAuth scope is intersected against
 * the caller's live role on every call (D-54), so the authorized scope below is exactly
 * `workflows.read journals.post`, space-delimited per RFC 6749 §3.3, and nothing wider.
 *
 * ## What this narrative does not claim
 *
 * It does not exercise a scheduled or event trigger (Q2), reordering or removing an action
 * row, a lease expiring unclaimed, or `lease_invalid`/`lease_expired` — each is a distinct
 * refusal path with its own unit/integration coverage, and D-26 is spent on the seam none of
 * those cover: composing, firing, leasing, proposing, and approving, end to end, with an
 * empty second poll along the way to prove D-118's "an empty queue is success, not an error."
 */

/** `playwright.config.ts`'s `API_PORT` — see the file header for why `localhost`. */
const API_ORIGIN = 'http://localhost:3110';

/** Never dialed — only the `Location` header's `code` query param is ever read off of it,
 * the same reasoning `platform-oauth-mcp.spec.ts`'s `AGENT_REDIRECT_URI` gives. A distinct
 * port from that file's, so nothing here is confused for its fixture if both ever ran
 * against a shared assumption about what is reachable (neither is, by design). */
const AGENT_REDIRECT_URI = 'http://127.0.0.1:8744/callback';

const CLIENT_NAME = 'Automations Agent';

const AUTOMATION_NAME = 'Propose the daily consulting retainer';
const ANNOTATE_NOTE = 'Automation fired — logged for the audit trail.';
const AGENT_PROMPT =
  'Propose a journal entry recording the $500.00 consulting retainer received today.';

const PROPOSAL_MEMO = 'Agent-proposed consulting retainer (OB-210)';
/** Minor units (D-13): $500.00, split evenly so the two-line draft balances by construction. */
const LINE_AMOUNT = '50000';

/** `Idempotency-Key`, lower-cased as `openapi.json` names it. */
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

/** `AutomationRunResult`'s own shape — what one firing produced. */
interface AutomationRunResultResponse {
  readonly runToken: string;
  readonly annotationsWritten: number;
  readonly workItemsEnqueued: number;
}

/** `WorkQueueLease` — what `work_queue.poll` hands the agent on a hit. */
interface WorkQueueLease {
  readonly workItemId: string;
  readonly prompt: string;
  readonly leaseToken: string;
}

/** `work_queue.poll`'s outcome is `{ kind: 'executed', result: { item } }` — `item` is
 * `null` on an empty queue, never a refusal (D-118). */
interface McpPollResponse {
  readonly result?: {
    readonly kind: string;
    readonly result?: { readonly item: WorkQueueLease | null };
  };
  readonly error?: { readonly message: string };
}

/** `work_queue.submit_proposal`'s outcome, `journal.propose`'s own shape:
 * `{ kind: 'proposed', proposal: { summary } }`. */
interface McpSubmitProposalResponse {
  readonly result?: { readonly kind: string; readonly proposal?: { readonly summary: string } };
  readonly error?: { readonly message: string };
}

interface PostedJournalResponse {
  readonly journalId: string;
}

/** `trialBalanceSchema`'s two totals — minor-units strings (D-13), narrowed to what this
 * narrative reads: whether anything has posted yet. */
interface TrialBalanceTotals {
  readonly totalDebits: string;
  readonly totalCredits: string;
}

test('an automation composes annotate and agent_task in order, the agent proposes over MCP, and a human approves it before anything posts', async ({
  page,
}) => {
  const registration = newRegistration();
  const month = currentMonth();
  const todayIso = month.day(new Date().getDate());

  let checkingAccountId: string;
  let revenueAccountId: string;
  let client: OAuthClientWithSecret;
  let authorizationCode: string;
  let accessToken: string;
  let leaseToken: string;

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

  await test.step('apply the starter chart, for the two accounts the proposal will post to', async () => {
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

  await test.step('generate the fiscal year — the approved proposal will post into it (D-17)', async () => {
    await page.getByRole('link', { name: 'Settings' }).click();
    const periods = page.getByRole('region', { name: 'Fiscal periods' });

    await periods.getByRole('button', { name: 'Generate 12 periods' }).click();
    await expect(periods.getByText('Generated 12 periods')).toBeVisible();
    await expect(periods.getByRole('cell', { name: month.periodName })).toBeVisible();
  });

  await test.step('compose an automation: manual trigger, an annotate action then an agent_task action (Q1, Q3)', async () => {
    await page.getByRole('link', { name: 'Automations' }).click();
    await expect(page.getByRole('heading', { name: 'Automations' })).toBeVisible();

    await page.getByRole('button', { name: 'New automation' }).click();
    const dialog = page.getByRole('dialog', { name: 'New automation' });

    // Exact, because the dialog's event-trigger row carries an 'Event name' field and a
    // substring `getByLabel('Name')` matches both it and this one (`form-dialog.tsx`).
    await dialog.getByLabel('Name', { exact: true }).fill(AUTOMATION_NAME);
    // Trigger defaults to `manual` (`blankFormState`) — this automation only ever fires
    // from "Run now", so the radio is left as it is.

    // The form seeds one blank `annotate` action; filling its note is action one of two.
    await dialog.getByLabel('Note').fill(ANNOTATE_NOTE);

    // Action two: `agent_task`, added after the seeded `annotate` row so the composed
    // order is exactly `[annotate, agent_task]`, the pair this narrative's header claims.
    await dialog.getByRole('button', { name: 'Add agent task' }).click();
    await dialog.getByLabel('Prompt').fill(AGENT_PROMPT);
    // Source kind is prefilled `automation` (`blankAgentTaskAction`'s default) — left as is.

    await dialog.getByRole('button', { name: 'Create' }).click();

    const row = page
      .getByRole('row')
      .filter({ has: page.getByRole('button', { name: AUTOMATION_NAME, exact: true }) });
    await expect(row.getByText('Manual', { exact: true })).toBeVisible();
    await expect(row.getByText('2 actions', { exact: true })).toBeVisible();
    await expect(row.getByText('Inactive', { exact: true })).toBeVisible();
  });

  await test.step('activate it, then run it now — one annotation and one work item from the one firing (Q9)', async () => {
    const row = page
      .getByRole('row')
      .filter({ has: page.getByRole('button', { name: AUTOMATION_NAME, exact: true }) });

    await row.getByRole('button', { name: `Activate ${AUTOMATION_NAME}` }).click();
    await expect(row.getByText('Active', { exact: true })).toBeVisible();

    const [runResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          /\/v1\/automations\/.+\/run$/.test(new URL(response.url()).pathname) &&
          response.request().method() === 'POST',
      ),
      row.getByRole('button', { name: `Run ${AUTOMATION_NAME} now` }).click(),
    ]);
    expect(runResponse.ok(), `POST .../run → ${String(runResponse.status())}`).toBeTruthy();
    const runResult = (await runResponse.json()) as AutomationRunResultResponse;
    // Both actions of the composed pair ran exactly once, from this one firing — see the
    // file header for why this count, not a fetched annotation row, is the proof.
    expect(runResult.annotationsWritten).toBe(1);
    expect(runResult.workItemsEnqueued).toBe(1);

    await expect(page.getByRole('status')).toContainText(
      '1 annotation written, 1 work item enqueued.',
    );
  });

  await test.step('the enqueued work item is visible on the work queue, still queued (Q4)', async () => {
    await page.getByRole('link', { name: 'Work queue' }).click();
    await expect(page.getByRole('heading', { name: 'Work queue' })).toBeVisible();

    const workItemRow = page
      .getByRole('row')
      .filter({ has: page.getByText(AGENT_PROMPT, { exact: true }) });
    await expect(workItemRow).toBeVisible();
    await expect(workItemRow.getByText('queued', { exact: true })).toBeVisible();
  });

  await test.step('register an OAuth client for the org’s agent, and authorize it over PKCE (workflows.read + journals.post)', async () => {
    const response = await page.request.post('/v1/oauth-clients', {
      headers: writeHeaders(),
      data: { name: CLIENT_NAME, redirectUris: [AGENT_REDIRECT_URI] },
    });
    expect(response.status(), `POST /v1/oauth-clients → ${String(response.status())}`).toBe(201);
    client = (await response.json()) as OAuthClientWithSecret;
    expect(client.clientId.length).toBeGreaterThan(0);
    expect(client.clientSecret.length).toBeGreaterThan(0);

    // PKCE (RFC 7636), S256 — `verifyPkce` hashes the verifier as `ascii`; `codeVerifier`
    // is base64url, a strict subset of ASCII, matching the server's own computation.
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
    const state = randomUUID();
    const scope = 'workflows.read journals.post';

    const authorizeQuery = new URLSearchParams({
      response_type: 'code',
      client_id: client.clientId,
      redirect_uri: AGENT_REDIRECT_URI,
      scope,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    const authorizeResponse = await page.request.get(
      `${API_ORIGIN}/oauth/authorize?${authorizeQuery.toString()}`,
      { maxRedirects: 0 },
    );
    expect(authorizeResponse.status(), 'GET /oauth/authorize did not redirect').toBe(302);
    const consentLocation = authorizeResponse.headers()['location'] ?? '';
    expect(consentLocation.startsWith('/oauth/consent?')).toBe(true);

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
    // Order-independent: a scope is a set, and D-54 intersects the request with the user's
    // live role and returns the granted scopes in its own canonical order, not the order
    // they were asked for. The token carries the same two scopes either way.
    expect(token.scope.split(' ').sort()).toEqual(scope.split(' ').sort());
    accessToken = token.access_token;
  });

  await test.step('the agent polls the queue over MCP, leases the item, and submits a structured proposal — nothing posts yet (D-100)', async () => {
    const pollResponse = await page.request.post(`${API_ORIGIN}/mcp`, {
      headers: { authorization: `Bearer ${accessToken}` },
      data: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'work_queue.poll' },
      },
    });
    expect(pollResponse.ok(), `POST /mcp (poll) → ${String(pollResponse.status())}`).toBeTruthy();
    const pollBody = (await pollResponse.json()) as McpPollResponse;
    expect(pollBody.error).toBeUndefined();
    expect(pollBody.result?.kind).toBe('executed');
    const leased = pollBody.result?.result?.item ?? null;
    expect(leased, 'poll leased nothing — the enqueued work item was not found').not.toBeNull();
    expect(leased?.prompt).toBe(AGENT_PROMPT);
    leaseToken = leased?.leaseToken ?? '';

    // D-100/Q4 in one assertion: nothing has posted from a leased-but-not-yet-submitted
    // item, and nothing will from the submission below either — the trial balance stays
    // zero until a human approves in the review queue, several steps from here.
    const trialBalanceBeforeSubmit = await page.request.get('/v1/reports/trial-balance');
    expect(trialBalanceBeforeSubmit.ok()).toBeTruthy();
    const beforeSubmitTotals = (await trialBalanceBeforeSubmit.json()) as TrialBalanceTotals;
    expect(beforeSubmitTotals.totalDebits).toBe('0');
    expect(beforeSubmitTotals.totalCredits).toBe('0');

    const submitResponse = await page.request.post(`${API_ORIGIN}/mcp`, {
      headers: { authorization: `Bearer ${accessToken}` },
      data: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'work_queue.submit_proposal',
          arguments: {
            leaseToken,
            draft: {
              entryDate: todayIso,
              memo: PROPOSAL_MEMO,
              lines: [
                { accountId: checkingAccountId, side: 'debit', amount: LINE_AMOUNT },
                { accountId: revenueAccountId, side: 'credit', amount: LINE_AMOUNT },
              ],
            },
            model: 'automations-e2e-agent',
          },
        },
      },
    });
    expect(
      submitResponse.ok(),
      `POST /mcp (submit_proposal) → ${String(submitResponse.status())}`,
    ).toBeTruthy();
    const submitBody = (await submitResponse.json()) as McpSubmitProposalResponse;
    expect(submitBody.error).toBeUndefined();
    expect(submitBody.result?.kind).toBe('proposed');
    expect(submitBody.result?.proposal?.summary.length ?? 0).toBeGreaterThan(0);

    const trialBalanceAfterSubmit = await page.request.get('/v1/reports/trial-balance');
    expect(trialBalanceAfterSubmit.ok()).toBeTruthy();
    const afterSubmitTotals = (await trialBalanceAfterSubmit.json()) as TrialBalanceTotals;
    expect(afterSubmitTotals.totalDebits).toBe('0');
    expect(afterSubmitTotals.totalCredits).toBe('0');
  });

  await test.step('a second poll finds nothing to do — an empty queue is success, not an error (D-118)', async () => {
    const secondPollResponse = await page.request.post(`${API_ORIGIN}/mcp`, {
      headers: { authorization: `Bearer ${accessToken}` },
      data: {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'work_queue.poll' },
      },
    });
    // HTTP 200, not 404 and not a JSON-RPC error — D-118's own words: "the MCP surface
    // must not read as disconnected" just because the queue happens to be empty.
    expect(secondPollResponse.status()).toBe(200);
    const secondPollBody = (await secondPollResponse.json()) as McpPollResponse;
    expect(secondPollBody.error).toBeUndefined();
    expect(secondPollBody.result?.kind).toBe('executed');
    // An empty queue leases nothing: `pollWorkQueue` returns `{ item: null }` (D-118). Assert
    // that null directly — the earlier `?? 'not present'` guard was self-defeating, since `??`
    // fires on null too and turned the very value under test into a non-null string.
    expect(secondPollBody.result?.result?.item).toBeNull();
  });

  await test.step('the work item now shows as proposed, and a human approves it in the review queue (Q5, Q4)', async () => {
    await page.getByRole('link', { name: 'Work queue' }).click();
    await page.getByRole('combobox', { name: 'Status' }).click();
    await page.getByRole('option', { name: 'Proposed' }).click();

    const proposedRow = page
      .getByRole('row')
      .filter({ has: page.getByText(AGENT_PROMPT, { exact: true }) });
    await expect(proposedRow.getByText('proposed', { exact: true })).toBeVisible();
    await expect(proposedRow.getByRole('link', { name: 'Review proposal' })).toBeVisible();

    await page.getByRole('link', { name: 'Agent proposals' }).click();
    await expect(page.getByRole('heading', { name: 'Agent proposals' })).toBeVisible();

    const proposalRow = page
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: PROPOSAL_MEMO, exact: true }) });
    await proposalRow.getByRole('button', { name: 'Review' }).click();

    const dialog = page.getByRole('dialog', { name: 'Review proposal' });
    await expect(dialog.getByText(PROPOSAL_MEMO)).toBeVisible();

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
    expect(posted.journalId.length).toBeGreaterThan(0);

    await expect(dialog).not.toBeVisible();
  });

  await test.step('only now does the trial balance move — the posting the human, not the agent, made', async () => {
    const trialBalanceAfterApproval = await page.request.get('/v1/reports/trial-balance');
    expect(trialBalanceAfterApproval.ok()).toBeTruthy();
    const totals = (await trialBalanceAfterApproval.json()) as TrialBalanceTotals;
    expect(totals.totalDebits).toBe(LINE_AMOUNT);
    expect(totals.totalCredits).toBe(LINE_AMOUNT);
  });
});
