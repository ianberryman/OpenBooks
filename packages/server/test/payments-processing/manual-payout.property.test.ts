import { describe, expect, it } from 'vitest';

import { listPayoutSyncs, updatePayoutSyncConfig } from '../../src/modules/payments-processing';

import {
  connectFakeProcessor,
  journalByMemo,
  payoutEvent,
  processorEventsCount,
  recordEvent,
  sceneIn,
  usePayProcessingApp,
  withContext,
  type Scene,
} from './support';

/**
 * OB-237b correction: a manual payout has no per-payout breakdown in *any* Stripe
 * API (the `balance_transactions?payout=` filter and the `payout_reconciliation`
 * report both require an automatic payout — confirmed live), so it is recorded as a
 * *visible* `skipped` row rather than posted or silently swallowed. This proves the
 * two surviving behaviours against real MySQL (spec §11), using the deterministic
 * `fake` processor's string-routed `fetchPayoutBreakdown` (`providers/payment/fake.ts`):
 * a payout id containing `'manual'` resolves `unsupported`, one containing `'boom'`
 * rejects. Full manual-payout support is OB-237c (period/balance-driven recognition).
 * Mirrors `idempotency.property.test.ts`'s harness use (`usePayProcessingApp`,
 * `sceneIn`, `recordEvent`).
 */
const harness = usePayProcessingApp();
const db = harness.db;

/** A `summary_sales` fake connection with `charge`/`refund` mapped to the scene's revenue account (D-237-1). */
async function configuredSummarySalesConnection(
  scene: Scene,
  autoPost: boolean,
): Promise<{ id: string }> {
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

describe('D-237-8-rev: a manual payout is an unsupported → visible skip, never a journal', () => {
  it('records a skipped row with the actionable manual-payout reason and posts nothing', async () => {
    const scene = await sceneIn(db);
    const connection = await configuredSummarySalesConnection(scene, true);

    // `providers/payment/fake.ts` routes a payout id containing 'manual' to
    // `{ kind: 'unsupported' }` — the real adapter's behaviour for `automatic: false`.
    const event = payoutEvent({
      externalObjectId: 'po_manual_1',
      externalEventId: 'evt_manual_1',
      netMinor: '9200',
    });
    const result = await recordEvent(scene.ctx, connection.id, 'fake', event);
    expect(result.status).toBe('processed');

    const synced = await withContext(scene.ctx, () =>
      listPayoutSyncs(connection.id, undefined, scene.ctx),
    );
    expect(synced).toHaveLength(1);
    // Never staged for an async report (that lifecycle is gone), never posted.
    expect(synced[0]?.status).toBe('skipped');
    expect(synced[0]?.journalId).toBeNull();
    expect(synced[0]?.skipReason).toBe(
      'manual_payout_unsupported:summary_sales requires automatic payouts',
    );

    // No summary journal was posted for the manual payout.
    await expect(journalByMemo(db.app, scene.orgId, 'stripe payout po_manual_1')).rejects.toThrow();
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
