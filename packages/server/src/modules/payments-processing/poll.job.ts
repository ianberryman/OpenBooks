import type { QueueProvider } from '@openbooks/plugin-api';

import type { RequestContext } from '../../context';
import { bufferToUuid, systemDb, uuidToBuffer } from '../../db';
import type { Logger } from '../../logging';
import { bookBalance } from '../banking';
import { registerDailyTask, runAsAutomation } from '../scheduling';
import type { DailyTaskPayload } from '../scheduling';

import {
  advanceEventCursor,
  advanceReconciledThrough,
  orgScope,
  selectAllActiveConnectionsAcrossOrgs,
} from './connections.repository';
import { loadConnectionProvider } from './connections.service';
import { finalizePayoutReports } from './payout-sync.service';
import { recordNormalizedEvent } from './webhook.service';

/**
 * The D-85 polling backstop (OB-148): a daily sweep, on the OB-127 scheduler
 * exactly as recurring/dunning ride it (`registerDailyTask` + `queue.subscribe`,
 * `invoicing/recurring/engine.ts`'s shape), that does two things per active
 * connection —
 *
 *  1. **Redrives missed events.** `provider.listEventsSince(cursor)` asks the
 *     processor for everything since the connection's own `lastPolledAt`, and
 *     every event comes back through `recordNormalizedEvent` — the *same*
 *     function the webhook route calls, so a redriven event and a freshly
 *     delivered one pass through the identical two-level idempotency guard
 *     (`webhook.service.ts`'s header). A webhook that was never delivered (a
 *     dropped notification, an endpoint that was briefly down) is caught here
 *     without ever being a special case in the dispatch logic.
 *  2. **Reconciles the clearing balance.** `provider.fetchBalanceMinor()` — the
 *     processor's own reported balance — is compared against `bookBalance`
 *     (`banking/reconciliation`'s D-46 ledger-balance computation) on the
 *     connection's clearing account. A mismatch is **logged, not corrected**
 *     (D-85: a scheduled poll "reconciles the clearing account against the
 *     processor's own reported balance" — reconciliation, not correction,
 *     mirroring D-43's "matching proposes; a human posts" for the identical
 *     reason: an automated corrector's own mistakes would land in an
 *     append-only ledger) — an operator investigates a persistent discrepancy
 *     the way M4's own reconciliation report surfaces one.
 *
 * `lastPolledAt`/`reconciledThrough` both advance together afterward
 * (`advanceReconciledThrough`, the same cursor `recordProcessorPayout` moves) —
 * this poll and a payout are two different ways the connection's own "we have
 * accounted for everything through here" line can move forward.
 *
 * ## The event cursor is an opaque id, not a timestamp (OB-237, D-237-5)
 *
 * Fixed. `PaymentProcessorProvider.listEventsSince(cursor)` is an opaque cursor,
 * and the real Stripe adapter treats it as the last-seen **event id**
 * (`starting_after`). This sweep now passes `connection.eventCursor` — the
 * dedicated `processor_connections.event_cursor` column OB-237 added — and
 * advances it from `listEventsSince`'s returned cursor after a successful page
 * (`advanceEventCursor`), so a real Stripe/Square feed resumes from a true id.
 * `last_polled_at` reverts to pure telemetry (when the poll last ran); the
 * balance-reconcile timestamp still rides `advanceReconciledThrough`. The prior
 * defect — handing `lastPolledAt`'s ISO string to an adapter expecting an id —
 * is gone, and `fake` (D-102, the gate's implementation) is unaffected: it
 * ignores its cursor argument either way.
 */

export const PROCESSOR_POLL_QUEUE = 'payments-processing.processor-poll';

export interface ProcessorPollJobDeps {
  readonly logger: Logger;
}

/** Registers the sweep on the daily tick and the queue it rides — the worker's one line of wiring. */
export async function registerProcessorPollJob(
  queue: QueueProvider,
  deps: ProcessorPollJobDeps,
): Promise<void> {
  registerDailyTask(PROCESSOR_POLL_QUEUE);
  await queue.subscribe(PROCESSOR_POLL_QUEUE, createProcessorPollHandler(deps));
}

/** The sweep handler, over any deps — the worker's registration, a test's own. */
export function createProcessorPollHandler(
  deps: ProcessorPollJobDeps,
): (payload: DailyTaskPayload) => Promise<void> {
  return (payload) => runProcessorPoll(payload, deps);
}

/**
 * Every active connection, across every org, each polled under its own org's
 * automation scope. One connection's failure is logged and does not stop the
 * sweep — the same "a bad row must not hold every other org hostage for a day"
 * discipline `runRecurringSweep` states for its own loop.
 */
export async function runProcessorPoll(
  payload: DailyTaskPayload,
  deps: ProcessorPollJobDeps,
): Promise<void> {
  const connections = await selectAllActiveConnectionsAcrossOrgs(systemDb());

  for (const row of connections) {
    const orgId = bufferToUuid(row.org_id);
    const connectionId = bufferToUuid(row.id);

    try {
      await runAsAutomation(orgId, connectionId, (ctx) =>
        pollOneConnection(connectionId, row.id, payload.runDate, ctx, deps),
      );
    } catch (error) {
      deps.logger.error(
        { orgId, connectionId, err: error },
        'processor poll failed for one connection; continuing with the rest (D-85 backstop, ' +
          'not a payment path — a missed poll self-heals on the next tick).',
      );
    }
  }
}

/** Redrives missed events and reconciles one connection's clearing balance. */
async function pollOneConnection(
  connectionId: string,
  connectionBytes: Buffer,
  runDate: string,
  ctx: RequestContext,
  deps: ProcessorPollJobDeps,
): Promise<void> {
  const { connection, clearingAccountId, eventCursor, provider } = await loadConnectionProvider(
    connectionId,
    ctx,
  );

  // OB-237/D-237-5: resume from the opaque event cursor (Stripe's last-seen event
  // id), never `lastPolledAt`'s timestamp.
  const { events, cursor } = await provider.listEventsSince(eventCursor);
  for (const event of events) {
    // Same dedup path the webhook route uses (`webhook.service.ts`'s header) —
    // a redrive of an event the webhook already captured is a no-op here.
    await recordNormalizedEvent(connectionId, connection.processor, event, ctx);
  }
  await advanceEventCursor(orgScope(ctx), connectionBytes, cursor);

  const reportedBalance = await provider.fetchBalanceMinor();
  const ledgerBalance = await bookBalance(orgScope(ctx), uuidToBuffer(clearingAccountId), runDate);
  if (ledgerBalance.toString() !== reportedBalance) {
    deps.logger.warn(
      {
        connectionId,
        processor: connection.processor,
        ledgerBalance: ledgerBalance.toString(),
        reportedBalance,
      },
      'processor poll: clearing account ledger balance disagrees with the processor’s own ' +
        'reported balance (D-85). Advisory only — nothing here auto-corrects; investigate as ' +
        'M4’s own reconciliation report would for a bank account.',
    );
  }

  await advanceReconciledThrough(orgScope(ctx), connectionBytes, new Date());

  // OB-237b/D-237-10: finalize any manual payouts whose async Stripe reconciliation
  // report has completed since a prior tick (awaiting_report → posted|pending_review
  // |skipped). Same daily cadence, same per-connection automation scope — a
  // still-pending report simply waits for the next tick.
  await finalizePayoutReports(connectionId, ctx);
}
