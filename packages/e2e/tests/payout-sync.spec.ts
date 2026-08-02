import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';

import { chartByCode } from './support/banking';
import { newRegistration } from './support/books';
import {
  connectFakeProcessor,
  createAccount,
  getGeneralLedger,
  postFakeWebhook,
} from './support/payments';
import type { NormalizedProcessorEvent } from './support/payments';

/**
 * The payout-sync narrative (OB-237; ROADMAP D-237-1…D-237-7) — automatic Stripe
 * payout sync → summary-sales journals, for an org whose invoicing lives entirely
 * in the processor rather than in OpenBooks. A `summary_sales` connection books no
 * per-charge/refund revenue at all (`webhook.service.ts`'s `dispatch`, D-237-1) —
 * the payout itself is the sole posting trigger, grossed up into one balanced
 * journal (Dr Clearing / Dr Fees / Dr Refunds … Cr Revenue) rather than the
 * commonest Stripe bookkeeping error of booking the net deposit as revenue. This
 * narrative connects a `fake` processor in that mode, maps the three categories the
 * fake's breakdown reports, delivers one payout webhook, reviews and posts the
 * resulting `payout_syncs` row, and proves a redelivered webhook cannot double it.
 *
 * ## Reused from `payment-integration.spec.ts` (PAY, OB-153) outright
 *
 * `connectFakeProcessor`, `createAccount`, `getGeneralLedger`, `postFakeWebhook`
 * and `NormalizedProcessorEvent` all come from `support/payments.ts` unchanged —
 * this is the same `fake` processor seam (D-102), the same clearing/fee-account
 * nomination (D-103), and the same webhook signing trick that file's own header
 * documents at length: `postFakeWebhook` signs the *exact* serialized bytes it
 * sends (`JSON.stringify(event)` computed once, reused for both the HMAC-SHA256
 * digest and the request body), because Playwright re-serializing an object body a
 * second time would sign one string and send a merely-equivalent second one.
 *
 * ## Why the fiscal year generated is **2024**, not the year this test runs in
 *
 * `providers/payment/fake.ts`'s `fetchPayoutBreakdown` returns a *fixed* breakdown
 * (D-237-4 — the gate's real implementation needs a deterministic one to run
 * against): `netMinor: '9200'`, `occurredAt: '2024-01-01T00:00:00.000Z'`, and three
 * categories (`charge 10000`, `fee 300`, `refund 500`). `payout-sync.service.ts`'s
 * `postSummaryJournal` dates the journal off that `breakdown.occurredAt`, not off
 * the webhook event's own `occurredAt` or "today" — so the summary journal this
 * narrative posts is *always* dated 2024-01-01, regardless of when the suite runs.
 * Generating the current year's fiscal year (the other narratives' idiom) would
 * leave that date with no covering period, and posting would fail
 * `period_missing` (`periods.service.ts`'s `assertPostable`). This narrative
 * generates fiscal year 2024 instead, for that one reason.
 *
 * ## Why this narrative is API-first, and why there is no "Payouts to review" click
 *
 * Every write here goes through `page.request`, never `page.goto`, because there
 * is nothing on screen to click. `screens/processing.tsx` (`/processing`, mounted
 * in `App.tsx`) renders the connection list, the connect dialog, and the
 * activate/deactivate toggle — and nothing else; it has no payout-sync
 * configuration form and no review queue. `screens/processing/payout-sync-
 * queries.ts` already carries the full set of hooks a config screen and a review
 * screen would need (`usePayoutSyncConfig`, `useUpdatePayoutSyncConfig`,
 * `usePayoutSyncs`, `usePostPayoutSync`, `useSkipPayoutSync`) — but no component
 * in `screens/processing/` imports any of them; they are backend-complete and
 * UI-pending. So the config PUT, the review-list GET, and the post POST below are
 * each driven directly against the routes those hooks would otherwise call,
 * mirroring `pay-bills.spec.ts`'s own reasoning for reaching its routes directly
 * rather than re-proving a screen's own component coverage a second time (D-26).
 *
 * ## The idempotency claim (D-237), and how it is proven
 *
 * `recordNormalizedEvent`'s event-level guard (`processor_events.uq_…_external`)
 * is what a genuine processor redelivery — the identical delivery, retried — hits:
 * the same `externalEventId` loses the unique-key race and `dispatch` (so
 * `syncPayout`) is never invoked a second time, answering `'duplicate'` rather
 * than `'processed'`. This narrative redelivers the *exact* signed body already
 * sent — same object, so `JSON.stringify` produces byte-identical bytes and hence
 * an identical signature — after the sync has already been reviewed and posted,
 * and asserts the review list still holds exactly one row for this payout, with
 * the same `journalId`, and that the clearing account's balance did not move a
 * second time.
 *
 * ## Money
 *
 * Cents-only strings throughout (D-13) — `formatMoney`/decimal conversion play no
 * part in this narrative; every assertion compares the wire's own cents strings.
 *
 * ## OB-237b: a manual payout, staged `awaiting_report`, finalized by the daily sweep
 *
 * Live against real Stripe, OB-237's `balance_transactions?payout=` breakdown 400s on
 * a **manually**-created payout — Stripe only lets that filter run over automatic
 * transfers (ROADMAP's OB-237b section). The fix routes a manual payout through the
 * async Reporting API instead (D-237-8/D-237-10): `fetchPayoutBreakdown` starts a
 * report run and returns immediately, so the sync stages `awaiting_report` — no
 * breakdown, no journal yet — carrying the run's id (`reportRunId`) for a later sweep
 * to resolve. `providers/payment/fake.ts`'s own header names the deterministic trick
 * this narrative relies on: a payout **object id containing the substring `'manual'`**
 * takes this path (`fetchPayoutBreakdown`'s `awaiting_report` branch, fixed
 * `netMinor: '9200'`), and its report (`fetchPayoutReport`) resolves to the *same*
 * fixed breakdown the automatic path above posts — `fixedPayoutBreakdown` is shared
 * by both, so this scene's eventual journal is figure-for-figure identical to the one
 * already proven above, once finalized.
 *
 * The finalize sweep (`finalizePayoutReports`, `payout-sync.service.ts`) runs once per
 * active connection inside `runProcessorPoll` (`poll.job.ts`), which
 * `registerDailyTask(PROCESSOR_POLL_QUEUE)` rides onto the same daily-tick fan-out
 * `recurring-and-dunning.spec.ts` and `fixed-assets-and-recurring-journals.spec.ts`
 * trigger through `POST /v1/scheduling/run-due-work` — confirmed by grepping this
 * package's own specs for that route before writing this scene, per this file's own
 * discipline of reaching routes directly rather than reproving UI coverage a second
 * time. This scene's own connection is configured `autoPost: true`, unlike the
 * review-first connection above — the sweep then carries a resolved report straight
 * to `posted`, which is the only way this narrative can observe the *whole* async
 * lifecycle (`awaiting_report` → `posted`) rather than stopping at "resolved, pending a
 * human".
 *
 * Both of those two narratives' own headers explain, at length, why they stop at
 * asserting the trigger route's `200 { runDate }` contract and never assert that the
 * enqueued sweep actually *ran*: it rides the self-host in-process queue
 * (`providers/queue/in-process.ts`), whose own comment says a job "runs on a later
 * turn of the event loop" with no HTTP-observable settled signal — and inventing a
 * poll loop neither narrative otherwise uses would misrepresent what a green run
 * proves, in a suite `playwright.config.ts` deliberately runs with zero *test*
 * retries. This scene differs in one respect that makes polling honest rather than
 * invented: the exact row this scene already reads —
 * `GET /v1/processing/connections/{id}/payout-syncs`'s `status` field — *is* the
 * sweep's own HTTP-observable settled signal, the same shape `waitForImportComplete`
 * in `support/payments.ts` already polls for a different worker-run job (a bank
 * statement import) with `expect(...).toPass(...)`. So this scene reuses that exact,
 * precedented idiom (not a new one) rather than either inventing a poll loop or
 * asserting an outcome it cannot observe.
 */

