import type { QueueProvider } from '@openbooks/plugin-api';

import { bufferToUuid, systemDb } from '../../../db';
import type { Logger } from '../../../logging';
// OB-127 dependency. `packages/server/src/modules/scheduling/` did not exist in
// `develop` at the time this file was written — the roadmap's Phase-4 DAG is
// explicit that it is sequenced *before* this ticket ("the daily in-process
// tick (OB-127) → … + dunning (OB-129)"), and this worktree's base (reset to
// `develop`, per this ticket's own instructions) still did not contain it.
// `registerDailyTask(queueName)` and `runAsAutomation(orgId, actorId, fn)` are
// the contract the ticket's spec named; this file assumes that exact shape so
// the orchestrator can wire it straight through once OB-127 lands, or adjust
// this one file if the real signatures differ. Nothing else in this ticket
// (`dunning.service.ts`, `dunning.repository.ts`, `engine.ts`, and both test
// files) depends on this module — see `engine.ts`'s header for why the
// scheduling dependency was isolated to this one file rather than left in it.
import { registerDailyTask, runAsAutomation } from '../../scheduling';

import { selectOrgIdsWithActivePolicies } from './dunning.repository';
import { runDunning } from './engine';
import type { DailyTaskPayload } from './job';
import { DUNNING_SWEEP_QUEUE } from './job';

/**
 * The worker's wiring for the dunning sweep (OB-129, Phase 4).
 *
 * Modelled on `registerStatementImportJob` (`banking/statements/service.ts`):
 * `createDunningSweepHandler` is the pure mapping from a payload to an effect,
 * kept separate from `registerDunningJob` so a test can drive it directly
 * against an `InProcessQueue` it also holds, exactly as OB-078's suite does.
 *
 * `systemDb()` and `runAsAutomation` are how the handler crosses the one
 * boundary `dunning.repository.ts`'s header calls out: it has no org and no
 * `RequestContext` until it has found one, so it reads the worklist through
 * the cross-org accessor and then opens one automation-scoped context per org,
 * via `engine.ts`'s `runDunning`.
 */

export interface DunningJobDeps {
  readonly logger: Logger;
}

export function createDunningSweepHandler(
  deps: DunningJobDeps,
): (payload: DailyTaskPayload) => Promise<void> {
  return async (payload) => {
    const orgIds = await selectOrgIdsWithActivePolicies(systemDb());

    for (const orgId of orgIds) {
      await runAsAutomation(bufferToUuid(orgId), 'dunning-sweep', (ctx) =>
        runDunning(payload.runDate, ctx),
      ).catch((error: unknown) => {
        deps.logger.error(
          { err: error, orgId: bufferToUuid(orgId), runDate: payload.runDate },
          'The dunning sweep failed for one org; continuing with the rest.',
        );
      });
    }
  };
}

/**
 * Registers the sweep on the scheduler and the queue — the worker's one line
 * of wiring, `registerStatementImportJob`'s shape exactly.
 */
export async function registerDunningJob(
  queue: QueueProvider,
  deps: DunningJobDeps,
): Promise<void> {
  registerDailyTask(DUNNING_SWEEP_QUEUE);
  await queue.subscribe(DUNNING_SWEEP_QUEUE, createDunningSweepHandler(deps));
}
