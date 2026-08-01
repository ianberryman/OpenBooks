import type { QueueProvider } from '@openbooks/plugin-api';

import { registerDailyTask } from '../scheduling';
import type { DailyTaskPayload } from '../scheduling';

import type { BankFeedSyncDeps } from './feed-sync.service';
import { runBankFeedSync } from './feed-sync.service';

/**
 * The D-129 live-feed sync on the OB-127 scheduler — the worker's one line of wiring,
 * `payments-processing/poll.job.ts`'s `registerProcessorPollJob` shape exactly.
 *
 * The daily tick only enqueues; this handler does the cross-org sweep off the request
 * path (the statement-import discipline, D-47). A missed tick self-heals: the sync is
 * idempotent (the fingerprint unique key collapses a re-pull, D-127) and the cursor
 * advances only on success (D-128), so the next tick catches up rather than
 * double-importing.
 */

export const BANK_FEED_SYNC_QUEUE = 'banking.feed-sync';

/** Registers the sweep on the daily tick and the queue it rides. */
export async function registerBankFeedSyncJob(
  queue: QueueProvider,
  deps: BankFeedSyncDeps,
): Promise<void> {
  registerDailyTask(BANK_FEED_SYNC_QUEUE);
  await queue.subscribe(BANK_FEED_SYNC_QUEUE, createBankFeedSyncHandler(deps));
}

/** The sweep handler, over any deps — the worker's registration, a test's own. */
export function createBankFeedSyncHandler(
  deps: BankFeedSyncDeps,
): (payload: DailyTaskPayload) => Promise<void> {
  // The payload carries the run date, but the sweep worklist is "every active
  // connection" regardless of date (each connection resumes from its own cursor, D-128),
  // so it is accepted and unused — the `DailyTaskPayload` handler shape the tick fans out.
  return (_payload) => runBankFeedSync(deps);
}
