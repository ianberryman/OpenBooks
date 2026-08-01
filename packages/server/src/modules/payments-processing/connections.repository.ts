import type { Kysely } from 'kysely';

import type { ProcessorKind } from '@openbooks/plugin-api';
import type { PayoutSyncMode, ProcessorConnection } from '@openbooks/shared-types';

import type { RequestContext } from '../../context';
import type { DB, TenantDatabase } from '../../db';
import { bufferToUuid, orgScope as toOrgId, tenantDb, tryUuidToBuffer } from '../../db';

/**
 * Data access for `processor_connections` (initiative J, OB-147; ROADMAP D-82, D-103;
 * migration `0011_payment_processing`).
 *
 * Everything goes through `tenantDb`, so `org_id = ctx.orgId` is on every statement
 * before this file adds a predicate — a cross-org connection id matches nothing and
 * the service's `assertFound` turns that into the one 404 a miss may produce (A7).
 * `selectAllActiveConnectionsAcrossOrgs` is the one exception, for
 * `selectDueTemplates`'s exact reason (`recurring.repository.ts`): the D-85 daily
 * poll (OB-148) has no org yet when it asks "which connections need polling."
 *
 * `secret_ref`/`webhook_secret_ref` are the only trace of a credential this file ever
 * writes. The values themselves never pass through here — only the opaque handles the
 * secrets provider returned from its own `put` (D-101, D-83). Nothing here reads
 * `secrets` directly; that table is reached exclusively through `secretsProvider()`
 * (`providers/index.ts`), never through `tenantDb` or a raw handle from this module.
 */

/** The token a connection lookup answers a miss with (A7, E9). */
export const PROCESSOR_CONNECTION_RESOURCE = 'processor_connection';

/**
 * The token the register pre-check answers with when `clearingAccountId`/
 * `feeAccountId` names no ledger account, restated rather than imported —
 * `settings.repository.ts`'s `ACCOUNT_RESOURCE` comment gives the reason: importing
 * the chart module would assert a dependency edge dependency-cruiser would then hold
 * this module to, for a check made once at connect time.
 */
export const LEDGER_ACCOUNT_RESOURCE = 'account';

const CONNECTION_COLUMNS = [
  'id',
  'processor',
  'clearing_account_id',
  'fee_account_id',
  'publishable_key',
  'secret_ref',
  'webhook_secret_ref',
  'external_account_id',
  'last_polled_at',
  'reconciled_through',
  'sync_mode',
  'auto_post',
  'event_cursor',
  'is_active',
  'created_by_user_id',
  'created_at',
  'updated_at',
] as const;

