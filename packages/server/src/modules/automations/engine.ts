import type { Automation, AutomationRunResult } from '@openbooks/shared-types';

import type { RequestContext } from '../../context';
import { bufferToUuid, newUuidBuffer, uuidToBuffer } from '../../db';

import { insertAutomationAnnotation, insertWorkItem, orgScope } from './repository';

/**
 * The firing engine (Q3, Q9; ROADMAP D-99, D-100, D-119): runs one automation's
 * ordered actions once, inside whatever scope the caller has already opened —
 * `runAsAutomation` for a scheduled or event firing (`job.ts`), or the same
 * function for a manual run (`automations.service.ts`'s `runAutomation`).
 * Nothing here decides *whether* to fire; that is `job.ts`'s once-per-cycle
 * guard and `automations.service.ts`'s permission check, both already settled by
 * the time this runs.
 *
 * Two action types ship (D-119), run in list order (Q9) so the annotation and
 * the work item from one firing share a `run_token` — how the E2E proves both
 * actions of an `[annotate, agent_task]` automation ran:
 *
 *  - `annotate` inserts an `automation_annotations` row.
 *  - `agent_task` inserts a `work_items` row — the AI seam. Nothing here calls a
 *    model or posts a journal (D-100): the row sits `queued` until an agent
 *    polls it over MCP (`queue.service.ts`'s `pollWorkQueue`).
 *
 * `firingEvent` is present only for an event-triggered firing (`job.ts`'s event
 * sweep) and absent for a manual or scheduled one — it is folded into the work
 * item's `context` alongside the trigger and the automation's own name, so the
 * agent reading the item knows what caused it without a second lookup.
 */
export async function executeAutomation(
  automation: Automation,
  ctx: RequestContext,
  firingEvent?: { readonly name: string; readonly payload: Record<string, unknown> },
): Promise<AutomationRunResult> {
  const db = orgScope(ctx);
  const automationId = uuidToBuffer(automation.id);
  const runTokenBytes = newUuidBuffer();
  const runToken = bufferToUuid(runTokenBytes);

  // Built once and shared by every `agent_task` action this firing enqueues —
  // `context` is producer-defined JSON (`workItemContextSchema`), and what this
  // producer supplies is the firing that caused the item to exist.
  const context: Record<string, unknown> = {
    trigger: automation.trigger,
    automationName: automation.name,
    ...(firingEvent === undefined ? {} : { event: firingEvent }),
  };

  let annotationsWritten = 0;
  let workItemsEnqueued = 0;

  for (const action of automation.actions) {
    if (action.type === 'annotate') {
      await insertAutomationAnnotation(db, {
        automationId,
        runToken: runTokenBytes,
        note: action.note,
      });
      annotationsWritten += 1;
    } else {
      await insertWorkItem(db, {
        automationId,
        runToken: runTokenBytes,
        sourceKind: action.sourceKind,
        sourceRef: null,
        prompt: action.prompt,
        context,
      });
      workItemsEnqueued += 1;
    }
  }

  return { runToken, annotationsWritten, workItemsEnqueued };
}
