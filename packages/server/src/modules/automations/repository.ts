import type {
  Automation,
  AutomationAction,
  AutomationTrigger,
  AutomationTriggerType,
  WorkItem,
  WorkItemStatus,
} from '@openbooks/shared-types';
import { automationActionsSchema, automationTriggerSchema } from '@openbooks/shared-types';
import type { Kysely } from 'kysely';

import type { RequestContext } from '../../context';
import type { DB, KeysetOrdering, KeysetPage, TenantDatabase } from '../../db';
import {
  applyKeyset,
  bufferToUuid,
  instantKey,
  newUuidBuffer,
  orgScope as toOrgId,
  tenantDb,
  toKeysetPage,
  tryUuidToBuffer,
  uuidKey,
} from '../../db';
import { InternalError } from '../../errors';

/**
 * Data access for `automations`, `work_items`, and `automation_annotations`
 * (initiative Q, M6; OB-200…210; ROADMAP D-99/D-100/D-118/D-119, `0018_automations`).
 *
 * Everything writable goes through `tenantDb`, so `org_id = ctx.orgId` is on every
 * statement before this file adds a predicate (OB-013), matching every other
 * repository in this tree. `selectDueScheduledAutomations`,
 * `selectOrgIdsWithActiveEventAutomations`, and `selectOrgIdsWithExpiredLeases` are
 * the exceptions — `recurring.repository.ts`'s `selectDueTemplates` reasoning
 * applied three times: the daily sweep has no org yet, which is the question each
 * is answering, so each takes a `Kysely<DB>` (`systemDb()`) and reads across every
 * org at once. Nothing any of them returns is written back through that handle;
 * the per-org and per-automation work that follows re-enters through `orgScope`
 * (or a fresh `tenantDb(orgId)`) once the org is known.
 */

/** The resource token every miss in this module reports (A7). */
export const AUTOMATION_RESOURCE = 'automation';
export const WORK_ITEM_RESOURCE = 'work_item';

// ---------------------------------------------------------------------------
// automations
// ---------------------------------------------------------------------------

const AUTOMATION_COLUMNS = [
  'id',
  'name',
  'is_active',
  'trigger_type',
  'trigger_config',
  'actions',
  'last_fired_run_date',
  'created_at',
  'updated_at',
] as const;

