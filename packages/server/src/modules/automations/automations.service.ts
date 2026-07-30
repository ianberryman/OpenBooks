import type {
  Automation,
  AutomationPage,
  AutomationRunResult,
  CreateAutomationRequest,
  ListAutomationsQuery,
  UpdateAutomationRequest,
} from '@openbooks/shared-types';
import {
  createAutomationRequestSchema,
  listAutomationsQuerySchema,
  updateAutomationRequestSchema,
} from '@openbooks/shared-types';

import { getContext } from '../../context';
import type { RequestContext } from '../../context';
import type { TenantDatabase } from '../../db';
import { resolvePageLimit, tryUuidToBuffer } from '../../db';
import { assertFound, parseInput, ValidationError } from '../../errors';
import { requirePermission } from '../permissions';
import { runAsAutomation } from '../scheduling';

import { executeAutomation } from './engine';
import type { AutomationPatch } from './repository';
import {
  AUTOMATION_RESOURCE,
  automationIdBytes,
  insertAutomation,
  orgScope,
  selectAutomationById,
  selectAutomationByIdForUpdate,
  selectAutomationsPage,
  setAutomationActiveRow,
  toAutomation,
  updateAutomationRow,
} from './repository';

/**
 * Automations: compose, read, update, activate, and run once on demand
 * (initiative Q, M6; OB-200…210; ROADMAP D-99, D-119).
 *
 * `requirePermission` runs first, before the payload is parsed, matching every
 * other service in this tree. A miss is always `assertFound`: `tenantDb` has
 * already confined every read to the caller's org, so a cross-org id returns no
 * row and reaches the same 404 a nonexistent one does (A7).
 *
 * ## The reserved compose-vs-activate split
 *
 * `workflows.write` composes an automation's name, trigger, and actions;
 * `workflows.activate` is the separate, narrower door that flips whether it
 * fires at all. That split is deliberate (D-119's own schema commentary): a
 * caller who may edit an automation's *content* is not automatically trusted to
 * turn one loose on the org, which is what makes activation the natural home for
 * a manual run too — `runAutomation` below fires the automation once, right now,
 * which is exactly the capability activation already gates.
 *
 * ## Why an automation needs a real user, and `journal.propose` does not
 *
 * `automations.created_by_user_id` is `NOT NULL` and references `users` —
 * `drafts.service.ts`'s `requireAuthor` restated for the same reason: a standing
 * instruction a human composed and owns needs a person to attribute it to, and
 * an automation or agent context has no `userId` to offer one.
 */

function requireAuthor(ctx: RequestContext): Buffer {
  const userId = ctx.userId === null ? undefined : tryUuidToBuffer(ctx.userId);
  if (userId === undefined) {
    throw new ValidationError('An automation is authored by a user.', [
      {
        path: 'actor',
        message:
          'This caller has no user identity, so it cannot compose an automation. Automations ' +
          'are composed by a person and run under their org’s own authority thereafter.',
      },
    ]);
  }
  return userId;
}

export async function createAutomation(
  input: CreateAutomationRequest,
  ctx: RequestContext = getContext('createAutomation()'),
): Promise<Automation> {
  await requirePermission(ctx, 'workflows.write');
  const request = parseInput(createAutomationRequestSchema, input);
  const author = requireAuthor(ctx);

  // The rest-destructure's type has no index signature of its own (the same
  // reason `toChangeFeedPayload` casts), so it is cast here rather than left to
  // fail structural assignment against `NewAutomationRow.triggerConfig`.
  const { type: triggerType, ...triggerConfig } = request.trigger;
  const db = orgScope(ctx);

  // Composed inactive (the schema's own `is_active DEFAULT 0`): enabling it to
  // fire is the separate `workflows.activate` act below.
  const id = await insertAutomation(db, {
    name: request.name,
    triggerType,
    triggerConfig,
    actions: request.actions,
    createdByUserId: author,
  });

  return hydrate(db, id);
}

export async function getAutomation(
  automationId: string,
  ctx: RequestContext = getContext('getAutomation()'),
): Promise<Automation> {
  await requirePermission(ctx, 'workflows.read');

  const db = orgScope(ctx);
  const id = assertFound(automationIdBytes(automationId), AUTOMATION_RESOURCE);
  return hydrate(db, id);
}

