/**
 * Dunning: policy CRUD and the overdue-reminder engine (OB-129, Phase 4).
 *
 * ## Surface
 *
 * | Operation                                | Permission       |
 * | ----------------------------------------- | ---------------- |
 * | `createDunningPolicy(input, ctx)`         | `invoices.send`  |
 * | `getDunningPolicy(id, ctx)`               | `invoices.read`  |
 * | `listDunningPolicies(query, ctx)`         | `invoices.read`  |
 * | `updateDunningPolicy(id, input, ctx)`     | `invoices.send`  |
 * | `deactivateDunningPolicy(id, ctx)`        | `invoices.send`  |
 *
 * A policy governs sending, so every write takes `invoices.send` — the same
 * permission `sendInvoice` takes and for the same reason (`dunning.service.ts`'s
 * header).
 *
 * `registerDunningJob(queue, deps)` is the worker's wiring for the sweep
 * (`worker.ts`): it registers the daily tick and the queue subscription that
 * runs `runDunning` once per org per day. See `worker.ts`'s header for the
 * `modules/scheduling` (OB-127) dependency this needs at the worker
 * entrypoint — a dependency `runDunning` and `selectDueStage` do not carry,
 * which is why `worker.ts` is a separate file from `engine.ts` (see that
 * file's header). A caller that only needs the pure/DB pieces — the two test
 * suites in `test/invoicing/` — imports `./engine` directly rather than this
 * barrel, precisely to avoid pulling in the OB-127 dependency this barrel
 * carries through `worker.ts`.
 */

export {
  createDunningPolicy,
  deactivateDunningPolicy,
  getDunningPolicy,
  listDunningPolicies,
  updateDunningPolicy,
} from './dunning.service';

export { runDunning, selectDueStage } from './engine';
export type { DueStageCandidate } from './engine';

export { DUNNING_SWEEP_QUEUE } from './job';
export type { DailyTaskPayload } from './job';

export { createDunningSweepHandler, registerDunningJob } from './worker';
export type { DunningJobDeps } from './worker';
