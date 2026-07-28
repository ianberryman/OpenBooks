import type { DailyTaskPayload } from '../../scheduling';

/**
 * The recurring-sweep job: its queue name and its payload (OB-128, riding OB-127's
 * daily tick).
 *
 * A leaf on purpose, `statements/job.ts`'s reason: it imports nothing from
 * `recurring.service.ts`, so both sides of the seam — the tick that enqueues and
 * the worker's handler that consumes — can name the queue and the payload with no
 * cycle between them.
 */

/**
 * One queue, named for what rides it (`STATEMENT_IMPORT_QUEUE`'s convention). The
 * worker's one registration for this ticket.
 */
export const RECURRING_SWEEP_QUEUE = 'invoicing.recurring-sweep';

/**
 * The daily tick's own payload shape (D-75) — a calendar date, nothing else. Named
 * separately from `DailyTaskPayload` so this module states its own contract, but
 * the two are the same shape: `engine.ts`'s handler is exactly what
 * `registerDailyTask(RECURRING_SWEEP_QUEUE)` delivers.
 */
export type RecurringSweepPayload = DailyTaskPayload;