export interface ConnectionRow {
  readonly id: Buffer;
  readonly processor: ProcessorKind;
  readonly clearing_account_id: Buffer;
  readonly fee_account_id: Buffer;
  readonly publishable_key: string | null;
  readonly secret_ref: string;
  readonly webhook_secret_ref: string;
  readonly external_account_id: string | null;
  readonly last_polled_at: Date | null;
  readonly reconciled_through: Date | null;
  readonly sync_mode: PayoutSyncMode;
  readonly auto_post: number;
  readonly event_cursor: string | null;
  readonly is_active: number;
  readonly created_by_user_id: Buffer;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface NewConnectionRow {
  readonly id: Buffer;
  readonly processor: ProcessorKind;
  readonly clearingAccountId: Buffer;
  readonly feeAccountId: Buffer;
  readonly publishableKey: string | null;
  readonly secretRef: string;
  readonly webhookSecretRef: string;
  readonly externalAccountId: string | null;
  readonly createdByUserId: Buffer;
}

/** The org-scoped handle for the current operation (spec §4: no org parameters). */
export function orgScope(ctx: RequestContext): TenantDatabase {
  return tenantDb(toOrgId(ctx.orgId));
}

/**
 * A client-supplied connection id as bytes, or `undefined` when it is not a UUID.
 *
 * Undefined rather than a throw, so the service routes a malformed id through
 * `assertFound` to the same 404 a nonexistent one produces — a 400 here would be a
 * distinguishable answer for a class of ids, which is the shape A7 rules out.
 */
export function connectionIdBytes(id: string): Buffer | undefined {
  return tryUuidToBuffer(id);
}

/**
 * Whether a ledger account exists in this org and is active — the register
 * pre-check's `assertFound` plus D-23's "nominate, don't invent". Mirrors
 * `selectNominatedAccount` in `settings/settings.repository.ts`: a local query
 * against a literal token rather than a cross-module import, for that file's
 * own stated reason.
 */
export async function selectAccountActive(
  db: TenantDatabase,
  accountId: Buffer,
): Promise<boolean | undefined> {
  const row = await db
    .selectFrom('accounts')
    .select('is_active')
    .where('id', '=', accountId)
    .executeTakeFirst();
  return row === undefined ? undefined : row.is_active !== 0;
}

/**
 * Any existing connection for this processor, active or not.
 *
 * `uq_processor_connections_org_processor` makes this unconditional at the schema
 * level (one row per `(org_id, processor)` forever, regardless of `is_active`), so
 * this is the pre-check that turns a second `connectProcessor` for the same
 * processor into the readable `processor_already_connected` precondition rather
 * than an opaque duplicate-key 500 — the same shape `createExternalRef`'s
 * pre-check/insert-catch pair gives its own unique keys.
 */
export async function selectConnectionByProcessor(
  db: TenantDatabase,
  processor: ProcessorKind,
): Promise<Pick<ConnectionRow, 'id'> | undefined> {
  return db
    .selectFrom('processor_connections')
    .select('id')
    .where('processor', '=', processor)
    .executeTakeFirst();
}

export async function insertConnection(db: TenantDatabase, input: NewConnectionRow): Promise<void> {
  await db
    .insertInto('processor_connections')
    .values({
      id: input.id,
      processor: input.processor,
      clearing_account_id: input.clearingAccountId,
      fee_account_id: input.feeAccountId,
      publishable_key: input.publishableKey,
      secret_ref: input.secretRef,
      webhook_secret_ref: input.webhookSecretRef,
      external_account_id: input.externalAccountId,
      // Nullable, but not `Generated` (no schema `DEFAULT`), so Kysely's insert
      // type requires them named — a fresh connection has neither yet: the D-85
      // backstop has not polled it and there is nothing to reconcile through.
      // `event_cursor` (OB-237/D-237-5) is the same shape — no cursor until the
      // first poll pages. `sync_mode`/`auto_post` carry schema DEFAULTs, so Kysely
      // treats them as generated and a fresh connection starts in `apply_payments`,
      // review-first, exactly like PAY before OB-237.
      last_polled_at: null,
      reconciled_through: null,
      event_cursor: null,
      created_by_user_id: input.createdByUserId,
    })
    .execute();
}

export async function selectConnectionById(
  db: TenantDatabase,
  id: Buffer,
): Promise<ConnectionRow | undefined> {
  return db
    .selectFrom('processor_connections')
    .select(CONNECTION_COLUMNS)
    .where('id', '=', id)
    .executeTakeFirst();
}

/**
 * The same read, taking an exclusive row lock — `bank-accounts.repository.ts`'s
 * `selectBankAccountByIdForUpdate` shape, applied to the row the PAY execution plan
 * names as the serialization point (ROADMAP "PAY execution", the two-level
 * idempotency note): because journals are append-only and cannot themselves be
 * `SELECT … FOR UPDATE`'d (D-14), the check-`external_refs`-then-`recordPayment`
 * step in `posting.service.ts` locks this row first, so two concurrent deliveries
 * reporting the same charge serialize here rather than both reaching `recordPayment`
 * unguarded. `processor_connections` is in `0999_app_grants`'s mutable allowlist,
 * which is what makes the locking read legal for `openbooks_app` at all.
 */
export async function selectConnectionByIdForUpdate(
  db: TenantDatabase,
  id: Buffer,
): Promise<ConnectionRow | undefined> {
  return db
    .selectFrom('processor_connections')
    .select(CONNECTION_COLUMNS)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
}

/**
 * Every connection the org holds, oldest first.
 *
 * Not keyset-paginated, unlike `selectBankAccountsPage`: `uq_processor_connections_org_processor`
 * bounds this list to at most `PROCESSOR_KINDS.length` rows per org (three today), so
 * a page cursor would be machinery answering a question this table cannot ask.
 */
export async function selectAllConnections(db: TenantDatabase): Promise<readonly ConnectionRow[]> {
  return db
    .selectFrom('processor_connections')
    .select(CONNECTION_COLUMNS)
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .execute();
}

/** `selectAllConnections`' columns plus `org_id`, for the cross-org poll sweep below. */
const POLL_SWEEP_COLUMNS = ['org_id', 'id'] as const;

export interface ActiveConnectionForPoll {
  readonly org_id: Buffer;
  readonly id: Buffer;
}

/**
 * Every active connection, across every org — the D-85 daily poll's own worklist
 * (OB-148), `selectDueTemplates`' exception restated for this table
 * (`recurring.repository.ts`): the sweep has no org yet, that is the question it is
 * answering, so it takes `Kysely<DB>` (the `systemDb()` handle) directly rather than
 * `tenantDb`. Nothing it returns is written back through this handle; `poll.job.ts`
 * re-enters through `runAsAutomation` once each row's org is known, exactly as the
 * recurring sweep does.
 */
export async function selectAllActiveConnectionsAcrossOrgs(
  db: Kysely<DB>,
): Promise<readonly ActiveConnectionForPoll[]> {
  return db
    .selectFrom('processor_connections')
    .select(POLL_SWEEP_COLUMNS)
    .where('is_active', '=', 1)
    .orderBy('org_id', 'asc')
    .orderBy('id', 'asc')
    .execute();
}

export async function setConnectionActiveRow(
  db: TenantDatabase,
  id: Buffer,
  isActive: boolean,
): Promise<void> {
  await db
    .updateTable('processor_connections')
    .set({ is_active: isActive ? 1 : 0 })
    .where('id', '=', id)
    .execute();
}

/**
 * Advances the D-85 backstop cursor. `recordProcessorPayout` (`posting.service.ts`)
 * is the one caller — per D-82 the payout's own reconciling journal is posted by the
 * existing M4 `link_entry` clear, not here; this only moves the cursor the daily poll
 * reads to know how far the clearing account has been accounted for.
 */
export async function advanceReconciledThrough(
  db: TenantDatabase,
  id: Buffer,
  through: Date,
): Promise<void> {
  await db
    .updateTable('processor_connections')
    .set({ reconciled_through: through, last_polled_at: through })
    .where('id', '=', id)
    .execute();
}

/**
 * Advances the opaque event cursor (OB-237, D-237-5) — the fix for the
 * timestamp-as-cursor defect the poll header (`poll.job.ts`) and
 * `plugin-api/providers.ts` both flag. The poll passes `listEventsSince`'s
 * returned cursor (Stripe's last-seen event id) here after a successful page, so
 * the next sweep resumes from a real id, never `last_polled_at`'s ISO string.
 */
export async function advanceEventCursor(
  db: TenantDatabase,
  id: Buffer,
  cursor: string,
): Promise<void> {
  await db
    .updateTable('processor_connections')
    .set({ event_cursor: cursor })
    .where('id', '=', id)
    .execute();
}

/** Sets a connection's payout-sync mode and auto-post (OB-237, D-237-1/D-237-2). */
export async function setSyncConfigRow(
  db: TenantDatabase,
  id: Buffer,
  syncMode: PayoutSyncMode,
  autoPost: boolean,
): Promise<void> {
  await db
    .updateTable('processor_connections')
    .set({ sync_mode: syncMode, auto_post: autoPost ? 1 : 0 })
    .where('id', '=', id)
    .execute();
}

/** Never includes `secret_ref`/`webhook_secret_ref` or the values they name (D-83). */
export function toProcessorConnection(row: ConnectionRow): ProcessorConnection {
  return {
    id: bufferToUuid(row.id),
    processor: row.processor,
    clearingAccountId: bufferToUuid(row.clearing_account_id),
    feeAccountId: bufferToUuid(row.fee_account_id),
    publishableKey: row.publishable_key,
    externalAccountId: row.external_account_id,
    isActive: row.is_active !== 0,
    syncMode: row.sync_mode,
    autoPost: row.auto_post !== 0,
    lastPolledAt: row.last_polled_at === null ? null : row.last_polled_at.toISOString(),
    reconciledThrough:
      row.reconciled_through === null ? null : row.reconciled_through.toISOString(),
  };
}
