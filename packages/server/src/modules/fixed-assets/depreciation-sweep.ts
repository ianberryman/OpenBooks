import type { QueueProvider } from '@openbooks/plugin-api';

import type { RequestContext } from '../../context';
import { bufferToUuid, systemDb, uuidToBuffer } from '../../db';
import type { Logger } from '../../logging';
import { postJournal } from '../ledger';
import { registerDailyTask, runAsAutomation } from '../scheduling';

import type { FixedAssetDepreciationSweepPayload } from './job';
import { FIXED_ASSET_DEPRECIATION_SWEEP_QUEUE } from './job';
import type { DueScheduleRow } from './fixed-assets.repository';
import {
  markScheduleRowPosted,
  orgScope,
  selectDueScheduleRows,
  selectScheduleRowByIdForUpdate,
} from './fixed-assets.repository';

/**
 * The depreciation sweep (OB-165; ROADMAP D-113).
 *
 * Two halves, `invoicing/recurring/engine.ts`'s own seam between them, the org:
 *
 *  - `runDepreciationSweep` runs once per tick with no org yet — that is the
 *    question it answers. It reads across every org through `systemDb()`
 *    (`selectDueScheduleRows`'s own commentary argues why that read is
 *    sanctioned to bypass `tenantDb`) and hands each due period to
 *    `runAsAutomation`, which is what actually opens the org's scope.
 *  - `postOnePeriod` runs once per period, inside the org `runAsAutomation`
 *    opened, under a system/automation actor so the journal it posts still
 *    carries real provenance (D-89, spec §6). The reload under lock, the
 *    idempotency check, and the post are all one `orgScope(ctx).transaction`,
 *    so a crash mid-period leaves the row exactly as due as it was and the
 *    next tick retries it whole.
 *
 * `transaction-scope.ts` is explicit that a job sweeping many orgs must not
 * open one outer transaction across the sweep. `runDepreciationSweep` does
 * not: each period's transaction is opened inside `postOnePeriod`, after
 * `runAsAutomation` has re-scoped to that period's own org, and one period's
 * failure (caught and logged) does not unwind another's.
 */

export interface DepreciationSweepDeps {
  readonly logger: Logger;
}

/**
 * Registers the sweep on the daily tick and on the queue it rides —
 * `registerRecurringJob`'s own one line of wiring. `registerDailyTask` is what
 * makes `FIXED_ASSET_DEPRECIATION_SWEEP_QUEUE` fire once a day with today's
 * date as its payload; `queue.subscribe` is what makes that payload reach this
 * handler.
 */
export async function registerFixedAssetDepreciationJob(
  queue: QueueProvider,
  deps: DepreciationSweepDeps,
): Promise<void> {
  registerDailyTask(FIXED_ASSET_DEPRECIATION_SWEEP_QUEUE);
  await queue.subscribe(FIXED_ASSET_DEPRECIATION_SWEEP_QUEUE, createDepreciationSweepHandler(deps));
}

/** The sweep handler, over any deps — the worker's registration, a test's own. */
export function createDepreciationSweepHandler(
  deps: DepreciationSweepDeps,
): (payload: FixedAssetDepreciationSweepPayload) => Promise<void> {
  return (payload) => runDepreciationSweep(payload, deps);
}

/**
 * Every period due by `runDate`, across every org, each posted under its own
 * asset's org scope.
 *
 * One period's failure is logged and does not stop the sweep: a bad
 * period — an account deactivated out from under it — must not hold every
 * other org's depreciation hostage for a day. It stays due (nothing here marks
 * it posted on the failing path) and is retried on the next tick.
 */
export async function runDepreciationSweep(
  payload: FixedAssetDepreciationSweepPayload,
  deps: DepreciationSweepDeps,
): Promise<void> {
  const due = await selectDueScheduleRows(systemDb(), payload.runDate);

  for (const row of due) {
    const orgId = bufferToUuid(row.orgId);
    const fixedAssetId = bufferToUuid(row.fixedAssetId);

    try {
      await runAsAutomation(orgId, fixedAssetId, (ctx) => postOnePeriod(row, ctx));
    } catch (error) {
      deps.logger.error(
        { orgId, fixedAssetId, scheduleRowId: row.id.toString(), err: error },
        'Depreciation period failed to post; it stays due and is retried on the next tick.',
      );
    }
  }
}

/**
 * Posts one due period's depreciation journal, and marks the row posted.
 *
 * Idempotency comes first, under the row lock: D-113's once-per-period guard.
 * `posted_journal_id IS NOT NULL` after the reload means a previous invocation
 * — a crashed worker, a slow restart, a re-enqueue — already posted this exact
 * period, so this one does nothing. `payload.runDate` never appears here: the
 * period posts as of its own `period_date`, not the wall-clock day the sweep
 * happened to run, so an asset overdue by more than one period catches up one
 * period per tick rather than posting every missed period at once —
 * `materializeCycle`'s own reasoning, restated for a schedule row instead of a
 * recurring cycle.
 */
export async function postOnePeriod(row: DueScheduleRow, ctx: RequestContext): Promise<void> {
  await orgScope(ctx).transaction(async (trx) => {
    const current = await selectScheduleRowByIdForUpdate(trx, row.id);
    // Gone (the asset was disposed and its unposted rows deleted), or already
    // posted by an earlier invocation — nothing to do.
    if (current === undefined || current.postedJournalId !== null) return;

    if (current.depreciationAmountMinor === 0n) {
      // Nothing to post — `postJournal` refuses a zero-amount line, and a zero
      // period is a real, reachable output of `computeDepreciationSchedule`
      // (a base far smaller than its own life floors most periods to zero).
      // Left due rather than marked posted, since there is no journal for
      // `posted_journal_id` to point at; the sweep reconsiders it on every
      // subsequent tick, harmlessly, since it computes to zero every time.
      return;
    }

    const posted = await postJournal(
      {
        date: current.periodDate,
        source: 'depreciation',
        actorType: ctx.actorType,
        actorId: ctx.actorId,
        ...(ctx.invocationMode === undefined ? {} : { invocationMode: ctx.invocationMode }),
        lines: [
          {
            accountId: bufferToUuid(row.depreciationExpenseAccountId),
            side: 'debit',
            amount: current.depreciationAmountMinor,
          },
          {
            accountId: bufferToUuid(row.accumulatedDepreciationAccountId),
            side: 'credit',
            amount: current.depreciationAmountMinor,
          },
        ],
      },
      ctx,
    );

    await markScheduleRowPosted(trx, current.id, uuidToBuffer(posted.journalId));
  });
}