const CHARGE_MINOR = '10000'; // 100.00 — the fake breakdown's gross charges for this payout.
const FEE_MINOR = '300'; // 3.00 — the processor's cut, this file's header.
const REFUND_MINOR = '500'; // 5.00 — a refund netted into the same payout (D-237-1).
const NET_MINOR = '9200'; // 100.00 − 3.00 − 5.00 — the clearing plug, and `fake.ts`'s fixed net.

const WEBHOOK_SECRET = 'e2e-fake-payout-webhook-secret';
const FISCAL_YEAR = 2024; // See this file's header: the fake breakdown's fixed occurredAt.

// ---------------------------------------------------------------------------
// Local wire helpers — `payout-sync/config`, `payout-syncs`, and `getJournal`
// have no `support/` module yet (OB-237 shipped no screen to back one with),
// so this narrative reaches them the way `support/payments.ts` reaches every
// other route: a thin `expect(...).toBeTruthy()`-guarded wrapper per call.
// ---------------------------------------------------------------------------

type PayoutReportingCategory = 'charge' | 'refund' | 'fee' | 'tax' | 'dispute' | 'adjustment';

interface PayoutAccountMapEntryInput {
  readonly reportingCategory: PayoutReportingCategory;
  readonly accountId: string;
}

/**
 * Sets a connection to `summary_sales` with the given mapping. Review-first
 * (`autoPost: false`) by default — the OB-237 scene's own choice, kept as the
 * default here too — but the OB-237b manual-payout scene below passes `true`: the
 * finalize sweep is the only thing that ever resolves an `awaiting_report` row (D-
 * 237-10; `postPayoutSync`/`skipPayoutSync` both refuse a row that isn't
 * `pending_review`), so `autoPost: true` is what lets that scene observe the sweep
 * carry a resolved report all the way to `posted` in one step.
 */
