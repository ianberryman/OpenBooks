import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

import { seedBankAccount } from './support/banking';
import { newRegistration } from './support/books';
import { createAccount, listUnclearedLines } from './support/payments';

/**
 * The live-bank-feed narrative (OB-227; ROADMAP D-126…D-131, D-26).
 *
 * A business that has connected its bank to OpenBooks does not want to download a CSV
 * every morning: it wants yesterday's transactions to arrive on their own and land in
 * the same match/reconcile pipeline a file import feeds. This is that seam's one
 * browser proof — connect a `fake` feed (D-102, the deterministic stand-in for Stripe
 * Financial Connections a hermetic run cannot call), trigger the sync a person's daily
 * tick would, watch the pulled transactions appear as uncleared statement lines, and
 * confirm a second sync is a no-op (D-128) — with one moment as the actual person in
 * the Bank feeds screen the feature ships.
 *
 * ## Why this narrative is API-first, and where the browser still appears
 *
 * Like `payment-integration.spec.ts`, this inverts the suite's usual screen-first
 * ratio, for reasons specific to what OB-227 shipped:
 *  - **A restricted key and a link session have no gate-runnable browser flow.** The
 *    real connect flow runs Stripe.js against a Financial Connections session
 *    (D-102, manual-sandbox); the `fake` returns deterministic linked accounts, so
 *    driving the two-step connect over `page.request` asserts the same contract
 *    without a cross-origin widget the fake has no page behind.
 *  - **The daily sync has no UI by construction.** It is a scheduled job; the manual
 *    trigger (`POST /v1/bank-feeds/{id}/sync`) is what a person's tick stands in for.
 *  - **The assertion is the statement line appearing** — read off
 *    `GET /v1/statement-lines`, the same list the banking screens render.
 *
 * The one moment this narrative *is* a person in a browser is opening `/bank-feeds`
 * and seeing the connection they just made, rendered by the actual screen (OB-227).
 */

const RESTRICTED_KEY = 'rk_test_e2e_fake';
const EXTERNAL_ACCOUNT_ID = 'fc-acct-e2e';

function writeHeaders(): Record<string, string> {
  return { 'Idempotency-Key': randomUUID() };
}

test('a live feed is connected, its transactions sync into the statement pipeline, and a re-sync is a no-op', async ({
  page,
}) => {
  const registration = newRegistration();
  const fiscalYear = new Date().getFullYear();

  let bankLedgerAccountId: string;
  let bankAccountId: string;
  let connectionId: string;

  await test.step('register an org with the starter chart and generate its fiscal year', async () => {
    const response = await page.request.post('/v1/auth/register', {
      data: {
        displayName: registration.displayName,
        email: registration.email,
        password: registration.password,
        org: { name: registration.orgName, chart: 'general_small_business' },
      },
    });
    expect(response.ok(), `POST /v1/auth/register → ${String(response.status())}`).toBeTruthy();

    const fiscalYearResponse = await page.request.post('/v1/fiscal-years', {
      headers: writeHeaders(),
      data: { year: fiscalYear, startMonth: 1 },
    });
    expect(
      fiscalYearResponse.ok(),
      `POST /v1/fiscal-years → ${String(fiscalYearResponse.status())}`,
    ).toBeTruthy();
  });

  await test.step('nominate a bank ledger account and register a bank account over it (D-46)', async () => {
    bankLedgerAccountId = await createAccount(page.request, {
      code: '1015',
      name: 'Checking — live feed',
      type: 'asset',
      normalBalance: 'debit',
    });

    const bankAccount = await seedBankAccount(page.request, {
      accountId: bankLedgerAccountId,
      name: 'Operating checking',
      institutionName: 'Fake Bank',
      externalAccountId: EXTERNAL_ACCOUNT_ID,
    });
    bankAccountId = bankAccount.id;
  });

  await test.step('connect a fake live feed: a link session lists accounts, then connect picks one', async () => {
    const session = await page.request.post('/v1/bank-feeds/link-sessions', {
      headers: writeHeaders(),
      data: { feedSource: 'fake', restrictedKey: RESTRICTED_KEY },
    });
    expect(
      session.ok(),
      `POST /v1/bank-feeds/link-sessions → ${String(session.status())}`,
    ).toBeTruthy();
    const { linkedAccounts } = (await session.json()) as {
      linkedAccounts: ReadonlyArray<{ externalAccountId: string; institution: string | null }>;
    };
    expect(linkedAccounts.length).toBeGreaterThan(0);
    const chosen = linkedAccounts[0];
    if (!chosen) throw new Error('link session returned no linkable accounts');

    const connect = await page.request.post('/v1/bank-feeds', {
      headers: writeHeaders(),
      data: {
        bankAccountId,
        feedSource: 'fake',
        restrictedKey: RESTRICTED_KEY,
        externalAccountId: chosen.externalAccountId,
        institution: chosen.institution,
      },
    });
    expect(connect.ok(), `POST /v1/bank-feeds → ${String(connect.status())}`).toBeTruthy();
    const connection = (await connect.json()) as { id: string; feedSource: string };
    // The restricted key is inbound-only and never echoed back (D-83).
    expect(JSON.stringify(connection)).not.toContain(RESTRICTED_KEY);
    connectionId = connection.id;
  });

  await test.step('the daily sync (triggered by hand) pulls the feed into uncleared statement lines', async () => {
    const sync = await page.request.post(`/v1/bank-feeds/${connectionId}/sync`, {
      headers: writeHeaders(),
    });
    expect(
      sync.ok(),
      `POST /v1/bank-feeds/${connectionId}/sync → ${String(sync.status())}`,
    ).toBeTruthy();
    const result = (await sync.json()) as { linesImported: number; linesDuplicate: number };
    expect(result.linesImported).toBe(3);
    expect(result.linesDuplicate).toBe(0);

    const lines = await listUnclearedLines(page.request, bankAccountId);
    expect(lines).toHaveLength(3);
  });

  await test.step('a second sync is a no-op — the cursor advanced, nothing is re-imported (D-128)', async () => {
    const again = await page.request.post(`/v1/bank-feeds/${connectionId}/sync`, {
      headers: writeHeaders(),
    });
    expect(again.ok()).toBeTruthy();
    const result = (await again.json()) as { linesImported: number };
    expect(result.linesImported).toBe(0);

    const lines = await listUnclearedLines(page.request, bankAccountId);
    expect(lines).toHaveLength(3);
  });

  await test.step('the person opens the Bank feeds screen and sees the connection they made', async () => {
    await page.goto('/bank-feeds');
    await expect(page.getByText('Fake Bank', { exact: false })).toBeVisible();
  });
});
