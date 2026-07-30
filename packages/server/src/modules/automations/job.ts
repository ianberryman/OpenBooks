import type { QueueProvider } from '@openbooks/plugin-api';

import type { RequestContext } from '../../context';
import { bufferToUuid, systemDb, tenantDb } from '../../db';
import type { Logger } from '../../logging';
import type { DailyTaskPayload } from '../scheduling';
import { registerDailyTask, runAsAutomation } from '../scheduling';

import { executeAutomation } from './engine';
import type { AutomationRow } from './repository';
import {
  advanceAutomationFiredDate,
  advanceCursorPosition,
  orgScope,
  requeueExpiredWorkItem,
  selectActiveEventAutomations,
  selectAutomationByIdForUpdate,
  selectDueScheduledAutomations,
  selectEventLogPageAfter,
  selectExpiredLeasedWorkItems,
  selectOrCreateCursorPosition,
  selectOrgIdsWithActiveEventAutomations,
  selectOrgIdsWithExpiredLeases,
  toAutomation,
  toEventPayload,
} from './repository';

/**
 * The three daily sweeps that keep an automation's standing promise without a
 * human driving it (Q2, Q7, Q9; ROADMAP D-99, D-100, D-118):
 *
 *  1. **Scheduled firing** — every active `trigger_type: 'scheduled'` automation
 *     not yet fired for today, `recurring.repository.ts`'s `selectDueTemplates`
 *     idiom applied to a firing rather than a materialisation.
 *  2. **Event firing** — every `trigger_type: 'event'` automation whose
 *     `trigger_config.eventName` matches a change-feed event since this
 *     subscriber's own `change_feed_cursors` position (D-57).
 *  3. **Lease-expiry recovery (Q7)** — every `work_items` row whose lease has
 *     expired with no submission, requeued rather than dropped.
 *
 * All three read across every org first (`systemDb()`, or its `event_log` /
 * `work_items` counterpart), because none of them has an org to start from —
 * discovering which orgs need work is the question each is answering, the
 * cross-org exception `selectDueTemplates`'s own header argues for. Only the
 * firing itself — `executeAutomation` — runs under `runAsAutomation`, which is
 * where an actor's provenance is actually recorded; reading a log and
 * advancing a bookmark are not themselves an automation's effect.
 *
 * One org's, or one automation's, failure is logged and does not stop the
 * sweep — `runRecurringSweep`'s reasoning restated: a bad automation must not
 * hold every other org's firings hostage for a day.
 */

export const AUTOMATIONS_SWEEP_QUEUE = 'automations.sweep';

export type AutomationsSweepPayload = DailyTaskPayload;

export interface AutomationsJobDeps {
  readonly logger: Logger;
}

/** `change_feed_cursors.subscriber` for the event sweep — this ticket's first consumer. */
const EVENT_SUBSCRIBER = 'automations';

/** Bounded per org per tick; a backlog beyond this is caught up on the next tick. */
const EVENTS_PER_SWEEP_LIMIT = 500;

/** Q7: a lease expired this many times is flagged rather than requeued silently forever. */
const LEASE_FLAG_THRESHOLD = 3;

/** The sweep handler, over any deps — the worker's registration, a test's own. */
export function createAutomationsSweepHandler(
  deps: AutomationsJobDeps,
): (payload: AutomationsSweepPayload) => Promise<void> {
  return async (payload) => {
    await runScheduledFiring(payload.runDate, deps);
    await runEventFiring(deps);
    await runLeaseExpiryRecovery(deps);
  };
}

/**
 * Registers the sweep on the daily tick and on the queue it rides —
 * `registerRecurringJob`'s shape exactly.
 */
export async function registerAutomationsJob(
  queue: QueueProvider,
  deps: AutomationsJobDeps,
): Promise<void> {
  registerDailyTask(AUTOMATIONS_SWEEP_QUEUE);
  await queue.subscribe(AUTOMATIONS_SWEEP_QUEUE, createAutomationsSweepHandler(deps));
}

// ---------------------------------------------------------------------------
// 1. Scheduled firing
// ---------------------------------------------------------------------------

async function runScheduledFiring(runDate: string, deps: AutomationsJobDeps): Promise<void> {
  const due = await selectDueScheduledAutomations(systemDb(), runDate);

  for (const ref of due) {
    const orgId = bufferToUuid(ref.org_id);
    const automationId = bufferToUuid(ref.id);

    try {
      await runAsAutomation(orgId, automationId, (ctx) =>
        fireScheduledAutomation(ref.id, runDate, ctx),
      );
    } catch (error) {
      deps.logger.error(
        { orgId, automationId, runDate, err: error },
        'Scheduled automation firing failed; the automation stays due and is retried on the ' +
          'next tick.',
      );
    }
  }
}

/**
 * Reloads the automation `FOR UPDATE` and re-checks both guards under the lock
 * — `materializeCycle`'s once-per-cycle shape, restated for a firing rather
 * than a materialisation: `is_active` may have flipped since the sweep's
 * snapshot, and `last_fired_run_date` may already have reached `runDate` if a
 * crashed worker or a re-enqueue is retrying a cycle that in fact already
 * fired.
 */
