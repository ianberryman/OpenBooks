import { describe, expect, it } from 'vitest';

import {
  finalizePayoutReports,
  listPayoutSyncs,
  updatePayoutSyncConfig,
} from '../../src/modules/payments-processing';

import {
  connectFakeProcessor,
  journalByMemo,
  linesOfJournal,
  payoutEvent,
  processorEventsCount,
  recordEvent,
  sceneIn,
  usePayProcessingApp,
  withContext,
  type Scene,
} from './support';

/**
 * OB-237b: the manual-payout async Reporting-API path (D-237-8…10) and the
 * "skip-and-flag" fix for a silently swallowed breakdown-fetch failure
 * (D-237-11) — proved against real MySQL (spec §11), using the deterministic
 * `fake` processor's string-routed `fetchPayoutBreakdown`/`fetchPayoutReport`
 * (`providers/payment/fake.ts`): a payout id containing `'boom'` rejects, one
 * containing `'manual'` returns `awaiting_report`, and a report run id
 * containing `'pending'` stays pending. Mirrors `idempotency.property.test.ts`'s
 * harness use (`usePayProcessingApp`, `sceneIn`, `recordEvent`).
 */
const harness = usePayProcessingApp();
const db = harness.db;

/** A `summary_sales` fake connection with `charge`/`refund` mapped to the scene's revenue account (D-237-1). */
async function configuredSummarySalesConnection(
  scene: Scene,
  autoPost: boolean,
): Promise<{ id: string }> {
  // `providers/payment/fake.ts`'s `fixedPayoutBreakdown()` hardcodes
  // `occurredAt: '2024-01-01T00:00:00.000Z'` for every payout id, regardless of
  // the triggering event's own `occurredAt` — `postSummaryJournal` posts on the
  // *breakdown's* date (`payout-sync.service.ts`), not the event's. `sceneIn`'s
  // fiscal period defaults to 2026 (`test/db/factories.ts`), which does not cover
  // 2024, so a scene that will actually post a summary journal needs its own 2024
  // period too, or `assertPostable` refuses with `period_missing` before this
  // suite ever reaches the property under test.
  await db.factories.fiscalPeriod({
    orgId: scene.orgId,
    startDate: '2024-01-01',
    endDate: '2024-12-31',
  });

  const { connection } = await connectFakeProcessor(scene);
  await withContext(scene.ctx, () =>
    updatePayoutSyncConfig(
      connection.id,
      {
        syncMode: 'summary_sales',
        autoPost,
        entries: [
          { reportingCategory: 'charge', accountId: scene.income.uuid },
          { reportingCategory: 'refund', accountId: scene.income.uuid },
        ],
      },
      scene.ctx,
    ),
  );
  return connection;
}

describe('D-237-8/10: a manual payout stages awaiting_report, then the sweep finalizes it', () => {
  it('finalizes to one balanced posted journal once the report resolves', async () => {
    const scene = await sceneIn(db);
    const connection = await configuredSummarySalesConnection(scene, true);

    const event = payoutEvent({
      externalObjectId: 'po_manual_1',
      externalEventId: 'evt_manual_1',
      netMinor: '9200',
    });
    const result = await recordEvent(scene.ctx, connection.id, 'fake', event);
    expect(result.status).toBe('processed');

    const staged = await withContext(scene.ctx, () =>
      listPayoutSyncs(connection.id, undefined, scene.ctx),
    );
    expect(staged).toHaveLength(1);
    expect(staged[0]?.status).toBe('awaiting_report');
    expect(staged[0]?.reportRunId).not.toBeNull();
    expect(staged[0]?.journalId).toBeNull();

    await withContext(scene.ctx, () => finalizePayoutReports(connection.id, scene.ctx));

    const finalized = await withContext(scene.ctx, () =>
      listPayoutSyncs(connection.id, undefined, scene.ctx),
    );
    expect(finalized).toHaveLength(1);
    expect(finalized[0]?.status).toBe('posted');
    expect(finalized[0]?.journalId).not.toBeNull();

    // The posted journal: the fake's fixed breakdown (charge 10000, fee 300,
    // refund 500, net 9200 — `summary-journal.builder.test.ts`'s own numbers),
    // balanced and with the clearing account debited the net.
    const journal = await journalByMemo(db.app, scene.orgId, 'stripe payout po_manual_1');
    const lines = await linesOfJournal(db.app, journal.id);
    const debitTotal = lines.reduce((total, line) => total + line.debit_minor, 0n);
    const creditTotal = lines.reduce((total, line) => total + line.credit_minor, 0n);
    expect(debitTotal).toBe(creditTotal);
    expect(debitTotal).toBe(10_000n);

    const clearingLine = lines.find((line) => line.account_id.equals(scene.clearing.id));
    expect(clearingLine?.debit_minor).toBe(9_200n);
  });
});

describe('D-237-11: a failed breakdown fetch is a visible skipped row, not a swallowed failure', () => {
  it('records a skipped payout_syncs row with a breakdown_failed reason and still marks the webhook processed', async () => {
    const scene = await sceneIn(db);
    const connection = await configuredSummarySalesConnection(scene, true);

    const before = await processorEventsCount(db.app, scene.orgId);

    const event = payoutEvent({
      externalObjectId: 'po_boom_1',
      externalEventId: 'evt_boom_1',
      netMinor: '0',
    });
    const result = await recordEvent(scene.ctx, connection.id, 'fake', event);
    // The breakdown-fetch throw is caught inside `syncPayout` and turned into a
    // visible `skipped` row (D-237-11) — the outer webhook delivery is never
    // marked 'failed', which is what left the original manual-payout failure
    // invisible.
    expect(result.status).toBe('processed');
    expect(result.status).not.toBe('failed');

    const synced = await withContext(scene.ctx, () =>
      listPayoutSyncs(connection.id, undefined, scene.ctx),
    );
    expect(synced).toHaveLength(1);
    expect(synced[0]?.status).toBe('skipped');
    expect(synced[0]?.skipReason?.startsWith('breakdown_failed:')).toBe(true);

    await expect(journalByMemo(db.app, scene.orgId, 'stripe payout po_boom_1')).rejects.toThrow();

    // The event was still recorded — just marked processed, not dropped.
    expect(await processorEventsCount(db.app, scene.orgId)).toBe(before + 1);
  });
});

describe('D-237-10: a still-pending report never posts', () => {
  it('leaves the row awaiting_report with no journal when the sweep finds the report unfinished', async () => {
    const scene = await sceneIn(db);
    const connection = await configuredSummarySalesConnection(scene, true);

    // `fake_report_po_manual_pending_1` contains 'pending', so
    // `fetchPayoutReport` keeps returning `{ kind: 'pending' }` (providers/payment/fake.ts).
    const event = payoutEvent({
      externalObjectId: 'po_manual_pending_1',
      externalEventId: 'evt_pending_1',
      netMinor: '9200',
    });
    const result = await recordEvent(scene.ctx, connection.id, 'fake', event);
    expect(result.status).toBe('processed');

    await withContext(scene.ctx, () => finalizePayoutReports(connection.id, scene.ctx));

    const synced = await withContext(scene.ctx, () =>
      listPayoutSyncs(connection.id, undefined, scene.ctx),
    );
    expect(synced).toHaveLength(1);
    expect(synced[0]?.status).toBe('awaiting_report');
    expect(synced[0]?.journalId).toBeNull();
  });
});