export interface AutomationRow {
  readonly id: Buffer;
  readonly name: string;
  readonly is_active: number;
  readonly trigger_type: AutomationTriggerType;
  /** JSON, already parsed by mysql2 (`Json`'s select type) — narrowed in `toTrigger`. */
  readonly trigger_config: unknown;
  /** JSON, already parsed — narrowed in `toActions`. */
  readonly actions: unknown;
  readonly last_fired_run_date: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/** The sweep's own minimal read: which org an automation lives in, and its id. */
export interface DueScheduledAutomationRef {
  readonly org_id: Buffer;
  readonly id: Buffer;
}

export interface NewAutomationRow {
  readonly name: string;
  readonly triggerType: AutomationTriggerType;
  readonly triggerConfig: Record<string, unknown>;
  readonly actions: readonly AutomationAction[];
  readonly createdByUserId: Buffer;
}

/** `name`/`trigger`/`actions` may change through `updateAutomation`; `isActive` is a separate door. */
export interface AutomationPatch {
  readonly name?: string;
  readonly triggerType?: AutomationTriggerType;
  readonly triggerConfig?: Record<string, unknown>;
  readonly actions?: readonly AutomationAction[];
}

/** The org-scoped handle for the current operation (spec §4: no org parameters). */
export function orgScope(ctx: RequestContext): TenantDatabase {
  return tenantDb(toOrgId(ctx.orgId));
}

/**
 * A client-supplied id as bytes, or `undefined` when it is not a UUID.
 *
 * Undefined rather than a throw, so the service routes a malformed id through
 * `assertFound` to the same 404 a nonexistent one produces (A7).
 */
export function automationIdBytes(automationId: string): Buffer | undefined {
  return tryUuidToBuffer(automationId);
}

export function workItemIdBytes(workItemId: string): Buffer | undefined {
  return tryUuidToBuffer(workItemId);
}

export async function insertAutomation(
  db: TenantDatabase,
  input: NewAutomationRow,
): Promise<Buffer> {
  const id = newUuidBuffer();

  await db
    .insertInto('automations')
    .values({
      id,
      name: input.name,
      trigger_type: input.triggerType,
      // Stringified here rather than by the caller — `periods.repository.ts`'s
      // `insertPeriodCloseEvent` reasoning for its own `Json` column: one place
      // knows the column is JSON-as-string, not every caller.
      trigger_config: JSON.stringify(input.triggerConfig),
      actions: JSON.stringify(input.actions),
      created_by_user_id: input.createdByUserId,
      // Not `Generated<>` (nullable, no column default) — Kysely's `InsertObject`
      // requires it explicitly, `insertRecurringTemplate`'s `last_run_date: null`.
      last_fired_run_date: null,
    })
    .execute();

  return id;
}

export async function selectAutomationById(
  db: TenantDatabase,
  id: Buffer,
): Promise<AutomationRow | undefined> {
  return db
    .selectFrom('automations')
    .select(AUTOMATION_COLUMNS)
    .where('id', '=', id)
    .executeTakeFirst();
}

/**
 * The same read, taking an exclusive row lock — every write below (`update`,
 * `activate`, and the scheduled-firing dispatch guard in `job.ts`) reloads under
 * this lock first, `recurring.repository.ts`'s `selectRecurringTemplateByIdForUpdate`
 * reasoning restated: `automations` is in `0999_app_grants`'s mutable allowlist, so
 * the app user may take a locking read on it.
 */
export async function selectAutomationByIdForUpdate(
  db: TenantDatabase,
  id: Buffer,
): Promise<AutomationRow | undefined> {
  return db
    .selectFrom('automations')
    .select(AUTOMATION_COLUMNS)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
}

export async function updateAutomationRow(
  db: TenantDatabase,
  id: Buffer,
  patch: AutomationPatch,
): Promise<void> {
  await db
    .updateTable('automations')
    .set({
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.triggerType === undefined ? {} : { trigger_type: patch.triggerType }),
      ...(patch.triggerConfig === undefined
        ? {}
        : { trigger_config: JSON.stringify(patch.triggerConfig) }),
      ...(patch.actions === undefined ? {} : { actions: JSON.stringify(patch.actions) }),
    })
    .where('id', '=', id)
    .execute();
}

/** The reserved compose-vs-activate split's own write (`workflows.activate`). */
export async function setAutomationActiveRow(
  db: TenantDatabase,
  id: Buffer,
  isActive: boolean,
): Promise<void> {
  await db
    .updateTable('automations')
    .set({ is_active: isActive ? 1 : 0 })
    .where('id', '=', id)
    .execute();
}

/** The scheduled-firing once-per-cycle guard's advance (`recurring_invoice_templates.last_run_date`'s role). */
export async function advanceAutomationFiredDate(
  db: TenantDatabase,
  id: Buffer,
  runDate: string,
): Promise<void> {
  await db
    .updateTable('automations')
    .set({ last_fired_run_date: runDate })
    .where('id', '=', id)
    .execute();
}

/**
 * Every active scheduled automation due to fire on `runDate`, across every org.
 *
 * "Due" is simplified to v1's own guard: a scheduled automation fires once per
 * calendar date regardless of `cadence` — `last_fired_run_date` is either unset or
 * behind `runDate`. Reads `idx_automations_org_trigger (org_id, trigger_type,
 * is_active)`, org by org even though this reads across all of them at once,
 * `selectDueTemplates`'s own reasoning.
 */
export async function selectDueScheduledAutomations(
  db: Kysely<DB>,
  runDate: string,
): Promise<readonly DueScheduledAutomationRef[]> {
  return db
    .selectFrom('automations')
    .select(['org_id', 'id'])
    .where('is_active', '=', 1)
    .where('trigger_type', '=', 'scheduled')
    .where((eb) =>
      eb.or([eb('last_fired_run_date', 'is', null), eb('last_fired_run_date', '<>', runDate)]),
    )
    .execute();
}

/**
 * Every org holding at least one active event-triggered automation, read through
 * `systemDb()` — `dunning.repository.ts`'s `selectOrgIdsWithActivePolicies`
 * reasoning exactly: the event sweep has no org yet, which is the question this
 * answers, so there is no `ctx` to scope it to.
 */
export async function selectOrgIdsWithActiveEventAutomations(
  db: Kysely<DB>,
): Promise<readonly Buffer[]> {
  const rows = await db
    .selectFrom('automations')
    .select('org_id')
    .where('is_active', '=', 1)
    .where('trigger_type', '=', 'event')
    .distinct()
    .execute();

  return rows.map((row) => row.org_id);
}