async function configureSummarySalesPayoutSync(
  request: APIRequestContext,
  connectionId: string,
  entries: readonly PayoutAccountMapEntryInput[],
  autoPost = false,
): Promise<void> {
  const response = await request.put(
    `/v1/processing/connections/${connectionId}/payout-sync/config`,
    {
      headers: { 'idempotency-key': randomUUID() },
      data: { syncMode: 'summary_sales', autoPost, entries },
    },
  );
  expect(
    response.ok(),
    `PUT /v1/processing/connections/{id}/payout-sync/config → ${String(response.status())}`,
  ).toBeTruthy();
}

interface PayoutSyncCategoryLine {
  readonly reportingCategory: PayoutReportingCategory;
  readonly amountMinor: string;
  readonly count: number;
}

interface PayoutSyncDto {
  readonly id: string;
  readonly externalPayoutId: string;
  readonly grossMinor: string;
  readonly feeMinor: string;
  readonly netMinor: string;
  readonly status: 'pending_review' | 'posted' | 'skipped' | 'awaiting_report';
  readonly breakdown: readonly PayoutSyncCategoryLine[];
  readonly journalId: string | null;
  // The async Stripe Reporting-API run backing an `awaiting_report` manual payout
  // (D-237-10); `null` for an automatic payout that resolved synchronously — OB-237b.
  readonly reportRunId: string | null;
}

/** The full "Stripe payouts to review" list for one connection — a bare array, D-237-2. */
async function listPayoutSyncs(
  request: APIRequestContext,
  connectionId: string,
): Promise<readonly PayoutSyncDto[]> {
  const response = await request.get(`/v1/processing/connections/${connectionId}/payout-syncs`);
  expect(
    response.ok(),
    `GET /v1/processing/connections/{id}/payout-syncs → ${String(response.status())}`,
  ).toBeTruthy();
  return (await response.json()) as PayoutSyncDto[];
}

/**
 * Polls one connection's payout syncs until the named sync leaves `awaiting_report`
 * (OB-237b) — the finalize sweep's own HTTP-observable settled signal, the same
 * `expect(...).toPass(...)` idiom `support/payments.ts`'s `waitForImportComplete`
 * already uses for a different worker-run job. See this file's header for why
 * polling here is precedented rather than invented.
 */
async function waitForPayoutSyncFinalized(
  request: APIRequestContext,
  connectionId: string,
  payoutSyncId: string,
): Promise<PayoutSyncDto> {
  let finalized: PayoutSyncDto | undefined;
  await expect(async () => {
    const syncs = await listPayoutSyncs(request, connectionId);
    const sync = syncs.find((row) => row.id === payoutSyncId);
    expect(sync).toBeDefined();
    expect(sync?.status).not.toBe('awaiting_report');
    finalized = sync;
  }).toPass({ timeout: 15_000 });
  if (finalized === undefined) {
    throw new Error(`Expected payout sync ${payoutSyncId} to finalize.`);
  }
  return finalized;
}