async function fireScheduledAutomation(
  id: Buffer,
  runDate: string,
  ctx: RequestContext,
): Promise<void> {
  await orgScope(ctx).transaction(async (trx) => {
    const current = await selectAutomationByIdForUpdate(trx, id);
    if (current === undefined || current.is_active !== 1) return;
    if (current.last_fired_run_date === runDate) return;

    await executeAutomation(toAutomation(current), ctx);
    await advanceAutomationFiredDate(trx, id, runDate);
  });
}

// ---------------------------------------------------------------------------
// 2. Event firing
// ---------------------------------------------------------------------------

async function runEventFiring(deps: AutomationsJobDeps): Promise<void> {
  const orgIds = await selectOrgIdsWithActiveEventAutomations(systemDb());

  for (const orgIdBytes of orgIds) {
    const orgId = bufferToUuid(orgIdBytes);
    try {
      await fireEventAutomationsForOrg(orgIdBytes, orgId, deps);
    } catch (error) {
      deps.logger.error(
        { orgId, err: error },
        'Event-triggered automation sweep failed for one org; continuing with the rest.',
      );
    }
  }
}

/**
 * Reads `event_log` past this org's own `change_feed_cursors` position (D-57).
 * A plain `tenantDb`, not `runAsAutomation`: reading the log and advancing the
 * cursor are not themselves an automation's effect; only `executeAutomation`
 * below needs the automation-scoped context a firing writes under.
 *
 * The cursor is the idempotency guard: once an event's position has been
 * advanced past, it is never read again, whether or not every matching
 * automation's firing succeeded. A firing that failed is logged and the event
 * is not retried for *that automation* — the same trade the change feed
 * itself documents (`events/bus.ts`: "at-least-once... a subscriber must be
 * idempotent rather than this relay being exactly-once").
 */
async function fireEventAutomationsForOrg(
  orgIdBytes: Buffer,
  orgId: string,
  deps: AutomationsJobDeps,
): Promise<void> {
  const db = tenantDb(orgIdBytes);
  const cursorPosition = await selectOrCreateCursorPosition(db, EVENT_SUBSCRIBER);
  const events = await selectEventLogPageAfter(db, cursorPosition, EVENTS_PER_SWEEP_LIMIT);
  if (events.length === 0) return;

  const automations = await selectActiveEventAutomations(db);

  for (const event of events) {
    for (const row of automations) {
      if (eventNameOf(row) !== event.name) continue;

      const automationId = bufferToUuid(row.id);
      const automation = toAutomation(row);
      const payload = toEventPayload(event.payload);

      try {
        await runAsAutomation(orgId, automationId, (ctx) =>
          executeAutomation(automation, ctx, { name: event.name, payload }),
        );
      } catch (error) {
        deps.logger.error(
          { orgId, automationId, event: event.name, err: error },
          'Event-triggered automation firing failed; the event is not retried for this ' +
            'automation.',
        );
      }
    }

    await advanceCursorPosition(db, EVENT_SUBSCRIBER, event.position);
  }
}

/** The `trigger_config.eventName` an event-triggered automation's row carries. */
function eventNameOf(row: AutomationRow): string | undefined {
  const config = row.trigger_config;
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return undefined;

  const eventName = (config as Record<string, unknown>)['eventName'];
  return typeof eventName === 'string' ? eventName : undefined;
}

// ---------------------------------------------------------------------------
// 3. Lease-expiry recovery (Q7)
// ---------------------------------------------------------------------------

async function runLeaseExpiryRecovery(deps: AutomationsJobDeps): Promise<void> {
  const now = new Date();
  const orgIds = await selectOrgIdsWithExpiredLeases(systemDb(), now);

  for (const orgIdBytes of orgIds) {
    const orgId = bufferToUuid(orgIdBytes);
    try {
      await requeueExpiredWorkItemsForOrg(orgIdBytes, now);
    } catch (error) {
      deps.logger.error(
        { orgId, err: error },
        'Lease-expiry recovery failed for one org; continuing with the rest.',
      );
    }
  }
}

/**
 * Requeues every work item whose lease has expired in this org — never
 * dropped (Q7): back to `queued`, the lease cleared, `attempts` incremented,
 * and `flagged` once `attempts` reaches `LEASE_FLAG_THRESHOLD`. A plain
 * `tenantDb`, not `runAsAutomation`: this is queue bookkeeping, not an
 * automation's own effect, and writes no column an actor's provenance is
 * recorded against.
 */
async function requeueExpiredWorkItemsForOrg(orgIdBytes: Buffer, now: Date): Promise<void> {
  const db = tenantDb(orgIdBytes);
  const expired = await selectExpiredLeasedWorkItems(db, now);

  for (const item of expired) {
    const nextAttempts = item.attempts + 1;
    await requeueExpiredWorkItem(db, item.id, nextAttempts, nextAttempts >= LEASE_FLAG_THRESHOLD);
  }
}
