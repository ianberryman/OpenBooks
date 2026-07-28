import type { Kysely } from 'kysely';

import type { RequestContext } from '../../../context';
import type { DB, KeysetOrdering, KeysetPage, TenantDatabase } from '../../../db';
import {
  applyKeyset,
  instantKey,
  orgScope as toOrgId,
  tenantDb,
  toKeysetPage,
  uuidKey,
} from '../../../db';

/**
 * Data access for `dunning_policies`, `dunning_stages` and `dunning_sends`
 * (OB-129, Phase 4; schema `0008_recurring_dunning`).
 *
 * The policy and its stages go through `tenantDb`, exactly as `accounts.repository.ts`'s
 * `orgScope` does — a cross-org policy id matches nothing, and the service's
 * `assertFound` turns that into the one miss A7 allows. `dunning_sends` is
 * append-only (`0999_app_grants`): there is no update path here, only `insertSend`
 * and the `hasSend` read that guards it, mirroring `delivery.repository.ts`'s
 * `insertDelivery`.
 *
 * `selectOrgIdsWithActivePolicies` is the one function here that is not org-scoped
 * — it reads across every org through `systemDb()`, because the sweep handler
 * (`worker.ts`) has to find its own worklist before it has an org to scope to.
 * See that function's own comment.
 */

/** The A7 resource token every miss in this module reports. */
export const DUNNING_POLICY_RESOURCE = 'dunning_policy';

export interface DunningPolicyRow {
  readonly id: Buffer;
  readonly name: string;
  readonly is_active: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface DunningStageRow {
  readonly id: Buffer;
  readonly policy_id: Buffer;
  readonly stage_number: number;
  readonly offset_days: number;
  readonly subject: string;
  readonly body: string;
  readonly late_fee_minor: bigint | null;
}

export interface NewStageRow {
  readonly id: Buffer;
  readonly stageNumber: number;
  readonly offsetDays: number;
  readonly subject: string;
  readonly body: string;
  readonly lateFeeMinor: bigint | null;
}

export interface NewSendRow {
  readonly id: Buffer;
  readonly invoiceId: Buffer;
  readonly stageId: Buffer;
  readonly recipientEmail: string;
  readonly providerMessageId: string | null;
  readonly status: 'sent' | 'failed';
}

/** The org-scoped handle for the current operation (spec §4: no org parameters). */
export function orgScope(ctx: RequestContext): TenantDatabase {
  return tenantDb(toOrgId(ctx.orgId));
}

// ---------------------------------------------------------------------------
// dunning_policies
// ---------------------------------------------------------------------------

export async function insertPolicy(
  db: TenantDatabase,
  row: { readonly id: Buffer; readonly name: string },
): Promise<void> {
  await db
    .insertInto('dunning_policies')
    // `org_id` is injected by `tenantDb`, the same way `insertDocument` omits it.
    .values({ id: row.id, name: row.name })
    .execute();
}

export async function selectPolicyById(
  db: TenantDatabase,
  id: Buffer,
): Promise<DunningPolicyRow | undefined> {
  return db
    .selectFrom('dunning_policies')
    .select(['id', 'name', 'is_active', 'created_at', 'updated_at'])
    .where('id', '=', id)
    .executeTakeFirst();
}

export interface DunningPolicyPatch {
  readonly name?: string;
  readonly isActive?: boolean;
}

/**
 * A no-op patch is the caller's business, not this function's: `updatePolicyRow`
 * is only ever reached from `updateDunningPolicy` alongside a check that at
 * least one scalar field is present, exactly as `updateAccountRow`'s callers are
 * relied on to do (Kysely's `SET` cannot be empty).
 */
export async function updatePolicyRow(
  db: TenantDatabase,
  id: Buffer,
  patch: DunningPolicyPatch,
): Promise<void> {
  await db
    .updateTable('dunning_policies')
    .set({
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.isActive === undefined ? {} : { is_active: patch.isActive ? 1 : 0 }),
    })
    .where('id', '=', id)
    .execute();

  // The affected-row count is deliberately not consulted — `updateAccountRow`'s
  // reasoning applies unchanged: a no-op rename reports zero rows exactly like a
  // miss would, and existence is established by the caller's own read.
}

/**
 * `(created_at, id)`, `contactPageSchema`'s ordering and its reason: `name` and
 * `is_active` are both editable, and a keyset over either would drop an edited
 * policy from a page it should still be on.
 */
const POLICY_KEYSET: KeysetOrdering<DunningPolicyRow> = [
  instantKey('dunning_policies.created_at', (row) => row.created_at),
  uuidKey('dunning_policies.id', (row) => row.id),
];

export async function selectPoliciesPage(
  db: TenantDatabase,
  limit: number,
  cursor: string | undefined,
): Promise<KeysetPage<DunningPolicyRow>> {
  const query = db
    .selectFrom('dunning_policies')
    .select(['id', 'name', 'is_active', 'created_at', 'updated_at']);

  const rows = await applyKeyset(query, POLICY_KEYSET, limit, cursor).execute();

  return toKeysetPage(rows, POLICY_KEYSET, limit);
}

