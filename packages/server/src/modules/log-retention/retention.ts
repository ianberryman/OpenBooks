import type { QueueProvider } from '@openbooks/plugin-api';

import { runDetached, systemDb } from '../../db';
import type { Logger } from '../../logging';
import { registerDailyTask } from '../scheduling';
import type { DailyTaskPayload } from '../scheduling';

/**
 * The `logs` retention prune (OB-255; ROADMAP D-255-3).
 *
 * `0026_logs`'s own header explains why `logs` is a MUTABLE table rather than
 * append-only: a log line is operational telemetry, not a financial record or
 * evidence, and there is no maintenance-role job in this codebase to run a prune
 * as — `purgeExpiredIdempotencyKeys` is the only existing precedent, and it too
 * runs as the app user because `idempotency_keys` is mutable for the same reason.
 * So this sweep deletes as `openbooks_app`, the grant `0999_app_grants` gives it
 * for exactly this purpose.
 *
 * ## Global, not per-org
 *
 * `recurring-journals/engine.ts` and `fixed-assets/depreciation-sweep.ts` are the
 * shape this module copies for registration, but neither's per-org
 * `runAsAutomation` loop applies here: `logs.org_id` is nullable (`tenant-tables.ts`'s
 * `SharedScopeTable`, the `roles` precedent) and the retention window is one
 * property of the deployment, not of an org — a boot/migration line has no org at
 * all, and a request line's org is not a reason to keep it longer or prune it
 * sooner. One `systemDb()` delete covers every row, so there is no org to iterate
 * and no automation context to open.
 */

export const LOG_RETENTION_SWEEP_QUEUE = 'logs.retention-sweep';

/** Rows are deleted `BATCH` at a time — `idempotency/service.ts`'s `purgeStore` shape. */
const BATCH = 5000;

export interface LogRetentionDeps {
  readonly logger: Logger;
  readonly retentionDays: number;
}

/**
 * Registers the sweep on the daily tick and on the queue it rides —
 * `registerRecurringJournalJob`'s one line of wiring. `registerDailyTask` is what
 * makes `LOG_RETENTION_SWEEP_QUEUE` fire once a day with today's date as its
 * payload; `queue.subscribe` is what makes that payload reach this handler.
 */
export async function registerLogRetentionJob(
  queue: QueueProvider,
  deps: LogRetentionDeps,
): Promise<void> {
  registerDailyTask(LOG_RETENTION_SWEEP_QUEUE);
  await queue.subscribe(LOG_RETENTION_SWEEP_QUEUE, createLogRetentionSweepHandler(deps));
}

/** The sweep handler, over any deps — the worker's registration, a test's own. */
export function createLogRetentionSweepHandler(
  deps: LogRetentionDeps,
): (payload: DailyTaskPayload) => Promise<void> {
  return (payload) => runLogRetentionSweep(payload, deps);
}

/**
 * Deletes every `logs` row older than `deps.retentionDays`, counted back from the
 * tick's own `runDate` rather than wall-clock `Date.now()` — the same reason
 * `materializeCycle`/`postOnePeriod` key off their own due date instead of the
 * moment the sweep happens to run: it makes the cutoff a deterministic function of
 * the payload, not of when the worker got around to it.
 *
 * Runs inside `runDetached` so the batched delete never joins a request's ambient
 * transaction (`transaction-scope.ts`) — this sweep is dispatched off the queue,
 * outside any request, but `runDetached` is cheap insurance against a future
 * caller that invokes it from inside one.
 *
 * A failure here is caught and logged, not rethrown: this is telemetry
 * housekeeping, not a ledger write, and the sweep is naturally idempotent (the
 * cutoff is a pure function of `runDate`) — the next daily tick retries the same
 * work, so crashing the worker over a stuck prune would be strictly worse than
 * leaving `logs` to grow one more day.
 */
export async function runLogRetentionSweep(
  payload: DailyTaskPayload,
  deps: LogRetentionDeps,
): Promise<void> {
  const cutoff = new Date(`${payload.runDate}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - deps.retentionDays);

  try {
    let purged = 0;

    await runDetached(async () => {
      for (;;) {
        const result = await systemDb()
          .deleteFrom('logs')
          .where('logged_at', '<', cutoff)
          .limit(BATCH)
          .executeTakeFirst();

        const deleted = Number(result.numDeletedRows);
        purged += deleted;
        if (deleted < BATCH) break;
      }
    });

    deps.logger.info(
      { purged, cutoff: cutoff.toISOString(), retentionDays: deps.retentionDays },
      'Pruned expired application logs.',
    );
  } catch (error) {
    deps.logger.error(
      { err: error, cutoff: cutoff.toISOString(), retentionDays: deps.retentionDays },
      'Log retention sweep failed; it is idempotent and the next daily tick retries it.',
    );
  }
}