/** Every active event-triggered automation in one org, for the event sweep's own match. */
export async function selectActiveEventAutomations(
  db: TenantDatabase,
): Promise<readonly AutomationRow[]> {
  return db
    .selectFrom('automations')
    .select(AUTOMATION_COLUMNS)
    .where('is_active', '=', 1)
    .where('trigger_type', '=', 'event')
    .execute();
}

/** `(created_at, id)` — `contacts.repository.ts`'s ordering, the only one available here. */
const AUTOMATION_KEYSET: KeysetOrdering<AutomationRow> = [
  instantKey('automations.created_at', (row) => row.created_at),
  uuidKey('automations.id', (row) => row.id),
];

export interface AutomationFilters {
  readonly isActive?: boolean | undefined;
  readonly triggerType?: AutomationTriggerType | undefined;
  readonly cursor?: string | undefined;
}

export async function selectAutomationsPage(
  db: TenantDatabase,
  filters: AutomationFilters,
  limit: number,
): Promise<KeysetPage<AutomationRow>> {
  let query = db.selectFrom('automations').select(AUTOMATION_COLUMNS);

  if (filters.isActive !== undefined) {
    query = query.where('is_active', '=', filters.isActive ? 1 : 0);
  }
  if (filters.triggerType !== undefined) {
    query = query.where('trigger_type', '=', filters.triggerType);
  }

  const rows = await applyKeyset(query, AUTOMATION_KEYSET, limit, filters.cursor).execute();

  return toKeysetPage(rows, AUTOMATION_KEYSET, limit);
}

/**
 * Reassembles the wire `Automation`, splitting `trigger` back out of the two
 * columns that store it and validating both JSON columns against the schemas
 * that wrote them (`isActorType`/`isInvocationMode`'s narrow-and-fault pattern,
 * `change-feed.service.ts`) — a mismatch here is this process's own write having
 * gone wrong, not a caller's mistake.
 */
export function toAutomation(row: AutomationRow): Automation {
  return {
    id: bufferToUuid(row.id),
    name: row.name,
    isActive: row.is_active !== 0,
    trigger: toTrigger(row.trigger_type, row.trigger_config),
    actions: toActions(row.actions),
    lastFiredRunDate: row.last_fired_run_date,
  };
}

function toTrigger(triggerType: AutomationTriggerType, triggerConfig: unknown): AutomationTrigger {
  const candidate = { type: triggerType, ...(isPlainObject(triggerConfig) ? triggerConfig : {}) };
  const parsed = automationTriggerSchema.safeParse(candidate);

  if (!parsed.success) {
    throw new InternalError(
      `automations.trigger_config did not match trigger_type "${triggerType}".`,
    );
  }
  return parsed.data;
}

