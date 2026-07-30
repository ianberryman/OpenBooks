import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

import { currentMonth, newRegistration } from './support/books';
import { createAccount } from './support/payments';

/**
 * The initiative-L narrative — fixed assets and recurring GL journals (OB-162…169;
 * ROADMAP D-90, D-113…D-117).
 *
 * Two engines land together in this initiative and share one scheduler seam: a fixed
 * asset's depreciation schedule is precomputed in full at registration and posted one
 * due period at a time by the daily sweep, and a recurring GL journal template posts
 * its fixed, balanced lines verbatim on its own cadence — both are queues the same
 * `POST /v1/scheduling/run-due-work` fans out to (`fixed-assets/job.ts`'s own
 * comment: "riding OB-127's daily tick"; `recurring-journals/job.ts` the same). This
 * is their one browser proof (D-26): register an asset with a short, straight-line
 * life in service today, run the scheduler the way the daily tick would, build a
 * recurring journal template due today, run the scheduler again, and dispose of the
 * asset.
 *
 * ## Why this narrative is API-first, like OB-142's and OB-153's
 *
 * Neither surface has a screen yet — `packages/web/src` carries no fixed-assets or
 * recurring-journals directory — so there is no click path to drive even if one were
 * wanted. The assertions that matter are the same kind `pay-bills.spec.ts` and
 * `cash-application.spec.ts` reach for: a registered asset's own numbers, its
 * depreciation schedule's shape, and a disposal's outcome, read off
 * `POST/GET /v1/fixed-assets` and `POST /v1/recurring-journals` exactly as an MCP
 * tool or a future screen would reach them, not scraped off a UI that does not exist.
 * Registration itself is the one screen this narrative could use
 * (`recurring-and-dunning.spec.ts`'s own UI flow), but `pay-bills.spec.ts` and
 * `cash-application.spec.ts` already register the identical way through
 * `POST /v1/auth/register` — the same login, the same first organization, one
 * screen fewer to drive for a fact the UI narratives already prove.
 *
 * ## What this narrative does not claim
 *
 * `POST /v1/scheduling/run-due-work` enqueues the sweep onto the self-host
 * in-process queue (`providers/queue/in-process.ts`) and answers 200 once the job is
 * *enqueued*, not once it has *run* — `recurring-and-dunning.spec.ts`'s own header
 * gives the full reasoning, and it applies here for both queues this route fans out
 * to. So this narrative proves exactly what the contract promises — a 200 naming the
 * date the sweep was enqueued for — and stops short of asserting that a depreciation
 * journal or a recurring-journal cycle has actually posted by the time the next
 * assertion runs. Every place that matters is marked `// ORCHESTRATOR:` below, the
 * same convention that file uses.
 *
 * ## The depreciation arithmetic, written down (L6)
 *
 * ```
 *   acquisition cost   300000  (3,000.00)
 *   salvage value        25000  (  250.00)
 *   depreciable base    275000  (2,750.00)  — over 3 monthly periods
 * ```
 *
 * `computeDepreciationSchedule` floors each period and trues up the last
 * (`depreciation.ts`'s own header), so the schedule's own sum is asserted here
 * rather than each period's individual amount — the one invariant every caller may
 * rely on regardless of how the floor division falls.
 */

const ACQUISITION_COST_MINOR = '300000'; // 3,000.00
const SALVAGE_VALUE_MINOR = '25000'; // 250.00
const DEPRECIABLE_BASE_MINOR = 275000n; // 300000 − 25000
const USEFUL_LIFE_MONTHS = 3;

const ASSET_NAME = 'Delivery van';
const TEMPLATE_NAME = 'Monthly administrative accrual';
const TEMPLATE_LINE_AMOUNT_MINOR = '5000'; // 50.00

// The disposal: sold for less than its acquisition cost with nothing yet
// depreciated (the sweep's own settle-timing caveat above means the schedule may
// still show zero accumulated depreciation when this runs) — a straightforward
// loss on disposal.
const PROCEEDS_MINOR = '200000'; // 2,000.00

interface FixedAssetResponse {
  readonly id: string;
  readonly status: string;
  readonly disposedDate: string | null;
  readonly disposalJournalId: string | null;
}

interface FixedAssetScheduleRow {
  readonly periodIndex: number;
  readonly periodDate: string;
  readonly depreciationAmountMinor: string;
  readonly postedJournalId: string | null;
}

interface RecurringJournalTemplateResponse {
  readonly id: string;
  readonly nextRunDate: string;
  readonly lastRunDate: string | null;
  readonly isActive: boolean;
}

