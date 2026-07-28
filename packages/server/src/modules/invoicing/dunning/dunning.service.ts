import type {
  CreateDunningPolicyRequest,
  DunningPolicy,
  DunningPolicyPage,
  DunningStage,
  ListDunningPoliciesQuery,
  UpdateDunningPolicyRequest,
} from '@openbooks/shared-types';
import {
  createDunningPolicyRequestSchema,
  PAGE_SIZE_DEFAULT,
  updateDunningPolicyRequestSchema,
} from '@openbooks/shared-types';

import { getContext } from '../../../context';
import type { RequestContext } from '../../../context';
import { bufferToUuid, newUuid, newUuidBuffer, tryUuidToBuffer, uuidToBuffer } from '../../../db';
import { assertFound, parseInput, ValidationError } from '../../../errors';
import { requirePermission } from '../../permissions';

import type { DunningPolicyRow, DunningStageRow, NewStageRow } from './dunning.repository';
import {
  DUNNING_POLICY_RESOURCE,
  insertPolicy,
  orgScope,
  replacePolicyStages,
  selectPoliciesPage,
  selectPolicyById,
  selectStagesByPolicy,
  updatePolicyRow,
} from './dunning.repository';

/**
 * The dunning policy CRUD (OB-129, Phase 4).
 *
 * A policy governs *sending* — it is the standing instruction the sweep in
 * `engine.ts` acts on unattended — so every operation here takes `invoices.send`
 * for writes, the same permission `sendInvoice` takes for the same reason
 * (`invoices.ts`'s header: "sending reaches a customer's inbox and editing a
 * draft does not"). Reads take `invoices.read`, matching `listInvoices`.
 *
 * One transaction per write, opened here and joined ambiently by every
 * repository call inside it (`chart-templates.service.ts`'s shape): a policy
 * whose header committed but whose stages did not would be addressable and
 * empty, which is worse than the create having failed outright.
 */

function toWireStage(row: DunningStageRow): DunningStage {
  return {
    stageNumber: row.stage_number,
    offsetDays: row.offset_days,
    subject: row.subject,
    body: row.body,
    lateFeeMinor: row.late_fee_minor === null ? null : row.late_fee_minor.toString(),
  };
}

function toLateFeeMinor(lateFeeMinor: string | null | undefined): bigint | null {
  return lateFeeMinor === null || lateFeeMinor === undefined ? null : BigInt(lateFeeMinor);
}

function toNewStageRow(stage: DunningStage): NewStageRow {
  return {
    id: newUuidBuffer(),
    stageNumber: stage.stageNumber,
    offsetDays: stage.offsetDays,
    subject: stage.subject,
    body: stage.body,
    lateFeeMinor: toLateFeeMinor(stage.lateFeeMinor),
  };
}

/**
 * `uq_dunning_stages_policy_stage` is the guarantee; this is the message. A
 * collision reaching the constraint would surface as an opaque duplicate-key
 * error from inside the transaction rather than naming the field, which is the
 * same gap `codesAlreadyInUseError` closes for a chart template.
 */
function assertUniqueStageNumbers(stages: readonly DunningStage[]): void {
  const seen = new Set<number>();
  const duplicates = new Set<number>();
  for (const stage of stages) {
    if (seen.has(stage.stageNumber)) duplicates.add(stage.stageNumber);
    seen.add(stage.stageNumber);
  }
  if (duplicates.size > 0) {
    throw new ValidationError(
      `Stage numbers must be unique within a policy; repeated: ${[...duplicates]
        .sort((a, b) => a - b)
        .join(', ')}.`,
      [{ path: 'stages', message: 'Stage numbers must be unique within a policy.' }],
    );
  }
}

async function toWirePolicy(
  db: ReturnType<typeof orgScope>,
  row: DunningPolicyRow,
): Promise<DunningPolicy> {
  const stages = await selectStagesByPolicy(db, row.id);
  return {
    id: bufferToUuid(row.id),
    name: row.name,
    isActive: row.is_active === 1,
    stages: stages.map(toWireStage),
  };
}