/** The human "Post" action: posts a `pending_review` sync's summary journal (D-237-2). */
async function postPayoutSync(
  request: APIRequestContext,
  payoutSyncId: string,
): Promise<PayoutSyncDto> {
  const response = await request.post(`/v1/processing/payout-syncs/${payoutSyncId}/post`, {
    headers: { 'idempotency-key': randomUUID() },
  });
  expect(
    response.ok(),
    `POST /v1/processing/payout-syncs/{id}/post → ${String(response.status())}`,
  ).toBeTruthy();
  return (await response.json()) as PayoutSyncDto;
}

interface PostedJournalLineDto {
  readonly accountId: string;
  readonly side: 'debit' | 'credit';
  readonly amount: string;
}

interface PostedJournalDto {
  readonly journalId: string;
  readonly lines: readonly PostedJournalLineDto[];
}

/** One posted journal with its lines (OB-236's `getJournal`) — read the same way a person would. */
async function getJournal(
  request: APIRequestContext,
  journalId: string,
): Promise<PostedJournalDto> {
  const response = await request.get(`/v1/journals/${journalId}`);
  expect(response.ok(), `GET /v1/journals/{id} → ${String(response.status())}`).toBeTruthy();
  return (await response.json()) as PostedJournalDto;
}

function lineOn(lines: readonly PostedJournalLineDto[], accountId: string): PostedJournalLineDto {
  const line = lines.find((entry) => entry.accountId === accountId);
  if (line === undefined) {
    throw new Error(`Expected a journal line posted to account ${accountId}; none was found.`);
  }
  return line;
}