/**
 * One page of the org's automations, oldest first (D-21). `resolvePageLimit`
 * and not the parsed `limit`, `listRecurringInvoiceTemplates`'s reason: the
 * schema restates the same bounds for `openapi.json`'s benefit, and this
 * function is the authority an MCP tool or the workflow engine reaches with no
 * schema in front of it (spec §12).
 */
export async function listAutomations(
  query: ListAutomationsQuery,
  ctx: RequestContext = getContext('listAutomations()'),
): Promise<AutomationPage> {
  await requirePermission(ctx, 'workflows.read');
  const request = parseInput(listAutomationsQuerySchema, query);
  const limit = resolvePageLimit(request.limit);

  const page = await selectAutomationsPage(
    orgScope(ctx),
    {
      ...(request.isActive === undefined ? {} : { isActive: request.isActive }),
      ...(request.triggerType === undefined ? {} : { triggerType: request.triggerType }),
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    },
    limit,
  );

  return { items: page.rows.map(toAutomation), nextCursor: page.nextCursor };
}

/**
 * Updates an automation's composition — `name`, `trigger`, and/or `actions`.
 * Deliberately cannot touch `isActive`; see `setAutomationActive` for that door.
 */
export async function updateAutomation(
  automationId: string,
  input: UpdateAutomationRequest,
  ctx: RequestContext = getContext('updateAutomation()'),
): Promise<Automation> {
  await requirePermission(ctx, 'workflows.write');
  const request = parseInput(updateAutomationRequestSchema, input);

  return orgScope(ctx).transaction(async (trx) => {
    const id = assertFound(automationIdBytes(automationId), AUTOMATION_RESOURCE);
    assertFound(await selectAutomationByIdForUpdate(trx, id), AUTOMATION_RESOURCE);

    const triggerPatch = triggerPatchOf(request.trigger);

    const patch: AutomationPatch = {
      ...(request.name === undefined ? {} : { name: request.name }),
      ...triggerPatch,
      ...(request.actions === undefined ? {} : { actions: request.actions }),
    };
    await updateAutomationRow(trx, id, patch);

    return hydrate(trx, id);
  });
}

function triggerPatchOf(
  trigger: UpdateAutomationRequest['trigger'],
): Pick<AutomationPatch, 'triggerType' | 'triggerConfig'> {
  if (trigger === undefined) return {};
  const { type, ...triggerConfig } = trigger;
  return { triggerType: type, triggerConfig };
}

/**
 * The reserved compose-vs-activate door (D-119): flips `isActive` and nothing
 * else. Idempotent, `deactivateRecurringInvoiceTemplate`'s shape: setting the
 * value it already holds is returned unchanged rather than refused, so a retry
 * never fails on the thing it was trying to achieve.
 */
export async function setAutomationActive(
  automationId: string,
  isActive: boolean,
  ctx: RequestContext = getContext('setAutomationActive()'),
): Promise<Automation> {
  await requirePermission(ctx, 'workflows.activate');

  return orgScope(ctx).transaction(async (trx) => {
    const id = assertFound(automationIdBytes(automationId), AUTOMATION_RESOURCE);
    assertFound(await selectAutomationByIdForUpdate(trx, id), AUTOMATION_RESOURCE);

    await setAutomationActiveRow(trx, id, isActive);
    return hydrate(trx, id);
  });
}

/**
 * Fires an automation once, right now, regardless of `isActive` — a deliberate
 * test-fire capability the reserved `workflows.activate` permission already
 * gates (see the file header). `runAsAutomation` re-scopes the run under the
 * org's own Owner authority (`scheduling/automation.ts`), the same actor
 * provenance a scheduled or event-triggered firing carries, so a work item or
 * annotation this produces is not distinguishable by *how* the firing was
 * caused.
 */
export async function runAutomation(
  automationId: string,
  ctx: RequestContext = getContext('runAutomation()'),
): Promise<AutomationRunResult> {
  await requirePermission(ctx, 'workflows.activate');

  const id = assertFound(automationIdBytes(automationId), AUTOMATION_RESOURCE);
  const row = assertFound(await selectAutomationById(orgScope(ctx), id), AUTOMATION_RESOURCE);
  const automation = toAutomation(row);

  return runAsAutomation(ctx.orgId, automationId, (runCtx) =>
    executeAutomation(automation, runCtx),
  );
}

async function hydrate(db: TenantDatabase, id: Buffer): Promise<Automation> {
  const row = assertFound(await selectAutomationById(db, id), AUTOMATION_RESOURCE);
  return toAutomation(row);
}