function toActions(actions: unknown): AutomationAction[] {
  const parsed = automationActionsSchema.safeParse(actions);

  if (!parsed.success) {
    throw new InternalError('automations.actions held a shape the current schema does not accept.');
  }
  return parsed.data;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// automation_annotations — the `annotate` action's output (append-only)
// ---------------------------------------------------------------------------

export interface NewAnnotationRow {
  readonly automationId: Buffer;
  readonly runToken: Buffer;
  readonly note: string;
}

export async function insertAutomationAnnotation(
  db: TenantDatabase,
  input: NewAnnotationRow,
): Promise<void> {
  await db
    .insertInto('automation_annotations')
    .values({
      id: newUuidBuffer(),
      automation_id: input.automationId,
      run_token: input.runToken,
      note: input.note,
    })
    .execute();
}

// ---------------------------------------------------------------------------
// work_items — the queue
// ---------------------------------------------------------------------------

const WORK_ITEM_COLUMNS = [
  'id',
  'automation_id',
  'source_kind',
  'source_ref',
  'prompt',
  'context',
  'status',
  'attempts',
  'flagged',
  'proposed_draft_id',
  'agent_model',
  'leased_by',
  'lease_expires_at',
  'submitted_at',
  'last_error',
  'created_at',
] as const;

/** `lease_token` and `leased_at` are read separately (`selectNextQueuedWorkItemForUpdate`,
 * `selectWorkItemByLeaseTokenForUpdate`) — nothing on the wire exposes either. */
const WORK_ITEM_LEASE_COLUMNS = [...WORK_ITEM_COLUMNS, 'lease_token', 'leased_at'] as const;

export interface WorkItemRow {
  readonly id: Buffer;
  readonly automation_id: Buffer | null;
  readonly source_kind: string;
  readonly source_ref: string | null;
  readonly prompt: string;
  /** JSON, already parsed — narrowed in `toWorkItem`. */
  readonly context: unknown;
  readonly status: WorkItemStatus;
  readonly attempts: number;
  readonly flagged: number;
  readonly proposed_draft_id: Buffer | null;
  readonly agent_model: string | null;
  readonly leased_by: string | null;
  readonly lease_expires_at: Date | null;
  readonly submitted_at: Date | null;
  readonly last_error: string | null;
  readonly created_at: Date;
}

export interface WorkItemLeaseRow extends WorkItemRow {
  readonly lease_token: Buffer | null;
  readonly leased_at: Date | null;
}

export interface NewWorkItemRow {
  readonly automationId: Buffer | null;
  readonly runToken: Buffer | null;
  readonly sourceKind: string;
  readonly sourceRef: string | null;
  readonly prompt: string;
  readonly context: Record<string, unknown>;
}

export async function insertWorkItem(db: TenantDatabase, input: NewWorkItemRow): Promise<Buffer> {
  const id = newUuidBuffer();

  await db
    .insertInto('work_items')
    .values({
      id,
      automation_id: input.automationId,
      run_token: input.runToken,
      source_kind: input.sourceKind,
      source_ref: input.sourceRef,
      prompt: input.prompt,
      context: JSON.stringify(input.context),
      // None of these are `Generated<>` (nullable, no column default), so
      // Kysely's `InsertObject` requires each explicitly — `insertAutomation`'s
      // `last_fired_run_date: null` restated six more times. All settled later,
      // by `leaseWorkItemRow` / `proposeWorkItemRow`.
      agent_model: null,
      last_error: null,
      lease_expires_at: null,
      lease_token: null,
      leased_at: null,
      leased_by: null,
      proposed_draft_id: null,
      submitted_at: null,
      submitted_by_client: null,
    })
    .execute();

  return id;
}

export async function selectWorkItemById(
  db: TenantDatabase,
  id: Buffer,
): Promise<WorkItemRow | undefined> {
  return db
    .selectFrom('work_items')
    .select(WORK_ITEM_COLUMNS)
    .where('id', '=', id)
    .executeTakeFirst();
}

export async function selectWorkItemByIdForUpdate(
  db: TenantDatabase,
  id: Buffer,
): Promise<WorkItemRow | undefined> {
  return db
    .selectFrom('work_items')
    .select(WORK_ITEM_COLUMNS)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
}

/**
 * The poll (Q10): the oldest `queued` item in this org, taken `FOR UPDATE SKIP
 * LOCKED` — the single-grant mechanism. Two concurrent polls racing this
 * statement never receive the same row (the row lock) and never block each
 * other on a row the other already holds (`SKIP LOCKED` rather than plain `FOR
 * UPDATE`, which would make the second poller wait on the first's transaction
 * instead of moving on to the next-oldest item).
 */
export async function selectNextQueuedWorkItemForUpdate(
  db: TenantDatabase,
): Promise<WorkItemRow | undefined> {
  return db
    .selectFrom('work_items')
    .select(WORK_ITEM_COLUMNS)
    .where('status', '=', 'queued')
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .limit(1)
    .forUpdate()
    .skipLocked()
    .executeTakeFirst();
}

/**
 * The submission's own lock: the leased item this token names, reloaded
 * `FOR UPDATE` so two submissions racing one lease serialize rather than both
 * reading `status = 'leased'` and both creating a draft.
 */
export async function selectWorkItemByLeaseTokenForUpdate(
  db: TenantDatabase,
  leaseToken: Buffer,
): Promise<WorkItemLeaseRow | undefined> {
  return db
    .selectFrom('work_items')
    .select(WORK_ITEM_LEASE_COLUMNS)
    .where('lease_token', '=', leaseToken)
    .forUpdate()
    .executeTakeFirst();
}

export interface LeaseGrant {
  readonly leaseToken: Buffer;
  readonly leasedBy: string;
  readonly leasedAt: Date;
  readonly leaseExpiresAt: Date;
}

export async function leaseWorkItemRow(
  db: TenantDatabase,
  id: Buffer,
  grant: LeaseGrant,
): Promise<void> {
  await db
    .updateTable('work_items')
    .set({
      status: 'leased',
      lease_token: grant.leaseToken,
      leased_by: grant.leasedBy,
      leased_at: grant.leasedAt,
      lease_expires_at: grant.leaseExpiresAt,
    })
    .where('id', '=', id)
    .execute();
}

export interface ProposalGrant {
  readonly proposedDraftId: Buffer;
  readonly agentModel: string | null;
  readonly submittedByClient: string;
  readonly submittedAt: Date;
}

/** Also clears the lease: a proposed item is settled, not held. */
export async function proposeWorkItemRow(
  db: TenantDatabase,
  id: Buffer,
  grant: ProposalGrant,
): Promise<void> {
  await db
    .updateTable('work_items')
    .set({
      status: 'proposed',
      proposed_draft_id: grant.proposedDraftId,
      agent_model: grant.agentModel,
      submitted_by_client: grant.submittedByClient,
      submitted_at: grant.submittedAt,
      lease_token: null,
      leased_by: null,
      leased_at: null,
      lease_expires_at: null,
    })
    .where('id', '=', id)
    .execute();
}

/** Also clears the lease, for the same reason. Idempotent: a re-cancel is a no-op. */
export async function cancelWorkItemRow(db: TenantDatabase, id: Buffer): Promise<void> {
  await db
    .updateTable('work_items')
    .set({
      status: 'cancelled',
      lease_token: null,
      leased_by: null,
      leased_at: null,
      lease_expires_at: null,
    })
    .where('id', '=', id)
    .execute();
}

/** `(created_at, id)` — the same ordering `AUTOMATION_KEYSET` uses, for the same reason. */
const WORK_ITEM_KEYSET: KeysetOrdering<WorkItemRow> = [
  instantKey('work_items.created_at', (row) => row.created_at),
  uuidKey('work_items.id', (row) => row.id),
];

export interface WorkItemFilters {
  readonly status?: WorkItemStatus | undefined;
  readonly automationId?: Buffer | undefined;
  readonly cursor?: string | undefined;
}

export async function selectWorkItemsPage(
  db: TenantDatabase,
  filters: WorkItemFilters,
  limit: number,
): Promise<KeysetPage<WorkItemRow>> {
  let query = db.selectFrom('work_items').select(WORK_ITEM_COLUMNS);

  if (filters.status !== undefined) {
    query = query.where('status', '=', filters.status);
  }
  if (filters.automationId !== undefined) {
    query = query.where('automation_id', '=', filters.automationId);
  }

  const rows = await applyKeyset(query, WORK_ITEM_KEYSET, limit, filters.cursor).execute();

  return toKeysetPage(rows, WORK_ITEM_KEYSET, limit);
}

export function toWorkItem(row: WorkItemRow): WorkItem {
  return {
    id: bufferToUuid(row.id),
    automationId: row.automation_id === null ? null : bufferToUuid(row.automation_id),
    sourceKind: row.source_kind,
    sourceRef: row.source_ref,
    prompt: row.prompt,
    context: toWorkItemContext(row.context),
    status: row.status,
    attempts: row.attempts,
    flagged: row.flagged !== 0,
    proposedDraftId: row.proposed_draft_id === null ? null : bufferToUuid(row.proposed_draft_id),
    agentModel: row.agent_model,
    leasedBy: row.leased_by,
    // `timezone: 'Z'` on the pool and `DATETIME(3)` left as a `Date`
    // (`src/db/connection.ts`), so these are real instants.
    leaseExpiresAt: row.lease_expires_at === null ? null : row.lease_expires_at.toISOString(),
    submittedAt: row.submitted_at === null ? null : row.submitted_at.toISOString(),
    lastError: row.last_error,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * `context` is producer-defined JSON, opaque to the API (`workItemContextSchema`).
 * Narrowed the way `toChangeFeedPayload` narrows `event_log.payload`: every writer
 * in this module (`engine.ts`'s `insertWorkItem` call) always supplies a plain
 * object, so anything else here is this process's own write having gone wrong.
 */
export function toWorkItemContext(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new InternalError('work_items.context did not hold a JSON object.');
}

// ---------------------------------------------------------------------------
// Lease-expiry recovery (Q7) — cross-org discovery, per-org requeue
// ---------------------------------------------------------------------------

/**
 * Every org holding at least one work item whose lease has expired, read through
 * `systemDb()` — the same cross-org exception `selectOrgIdsWithActiveEventAutomations`
 * documents, for the same reason: the recovery sweep has no org yet.
 */
export async function selectOrgIdsWithExpiredLeases(
  db: Kysely<DB>,
  now: Date,
): Promise<readonly Buffer[]> {
  const rows = await db
    .selectFrom('work_items')
    .select('org_id')
    .where('status', '=', 'leased')
    .where('lease_expires_at', '<', now)
    .distinct()
    .execute();

  return rows.map((row) => row.org_id);
}

export interface ExpiredLeaseRef {
  readonly id: Buffer;
  readonly attempts: number;
}

export async function selectExpiredLeasedWorkItems(
  db: TenantDatabase,
  now: Date,
): Promise<readonly ExpiredLeaseRef[]> {
  return db
    .selectFrom('work_items')
    .select(['id', 'attempts'])
    .where('status', '=', 'leased')
    .where('lease_expires_at', '<', now)
    .execute();
}

/**
 * Requeues one expired lease: back to `queued`, the lease cleared, `attempts`
 * incremented, and `flagged` set once `attempts` has reached the threshold —
 * never dropped (Q7). The `status = 'leased'` guard in the `WHERE` is what makes
 * this safe with no row lock held across the read and this write: if
 * `submitWorkItemProposal` won the race and already moved the item to
 * `proposed` (clearing the lease) between the read and here, this update
 * matches zero rows and is a safe no-op rather than clobbering a settled item.
 */
export async function requeueExpiredWorkItem(
  db: TenantDatabase,
  id: Buffer,
  nextAttempts: number,
  flagged: boolean,
): Promise<void> {
  await db
    .updateTable('work_items')
    .set({
      status: 'queued',
      lease_token: null,
      leased_by: null,
      leased_at: null,
      lease_expires_at: null,
      attempts: nextAttempts,
      flagged: flagged ? 1 : 0,
    })
    .where('id', '=', id)
    .where('status', '=', 'leased')
    .execute();
}

// ---------------------------------------------------------------------------
// change_feed_cursors — the event sweep's own replay position (D-57)
// ---------------------------------------------------------------------------

/**
 * The subscriber's cursor position, creating the row at position 0 if absent —
 * `event_positions`' insert-or-noop-then-read shape (`outbox.ts`'s
 * `allocateEventPosition`), applied to a bookmark rather than a counter. No
 * `FOR UPDATE`: this sweep is the only writer of its own `(org_id, subscriber)`
 * row, so there is no concurrent writer for a lock to serialize against, unlike
 * `event_positions`, which arbitrates concurrent postings.
 */
export async function selectOrCreateCursorPosition(
  db: TenantDatabase,
  subscriber: string,
): Promise<bigint> {
  await db
    .insertInto('change_feed_cursors')
    .values({ id: newUuidBuffer(), subscriber, position: 0n })
    .onDuplicateKeyUpdate({ subscriber })
    .execute();

  const row = await db
    .selectFrom('change_feed_cursors')
    .select('position')
    .where('subscriber', '=', subscriber)
    .executeTakeFirstOrThrow();

  return row.position;
}

export async function advanceCursorPosition(
  db: TenantDatabase,
  subscriber: string,
  position: bigint,
): Promise<void> {
  await db
    .updateTable('change_feed_cursors')
    .set({ position })
    .where('subscriber', '=', subscriber)
    .execute();
}

export interface EventLogRow {
  readonly id: Buffer;
  readonly position: bigint;
  readonly name: string;
  readonly payload: unknown;
}

/** New `event_log` rows past `position`, oldest first, bounded per sweep (`limit`). */
export async function selectEventLogPageAfter(
  db: TenantDatabase,
  position: bigint,
  limit: number,
): Promise<readonly EventLogRow[]> {
  return db
    .selectFrom('event_log')
    .select(['id', 'position', 'name', 'payload'])
    .where('position', '>', position)
    .orderBy('position', 'asc')
    .limit(limit)
    .execute();
}

/**
 * `event_log.payload`'s narrowing, `change-feed.service.ts`'s `toChangeFeedPayload`
 * restated here rather than imported across the module boundary: both read the
 * same JSON column and both apply the identical narrow-or-fault rule, but neither
 * is the other's concern to depend on.
 */
export function toEventPayload(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new InternalError('event_log.payload did not hold a JSON object.');
}