export async function createDunningPolicy(
  input: CreateDunningPolicyRequest,
  ctx: RequestContext = getContext('createDunningPolicy()'),
): Promise<DunningPolicy> {
  await requirePermission(ctx, 'invoices.send');
  const request = parseInput(createDunningPolicyRequestSchema, input);
  assertUniqueStageNumbers(request.stages);

  const db = orgScope(ctx);
  const id = newUuid();
  const idBytes = uuidToBuffer(id);

  return db.transaction(async (trx) => {
    await insertPolicy(trx, { id: idBytes, name: request.name });
    await replacePolicyStages(trx, idBytes, request.stages.map(toNewStageRow));

    return {
      id,
      name: request.name,
      isActive: true,
      stages: request.stages,
    };
  });
}

export async function getDunningPolicy(
  policyId: string,
  ctx: RequestContext = getContext('getDunningPolicy()'),
): Promise<DunningPolicy> {
  await requirePermission(ctx, 'invoices.read');

  const idBytes = policyIdBytes(policyId);
  const db = orgScope(ctx);
  const row = assertFound(await selectPolicyById(db, idBytes), DUNNING_POLICY_RESOURCE);

  return toWirePolicy(db, row);
}

export async function listDunningPolicies(
  query: ListDunningPoliciesQuery,
  ctx: RequestContext = getContext('listDunningPolicies()'),
): Promise<DunningPolicyPage> {
  await requirePermission(ctx, 'invoices.read');

  const db = orgScope(ctx);
  const limit = query.limit ?? PAGE_SIZE_DEFAULT;
  const page = await selectPoliciesPage(db, limit, query.cursor);

  return {
    items: await Promise.all(page.items.map((row) => toWirePolicy(db, row))),
    nextCursor: page.nextCursor,
  };
}

export async function updateDunningPolicy(
  policyId: string,
  input: UpdateDunningPolicyRequest,
  ctx: RequestContext = getContext('updateDunningPolicy()'),
): Promise<DunningPolicy> {
  await requirePermission(ctx, 'invoices.send');
  const request = parseInput(updateDunningPolicyRequestSchema, input);
  if (request.stages !== undefined) assertUniqueStageNumbers(request.stages);

  const idBytes = policyIdBytes(policyId);
  const db = orgScope(ctx);

  return db.transaction(async (trx) => {
    assertFound(await selectPolicyById(trx, idBytes), DUNNING_POLICY_RESOURCE);

    if (request.name !== undefined || request.isActive !== undefined) {
      await updatePolicyRow(trx, idBytes, {
        ...(request.name === undefined ? {} : { name: request.name }),
        ...(request.isActive === undefined ? {} : { isActive: request.isActive }),
      });
    }
    if (request.stages !== undefined) {
      await replacePolicyStages(trx, idBytes, request.stages.map(toNewStageRow));
    }

    const updated = assertFound(await selectPolicyById(trx, idBytes), DUNNING_POLICY_RESOURCE);
    return toWirePolicy(trx, updated);
  });
}

/**
 * Idempotent: an already-inactive policy is returned unchanged rather than
 * refused, matching `deactivateAccount`'s convention (`accounts.ts`'s route
 * comment) — retiring a policy twice is not a meaningful error.
 */
export async function deactivateDunningPolicy(
  policyId: string,
  ctx: RequestContext = getContext('deactivateDunningPolicy()'),
): Promise<DunningPolicy> {
  await requirePermission(ctx, 'invoices.send');

  const idBytes = policyIdBytes(policyId);
  const db = orgScope(ctx);

  return db.transaction(async (trx) => {
    const row = assertFound(await selectPolicyById(trx, idBytes), DUNNING_POLICY_RESOURCE);
    if (row.is_active === 1) {
      await updatePolicyRow(trx, idBytes, { isActive: false });
    }

    const updated = assertFound(await selectPolicyById(trx, idBytes), DUNNING_POLICY_RESOURCE);
    return toWirePolicy(trx, updated);
  });
}

/**
 * A malformed id routes through `assertFound` to the same 404 a nonexistent one
 * produces (A7), exactly as `documentIdBytes`/`accountIdBytes` do.
 */
function policyIdBytes(policyId: string): Buffer {
  return assertFound(tryUuidToBuffer(policyId), DUNNING_POLICY_RESOURCE);
}
