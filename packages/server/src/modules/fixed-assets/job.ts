import type { DailyTaskPayload } from '../scheduling';

/**
 * The depreciation-sweep job: its queue name and its payload (OB-165, riding
 * OB-127's daily tick).
 *
 * A leaf on purpose, `invoicing/recurring/job.ts`'s reason: it imports nothing
 * from `depreciation-sweep.ts`, so both sides of the seam — the tick that
 * enqueues and the worker's handler that consumes — can name the queue and the
 * payload with no cycle between them.
 */

/**
 * One queue, named for what rides it. Distinct from `RECURRING_SWEEP_QUEUE`
 * (OB-128) and from OB-162's recurring-*journal* sweep: depreciation is its own
 * due-work source on the one scheduler (D-113), not a generalisation of either.
 */
export const FIXED_ASSET_DEPRECIATION_SWEEP_QUEUE = 'ledger.fixed-asset-depreciation-sweep';

/**
 * The daily tick's own payload shape — a calendar date, nothing else. Named
 * separately from `DailyTaskPayload` so this module states its own contract,
 * but the two are the same shape: `depreciation-sweep.ts`'s handler is exactly
 * what `registerDailyTask(FIXED_ASSET_DEPRECIATION_SWEEP_QUEUE)` delivers.
 */
export type FixedAssetDepreciationSweepPayload = DailyTaskPayload;