test('a Stripe payout syncs to one grossed-up summary journal, reviewed and posted, and a redelivered webhook does not double it', async ({
  page,
}) => {
  const registration = newRegistration();

  let clearingAccountId: string;
  let feeAccountId: string;
  let revenueAccountId: string;
  let refundAccountId: string;
  let connectionId: string;

  await test.step('register an org with the starter chart applied, and generate fiscal year 2024', async () => {
    const response = await page.request.post('/v1/auth/register', {
      headers: { 'idempotency-key': randomUUID() },
      data: {
        email: registration.email,
        password: registration.password,
        displayName: registration.displayName,
        org: { name: registration.orgName, chartTemplateId: 'general_small_business' },
      },
    });
    expect(response.ok(), `POST /v1/auth/register → ${String(response.status())}`).toBeTruthy();

    // 2024, not "this year" — see this file's header: the fake breakdown's
    // `occurredAt` is fixed, and the summary journal dates off it.
    const fiscalYearResponse = await page.request.post('/v1/fiscal-years', {
      headers: { 'idempotency-key': randomUUID() },
      data: { fiscalYear: FISCAL_YEAR },
    });
    expect(
      fiscalYearResponse.ok(),
      `POST /v1/fiscal-years → ${String(fiscalYearResponse.status())}`,
    ).toBeTruthy();
  });

  await test.step('seed a clearing account and a payout-fee expense account, and nominate the starter chart’s revenue and contra-revenue accounts', async () => {
    // Nominate, don't invent (D-103), same as `payment-integration.spec.ts`: the
    // starter chart has no clearing account, so this org creates one.
    clearingAccountId = await createAccount(page.request, {
      code: '1071',
      name: 'Stripe payout clearing',
      type: 'asset',
      normalBalance: 'debit',
    });
    feeAccountId = await createAccount(page.request, {
      code: '6191',
      name: 'Payout processor fees',
      type: 'expense',
      normalBalance: 'debit',
    });

    // The starter chart already carries both of D-237-6's revenue-side accounts
    // (`chart-templates.ts`): 4020 "Service revenue" for `charge`, and 4090 "Sales
    // returns and allowances" — contra-revenue, normal balance debit by design —
    // for `refund`. Nominated, not created, the same as the clearing/fee pair
    // above but off the chart the org already has.
    const chart = await chartByCode(page.request);
    const revenue = chart.get('4020');
    const refund = chart.get('4090');
    if (revenue === undefined || refund === undefined) {
      throw new Error('The starter chart has no account 4020 or 4090.');
    }
    revenueAccountId = revenue;
    refundAccountId = refund;
  });

  await test.step('connect a fake processor, and switch it to summary_sales with the category mapping', async () => {
    connectionId = await connectFakeProcessor(page.request, {
      clearingAccountId,
      feeAccountId,
      webhookSecret: WEBHOOK_SECRET,
    });

    // `screens/processing.tsx` has no config form to drive this through — see this
    // file's header — so the mode switch and the D-237-6 mapping are set directly
    // against the route `usePayoutSyncConfig`'s mutation hook would otherwise call.
    // `autoPost: false` (review-first, D-237-2) — the default this narrative keeps,
    // so the payout lands as a human decision, not an automatic post.
    await configureSummarySalesPayoutSync(page.request, connectionId, [
      { reportingCategory: 'charge', accountId: revenueAccountId },
      { reportingCategory: 'fee', accountId: feeAccountId },
      { reportingCategory: 'refund', accountId: refundAccountId },
    ]);
  });

  const externalPayoutId = `po_${randomUUID()}`;
  const payoutEvent: NormalizedProcessorEvent = {
    kind: 'payout',
    externalEventId: `evt_${randomUUID()}`,
    externalObjectId: externalPayoutId,
    invoiceId: null,
    grossMinor: NET_MINOR,
    feeMinor: null,
    netMinor: NET_MINOR,
    occurredAt: new Date().toISOString(),
  };

  let payoutSyncId: string;
  let journalId: string;

  await test.step('a payout webhook arrives: per-charge posting is suppressed, and one payout sync is staged for review', async () => {
    const result = await postFakeWebhook(page.request, connectionId, WEBHOOK_SECRET, payoutEvent);
    expect(result.status).toBe('processed');

    const syncs = await listPayoutSyncs(page.request, connectionId);
    expect(syncs).toHaveLength(1);
    const sync = syncs[0];
    if (sync === undefined) throw new Error('Expected one payout sync.');

    expect(sync.externalPayoutId).toBe(externalPayoutId);
    expect(sync.status).toBe('pending_review');
    expect(sync.journalId).toBeNull();
    // `payoutTotals` in `payout-sync.service.ts`: gross = charge (+tax, absent here);
    // fee = the fee category alone; net = the breakdown's own plug.
    expect(sync.grossMinor).toBe(CHARGE_MINOR);
    expect(sync.feeMinor).toBe(FEE_MINOR);
    expect(sync.netMinor).toBe(NET_MINOR);
    expect(sync.breakdown).toHaveLength(3);
    const byCategory = new Map(sync.breakdown.map((line) => [line.reportingCategory, line]));
    expect(byCategory.get('charge')?.amountMinor).toBe(CHARGE_MINOR);
    expect(byCategory.get('fee')?.amountMinor).toBe(FEE_MINOR);
    expect(byCategory.get('refund')?.amountMinor).toBe(REFUND_MINOR);

    payoutSyncId = sync.id;

    // Nothing has posted yet — the clearing account is still untouched.
    const clearingLedger = await getGeneralLedger(page.request, clearingAccountId);
    expect(clearingLedger.closing.balance).toBe('0');
  });

  await test.step('reviewed and posted: one balanced, grossed-up summary journal', async () => {
    const posted = await postPayoutSync(page.request, payoutSyncId);
    expect(posted.status).toBe('posted');
    if (posted.journalId === null) throw new Error('Expected a journalId once posted.');
    journalId = posted.journalId;

    const journal = await getJournal(page.request, journalId);
    expect(journal.lines).toHaveLength(4);

    // Dr Clearing 9200, Dr Fees 300, Dr Refund/contra-revenue 500 — Cr Revenue
    // 10000 (this file's header): debits and credits both total 10000.
    const clearing = lineOn(journal.lines, clearingAccountId);
    expect(clearing.side).toBe('debit');
    expect(clearing.amount).toBe(NET_MINOR);

    const fee = lineOn(journal.lines, feeAccountId);
    expect(fee.side).toBe('debit');
    expect(fee.amount).toBe(FEE_MINOR);

    const refund = lineOn(journal.lines, refundAccountId);
    expect(refund.side).toBe('debit');
    expect(refund.amount).toBe(REFUND_MINOR);

    const revenue = lineOn(journal.lines, revenueAccountId);
    expect(revenue.side).toBe('credit');
    expect(revenue.amount).toBe(CHARGE_MINOR);

    // The clearing account moved by exactly the net payout — the figure the
    // eventual real bank deposit (M4's own pipeline, out of this narrative's
    // scope — `payment-integration.spec.ts` already proves that reconciliation)
    // will net back to zero, the same D-82 shape PAY's own clearing account uses.
    const clearingLedger = await getGeneralLedger(page.request, clearingAccountId);
    expect(clearingLedger.closing.balance).toBe(NET_MINOR);
  });

  await test.step('the identical webhook redelivered does not double the sync or the journal (D-237)', async () => {
    // The *same* signed delivery — same object, so `postFakeWebhook`'s
    // `JSON.stringify` reproduces byte-identical bytes and hence an identical
    // signature, exactly the redelivery a processor's own retry would send.
    const result = await postFakeWebhook(page.request, connectionId, WEBHOOK_SECRET, payoutEvent);
    expect(result.status).toBe('duplicate');

    const syncs = await listPayoutSyncs(page.request, connectionId);
    expect(syncs).toHaveLength(1);
    const sync = syncs[0];
    if (sync === undefined) throw new Error('Expected one payout sync.');
    expect(sync.id).toBe(payoutSyncId);
    expect(sync.status).toBe('posted');
    expect(sync.journalId).toBe(journalId);

    // Unchanged: no second debit against clearing.
    const clearingLedger = await getGeneralLedger(page.request, clearingAccountId);
    expect(clearingLedger.closing.balance).toBe(NET_MINOR);
  });

  // -------------------------------------------------------------------------
  // OB-237b: a manual payout — no synchronous breakdown, an async report the
  // daily sweep finalizes. See this file's header for the full picture.
  // -------------------------------------------------------------------------

  let manualConnectionId: string;
  let manualClearingAccountId: string;
  let manualFeeAccountId: string;
  let manualPayoutSyncId: string;

  await test.step('OB-237b: connect a second fake processor, auto-post, for a manual payout', async () => {
    // A second connection, not the first one reconfigured — the first stays
    // review-first (`autoPost: false`) so its own scene above is undisturbed, and
    // this scene needs `autoPost: true` so the finalize sweep below can carry a
    // resolved report all the way to `posted` in one step (this file's header).
    manualClearingAccountId = await createAccount(page.request, {
      code: '1072',
      name: 'Stripe payout clearing (manual)',
      type: 'asset',
      normalBalance: 'debit',
    });
    manualFeeAccountId = await createAccount(page.request, {
      code: '6192',
      name: 'Payout processor fees (manual)',
      type: 'expense',
      normalBalance: 'debit',
    });

    manualConnectionId = await connectFakeProcessor(page.request, {
      clearingAccountId: manualClearingAccountId,
      feeAccountId: manualFeeAccountId,
      webhookSecret: WEBHOOK_SECRET,
    });
    // The revenue/refund side of the mapping reuses the starter chart's own 4020/4090
    // (`revenueAccountId`/`refundAccountId`, nominated once above) — only the
    // clearing/fee pair is per-connection (D-103).
    await configureSummarySalesPayoutSync(
      page.request,
      manualConnectionId,
      [
        { reportingCategory: 'charge', accountId: revenueAccountId },
        { reportingCategory: 'fee', accountId: manualFeeAccountId },
        { reportingCategory: 'refund', accountId: refundAccountId },
      ],
      true,
    );
  });

  await test.step('OB-237b: a manual payout webhook arrives — no synchronous breakdown, staged awaiting_report', async () => {
    const manualExternalPayoutId = `po_manual_${randomUUID()}`;
    const manualPayoutEvent: NormalizedProcessorEvent = {
      kind: 'payout',
      externalEventId: `evt_${randomUUID()}`,
      externalObjectId: manualExternalPayoutId,
      invoiceId: null,
      grossMinor: NET_MINOR,
      feeMinor: null,
      netMinor: NET_MINOR,
      occurredAt: new Date().toISOString(),
    };

    // `providers/payment/fake.ts`'s `fetchPayoutBreakdown`: a payout object id
    // *containing* `'manual'` is the deterministic trigger for the async
    // Reporting-API path (D-237-8) — this file's header names the exact substring
    // check. Dispatch still answers `'processed'`: the event itself was recorded and
    // handled, even though the payout sync it produced carries no breakdown yet.
    const result = await postFakeWebhook(
      page.request,
      manualConnectionId,
      WEBHOOK_SECRET,
      manualPayoutEvent,
    );
    expect(result.status).toBe('processed');

    const syncs = await listPayoutSyncs(page.request, manualConnectionId);
    expect(syncs).toHaveLength(1);
    const sync = syncs[0];
    if (sync === undefined) throw new Error('Expected one payout sync.');

    expect(sync.externalPayoutId).toBe(manualExternalPayoutId);
    expect(sync.status).toBe('awaiting_report');
    expect(sync.journalId).toBeNull();
    expect(sync.reportRunId).not.toBeNull();
    // `syncPayout`'s `awaiting_report` branch (`payout-sync.service.ts`): only the
    // net is known off the payout object itself — gross/fee/breakdown fill in once
    // the finalize sweep below resolves the report.
    expect(sync.grossMinor).toBe(NET_MINOR);
    expect(sync.feeMinor).toBe('0');
    expect(sync.netMinor).toBe(NET_MINOR);
    expect(sync.breakdown).toHaveLength(0);

    manualPayoutSyncId = sync.id;

    // Nothing has posted yet — this connection's own clearing account is untouched.
    const clearingLedger = await getGeneralLedger(page.request, manualClearingAccountId);
    expect(clearingLedger.closing.balance).toBe('0');
  });

  await test.step('OB-237b: the daily sweep finalizes the report — auto-posted to the same balanced summary journal', async () => {
    // The same trigger `recurring-and-dunning.spec.ts` and
    // `fixed-assets-and-recurring-journals.spec.ts` use for their own scheduled
    // sweeps — confirmed reachable by grepping this package's specs before writing
    // this scene. It enqueues `PROCESSOR_POLL_QUEUE` (`poll.job.ts`'s
    // `registerDailyTask`) onto the self-host in-process queue and answers once the
    // sweep is *enqueued*, not once it has *run* (`enqueueDailyTasks`,
    // `modules/scheduling/tick.ts`) — so only the enqueue contract is asserted here.
    const triggerResponse = await page.request.post('/v1/scheduling/run-due-work', {
      headers: { 'idempotency-key': randomUUID() },
      data: {},
    });
    expect(
      triggerResponse.ok(),
      `POST /v1/scheduling/run-due-work → ${String(triggerResponse.status())}`,
    ).toBeTruthy();
    const triggerBody = (await triggerResponse.json()) as { runDate: string };
    expect(triggerBody.runDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // What the enqueue contract alone cannot show — that the sweep actually ran and
    // resolved this row — is read the honest way: polling the exact settled signal a
    // person reviewing "Payouts to review" would refresh on (this file's header
    // explains why that is precedented here, via `waitForImportComplete`'s own
    // idiom, rather than invented for this scene).
    const finalized = await waitForPayoutSyncFinalized(
      page.request,
      manualConnectionId,
      manualPayoutSyncId,
    );
    expect(finalized.status).toBe('posted');
    if (finalized.journalId === null) throw new Error('Expected a journalId once finalized.');

    // The report resolves to `fixedPayoutBreakdown` — the *same* fixed figures the
    // automatic scene above posts (`fake.ts`'s own header) — so this journal is
    // figure-for-figure identical, on this scene's own accounts.
    expect(finalized.grossMinor).toBe(CHARGE_MINOR);
    expect(finalized.feeMinor).toBe(FEE_MINOR);
    expect(finalized.netMinor).toBe(NET_MINOR);
    expect(finalized.breakdown).toHaveLength(3);

    const journal = await getJournal(page.request, finalized.journalId);
    expect(journal.lines).toHaveLength(4);

    const clearing = lineOn(journal.lines, manualClearingAccountId);
    expect(clearing.side).toBe('debit');
    expect(clearing.amount).toBe(NET_MINOR);

    const fee = lineOn(journal.lines, manualFeeAccountId);
    expect(fee.side).toBe('debit');
    expect(fee.amount).toBe(FEE_MINOR);

    const refund = lineOn(journal.lines, refundAccountId);
    expect(refund.side).toBe('debit');
    expect(refund.amount).toBe(REFUND_MINOR);

    const revenue = lineOn(journal.lines, revenueAccountId);
    expect(revenue.side).toBe('credit');
    expect(revenue.amount).toBe(CHARGE_MINOR);

    // This scene's own clearing account moved by exactly the net payout — proven on
    // a *different* clearing account than the automatic scene above, so this is a
    // genuinely independent debit, not a re-read of the same balance.
    const clearingLedger = await getGeneralLedger(page.request, manualClearingAccountId);
    expect(clearingLedger.closing.balance).toBe(NET_MINOR);
  });
});