test('a fixed asset is registered and its depreciation schedule computed, a recurring GL template is scheduled, and the asset is disposed', async ({
  page,
}) => {
  const registration = newRegistration();
  const month = currentMonth();
  const fiscalYear = new Date().getFullYear();
  // In service today, and the template's own `startDate` below is today too —
  // the only way to prove "due" without waiting for a real calendar day to pass
  // (`recurring-and-dunning.spec.ts`'s own reason for the same choice).
  const today = month.day(new Date().getDate());

  await test.step('register an org with the starter chart applied, and generate its fiscal year', async () => {
    // The register payload's own nested `org` shape (`createOrgRequestSchema`)
    // applies the chart in the same transaction (`orgs.service.ts`'s
    // `createOrgIn`) — the same call `pay-bills.spec.ts` and
    // `cash-application.spec.ts` both make.
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

    // Nothing posts before a fiscal year exists (D-17) — the depreciation sweep,
    // the recurring-journal cycle, and the disposal journal below all need this.
    const fiscalYearResponse = await page.request.post('/v1/fiscal-years', {
      headers: { 'idempotency-key': randomUUID() },
      data: { fiscalYear },
    });
    expect(
      fiscalYearResponse.ok(),
      `POST /v1/fiscal-years → ${String(fiscalYearResponse.status())}`,
    ).toBeTruthy();
  });

  // The starter chart (`general_small_business`) carries no fixed-asset accounts at
  // all — no asset-cost account for a piece of equipment, no accumulated-
  // depreciation contra-asset, no depreciation-expense line, and nothing shaped for
  // a disposal's proceeds or gain/loss — so every account this narrative needs is
  // nominated by hand, `depreciation-sweep.test.ts`'s own fixture shape (asset:
  // asset/debit, accumulated depreciation: asset/credit, gain/loss: revenue/credit).
  let assetAccountId: string;
  let accumulatedDepreciationAccountId: string;
  let depreciationExpenseAccountId: string;
  let proceedsAccountId: string;
  let gainLossAccountId: string;

  await test.step('nominate the accounts a fixed asset and its disposal need', async () => {
    assetAccountId = await createAccount(page.request, {
      code: '1800',
      name: 'Delivery vehicles',
      type: 'asset',
      normalBalance: 'debit',
    });
    accumulatedDepreciationAccountId = await createAccount(page.request, {
      code: '1810',
      name: 'Accumulated depreciation — delivery vehicles',
      type: 'asset',
      normalBalance: 'credit',
    });
    depreciationExpenseAccountId = await createAccount(page.request, {
      code: '6800',
      name: 'Depreciation expense',
      type: 'expense',
      normalBalance: 'debit',
    });
    proceedsAccountId = await createAccount(page.request, {
      code: '1820',
      name: 'Proceeds on disposal of fixed assets',
      type: 'asset',
      normalBalance: 'debit',
    });
    gainLossAccountId = await createAccount(page.request, {
      code: '4900',
      name: 'Gain/loss on disposal of fixed assets',
      type: 'revenue',
      normalBalance: 'credit',
    });
  });

  let fixedAssetId: string;

  await test.step('register a straight-line fixed asset, in service today, with a short three-month life', async () => {
    const response = await page.request.post('/v1/fixed-assets', {
      headers: { 'idempotency-key': randomUUID() },
      data: {
        name: ASSET_NAME,
        assetAccountId,
        accumulatedDepreciationAccountId,
        depreciationExpenseAccountId,
        acquisitionCostMinor: ACQUISITION_COST_MINOR,
        salvageValueMinor: SALVAGE_VALUE_MINOR,
        method: 'straight_line',
        usefulLifeMonths: USEFUL_LIFE_MONTHS,
        decliningRatePpm: null,
        inServiceDate: today,
      },
    });
    expect(response.ok(), `POST /v1/fixed-assets → ${String(response.status())}`).toBeTruthy();

    const asset = (await response.json()) as FixedAssetResponse;
    expect(asset.status).toBe('active');
    expect(asset.disposedDate).toBeNull();
    fixedAssetId = asset.id;
  });

  await test.step('run the scheduler now, the same fan-out the daily tick performs unattended', async () => {
    // ORCHESTRATOR: there is no button for this — the depreciation sweep and the
    // recurring-journal sweep are both registered daily tasks
    // (`fixed-assets/job.ts`, `recurring-journals/job.ts`), and the only door onto
    // either is this one manual trigger, which enqueues rather than runs
    // synchronously (see the file header). So this step proves the one thing the
    // contract actually guarantees — a 200 naming the date the sweep was enqueued
    // for — and stops short of asserting that today's depreciation period has
    // actually posted by the time the schedule is read back below.
    const response = await page.request.post('/v1/scheduling/run-due-work', {
      headers: { 'idempotency-key': randomUUID() },
      data: {},
    });
    expect(
      response.ok(),
      `POST /v1/scheduling/run-due-work → ${String(response.status())}`,
    ).toBeTruthy();

    const body = (await response.json()) as { runDate: string };
    expect(body.runDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  await test.step('read the schedule back — every period present, summing exactly to the depreciable base (L6)', async () => {
    const response = await page.request.get(`/v1/fixed-assets/${fixedAssetId}/schedule`);
    expect(
      response.ok(),
      `GET /v1/fixed-assets/{id}/schedule → ${String(response.status())}`,
    ).toBeTruthy();

    const schedule = (await response.json()) as readonly FixedAssetScheduleRow[];
    expect(schedule).toHaveLength(USEFUL_LIFE_MONTHS);
    expect(schedule.map((row) => row.periodIndex)).toEqual([0, 1, 2]);

    // L6's own invariant, summed as `bigint` over the cents strings — adding them
    // as numbers is the float this whole system exists to keep out (D-13).
    const sum = schedule.reduce((total, row) => total + BigInt(row.depreciationAmountMinor), 0n);
    expect(sum).toBe(DEPRECIABLE_BASE_MINOR);

    // ORCHESTRATOR: `postedJournalId` is HTTP-observable here, but whether it is
    // already set for period 0 depends on the same settle-timing caveat as the
    // trigger step above — the sweep enqueued by `run-due-work` may not have run
    // yet on this turn of the event loop. This narrative asserts only the shape
    // every row carries either way (present, `null` or a `uuid`), not which value
    // period 0 holds.
    for (const row of schedule) {
      expect(row.postedJournalId === null || typeof row.postedJournalId === 'string').toBe(true);
    }
  });

  await test.step('build a recurring GL journal template, due today, and schedule it', async () => {
    // The template's two lines reuse two of the accounts nominated above rather
    // than nominate two more just for this step: a recurring GL journal has no
    // necessary connection to fixed assets (D-90's fixed-line scope is generic
    // accounts/side/amount), and inventing accounts solely to give this step
    // something to post would be exactly what D-103's "nominate, don't invent"
    // argues against.
    const response = await page.request.post('/v1/recurring-journals', {
      headers: { 'idempotency-key': randomUUID() },
      data: {
        name: TEMPLATE_NAME,
        materializationMode: 'posted',
        frequency: 'monthly',
        intervalCount: 1,
        // `startDate` seeds `nextRunDate` and is not itself stored
        // (`recurring-journals.ts`'s own header) — today is the one value that
        // makes the first cycle due the moment the scheduler is asked to run it.
        startDate: today,
        lines: [
          {
            accountId: proceedsAccountId,
            side: 'debit',
            amount: TEMPLATE_LINE_AMOUNT_MINOR,
            description: 'Monthly accrual, line 1',
          },
          {
            accountId: gainLossAccountId,
            side: 'credit',
            amount: TEMPLATE_LINE_AMOUNT_MINOR,
            description: 'Monthly accrual, line 2',
          },
        ],
      },
    });
    expect(
      response.ok(),
      `POST /v1/recurring-journals → ${String(response.status())}`,
    ).toBeTruthy();

    const template = (await response.json()) as RecurringJournalTemplateResponse;
    expect(template.nextRunDate).toBe(today);
    expect(template.lastRunDate).toBeNull();
    expect(template.isActive).toBe(true);

    // ORCHESTRATOR: same caveat as the fixed-asset trigger above — this is the
    // recurring-journal sweep's own due cycle, enqueued onto the same in-process
    // queue, and this narrative asserts only the trigger route's own guarantee.
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
  });

  await test.step('dispose of the asset, recognising the loss against proceeds', async () => {
    const response = await page.request.post(`/v1/fixed-assets/${fixedAssetId}/dispose`, {
      headers: { 'idempotency-key': randomUUID() },
      data: {
        date: today,
        proceedsMinor: PROCEEDS_MINOR,
        proceedsAccountId,
        gainLossAccountId,
      },
    });
    expect(
      response.ok(),
      `POST /v1/fixed-assets/{id}/dispose → ${String(response.status())}`,
    ).toBeTruthy();

    const disposed = (await response.json()) as FixedAssetResponse;
    expect(disposed.status).toBe('disposed');
    expect(disposed.disposedDate).toBe(today);
    expect(disposed.disposalJournalId).not.toBeNull();

    // A fresh read confirms the disposal is durable, not just the mutation
    // response's own echo.
    const reread = await page.request.get(`/v1/fixed-assets/${fixedAssetId}`);
    expect(reread.ok(), `GET /v1/fixed-assets/{id} → ${String(reread.status())}`).toBeTruthy();
    const rereadAsset = (await reread.json()) as FixedAssetResponse;
    expect(rereadAsset.status).toBe('disposed');
    expect(rereadAsset.disposalJournalId).toBe(disposed.disposalJournalId);
  });
});
