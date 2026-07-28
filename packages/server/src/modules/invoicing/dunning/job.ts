import type { DailyTaskPayload } from '../../scheduling';

/**
 * The dunning sweep job: its queue name and its payload (OB-129; ROADMAP D-77).
 *
 * A leaf on purpose, mirroring `banking/statements/job.ts`: it imports nothing
 * from `engine.ts` or `dunning.service.ts`, so both sides of the seam — the
 * scheduler that enqueues a day's tick and the handler that consumes it — can
 * name the queue and the payload without a cycle.
 *
 * ## `../../scheduling` (OB-127)
 *
 * `DailyTaskPayload` is a type-only re-export of the scheduler's own payload
 * shape, so this import is erased by the bundler and never resolved at
 * runtime — unlike the *value* import `worker.ts` needs for
 * `registerDailyTask`/`runAsAutomation`, which is why that wiring lives in its
 * own file rather than here. OB-127 is sequenced *before* this ticket in the
 * roadmap's Phase-4 DAG ("the daily in-process tick (OB-127) → … + dunning
 * (OB-129)"), and at the time this file was written
 * `packages/server/src/modules/scheduling/` did not exist yet in `develop`.
 * Nothing in `dunning.service.ts`, `engine.ts`, or the `dunning-select`/
 * `dunning` test suites depends on this module; only `worker.ts` does.
 */

/**
 * One queue, named for what rides it — `STATEMENT_IMPORT_QUEUE`'s convention.
 */
export const DUNNING_SWEEP_QUEUE = 'invoicing.dunning-sweep';

export type { DailyTaskPayload };