/** One active policy and its ladder, as the sweep (`engine.ts`) needs them together. */
export interface ActivePolicyWithStages {
  readonly id: Buffer;
  readonly name: string;
  readonly stages: readonly DunningStageRow[];
}

/**
 * Every active policy in the caller's org, each with its stages attached — the
 * sweep's worklist for one org, in the shape `runDunning` walks. Two statements
 * rather than a join: a policy with zero stages is a validation failure the
 * write side already refuses (`min(1)` on `stages`), so a join here would only
 * spend a row-multiplying `LEFT JOIN` to defend against a state that cannot
 * exist — `replaceDocumentLines`'s row-multiplication reasoning, arriving from
 * the write side instead of a report.
 */
export async function selectActivePoliciesWithStages(
  db: TenantDatabase,
): Promise<readonly ActivePolicyWithStages[]> {
  const policies = await db
    .selectFrom('dunning_policies')
    .select(['id', 'name'])
    .where('is_active', '=', 1)
    .execute();

  return Promise.all(
    policies.map(async (policy) => ({
      id: policy.id,
      name: policy.name,
      stages: await selectStagesByPolicy(db, policy.id),
    })),
  );
}

// ---------------------------------------------------------------------------
// dunning_stages
// ---------------------------------------------------------------------------

export async function selectStagesByPolicy(
  db: TenantDatabase,
  policyId: Buffer,
): Promise<readonly DunningStageRow[]> {
  return db
    .selectFrom('dunning_stages')
    .select([
      'id',
      'policy_id',
      'stage_number',
      'offset_days',
      'subject',
      'body',
      'late_fee_minor',
    ])
    .where('policy_id', '=', policyId)
    .orderBy('stage_number', 'asc')
    .execute();
}

/**
 * Replaces a policy's whole ladder: delete every existing stage, then bulk
 * insert the new set. Mirrors `ar-documents.repository.ts`'s
 * `replaceDocumentLines` — a stage carries no identity a caller can address on
 * its own (the wire contract has no stage id, see `dunning.ts`'s header), so
 * "replace the set" is the only edit this table offers and it is simpler than a
 * diff that has nowhere to report its result.
 */
export async function replacePolicyStages(
  db: TenantDatabase,
  policyId: Buffer,
  stages: readonly NewStageRow[],
): Promise<void> {
  await db.deleteFrom('dunning_stages').where('policy_id', '=', policyId).execute();

  if (stages.length === 0) return;

  await db
    .insertInto('dunning_stages')
    .values(
      stages.map((stage) => ({
        id: stage.id,
        policy_id: policyId,
        stage_number: stage.stageNumber,
        offset_days: stage.offsetDays,
        subject: stage.subject,
        body: stage.body,
        late_fee_minor: stage.lateFeeMinor,
      })),
    )
    .execute();
}

// ---------------------------------------------------------------------------
// dunning_sends — append-only (0999_app_grants)
// ---------------------------------------------------------------------------

export async function hasSend(
  db: TenantDatabase,
  invoiceId: Buffer,
  stageId: Buffer,
): Promise<boolean> {
  const row = await db
    .selectFrom('dunning_sends')
    .select('id')
    .where('invoice_id', '=', invoiceId)
    .where('stage_id', '=', stageId)
    .executeTakeFirst();

  return row !== undefined;
}

/**
 * Appends one `dunning_sends` row. Never an update — a retried or duplicate
 * attempt at the same `(invoice, stage)` is `uq_dunning_sends_invoice_stage`'s
 * duplicate-key refusal, which the caller (`engine.ts`) treats as "already sent"
 * rather than as a fault, exactly as `insertAccount`'s callers translate 1062
 * into a client-facing answer rather than a 500.
 */
export async function insertSend(db: TenantDatabase, row: NewSendRow): Promise<void> {
  await db
    .insertInto('dunning_sends')
    .values({
      id: row.id,
      invoice_id: row.invoiceId,
      stage_id: row.stageId,
      recipient_email: row.recipientEmail,
      provider_message_id: row.providerMessageId,
      status: row.status,
    })
    .execute();
}

// ---------------------------------------------------------------------------
// Cross-org — the sweep's worklist
// ---------------------------------------------------------------------------

/**
 * Every org holding at least one active dunning policy, read through
 * `systemDb()` rather than `tenantDb`.
 *
 * This is the one query in the module that is deliberately not org-scoped: the
 * sweep handler (`worker.ts`'s `createDunningSweepHandler`) has no org yet when
 * it runs — it *is* the thing that discovers which orgs need work — so there is
 * no `ctx` to scope it to and `tenantDb` is the wrong tool by construction (it
 * requires exactly the org this query has not yet found). `systemDb()` is the
 * sanctioned way to reach a tenant table without one, the same escape hatch
 * `selectDeliveryCredentialByKeyPrefix` uses to resolve a hosted-page token
 * before any org is known.
 */
export async function selectOrgIdsWithActivePolicies(db: Kysely<DB>): Promise<readonly Buffer[]> {
  const rows = await db
    .selectFrom('dunning_policies')
    .select('org_id')
    .where('is_active', '=', 1)
    .distinct()
    .execute();

  return rows.map((row) => row.org_id);
}
