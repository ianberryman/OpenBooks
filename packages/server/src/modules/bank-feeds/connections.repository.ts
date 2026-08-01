import type { Kysely } from 'kysely';

import type { BankFeedConnection } from '@openbooks/shared-types';

import type { RequestContext } from '../../context';
import type { DB, KeysetOrdering, KeysetPage, TenantDatabase } from '../../db';
import {
  applyKeyset,
  bufferToUuid,
  instantKey,
  orgScope as toOrgId,
  tenantDb,
  toKeysetPage,
  tryUuidToBuffer,
  uuidKey,
} from '../../db';

/**
 * Data access for `bank_feed_connections` (OB-227; ROADMAP D-126…D-131;
 * migration `0021_bank_feeds`).
 *
 * The `processor_connections` shape (`payments-processing/connections.repository.ts`)
 * applied to a live bank feed: everything goes through `tenantDb`, so
 * `org_id = ctx.orgId` is on every statement before this file adds a predicate — a
 * cross-org connection id matches nothing and the service's `assertFound` turns that
 * into the one 404 a miss may produce (A7). `selectAllActiveConnectionsAcrossOrgs` is
 * the one exception, for `poll.job.ts`'s exact reason (`processor_connections`): the
 * D-129 daily sync has no org yet when it asks "which connections need syncing," so it
 * takes the `systemDb()` handle directly and `feed-sync.service.ts` re-enters through
 * `runAsAutomation` once each row's org is known.
 *
 * `secret_ref` is the only trace of a credential this file ever writes — the opaque
 * handle `secretsProvider().put` returned, never the restricted key itself (D-101,
 * D-83). `toBankFeedConnection` has no field for it, so a leak is a shape error, not a
 * discipline the mapper has to remember. `sync_cursor` is internal too: it advances the
 * pull (D-128) and is never on the DTO.
 */

/** The token a connection lookup answers a miss with (A7, E9). */
export const BANK_FEED_CONNECTION_RESOURCE = 'bank_feed_connection';

/**
 * The token the connect pre-check answers with when `bankAccountId` names no bank
 * account this org holds. A local literal rather than importing banking's
 * `BANK_ACCOUNT_RESOURCE`, for `payments-processing`'s `LEDGER_ACCOUNT_RESOURCE`
 * reason: importing that module to reach one constant would assert a dependency edge
 * dependency-cruiser would then hold this module to, for a check made once at connect
 * time. The string is the same token banking already answers a bank-account miss with.
 */
export const BANK_ACCOUNT_RESOURCE = 'bank_account';

const CONNECTION_COLUMNS = [
  'id',
  'bank_account_id',
  'feed_source',
  'credential_source',
  'secret_ref',
  'external_account_id',
  'institution',
  'sync_cursor',
  'last_synced_at',
  'last_sync_error',
  'is_active',
  'created_by_user_id',
  'created_at',
  'updated_at',
] as const;

export interface ConnectionRow {
  readonly id: Buffer;
  readonly bank_account_id: Buffer;
  readonly feed_source: 'fake' | 'stripe_financial_connections';
  readonly credential_source: 'bring_your_own' | 'managed';
  readonly secret_ref: string;
  readonly external_account_id: string;
  readonly institution: string | null;
  readonly sync_cursor: string | null;
  readonly last_synced_at: Date | null;
  readonly last_sync_error: string | null;
  readonly is_active: number;
  readonly created_by_user_id: Buffer;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface NewConnectionRow {
  readonly id: Buffer;
  readonly bankAccountId: Buffer;
  readonly feedSource: 'fake' | 'stripe_financial_connections';
  readonly credentialSource: 'bring_your_own' | 'managed';
  readonly secretRef: string;
  readonly externalAccountId: string;
  readonly institution: string | null;
  readonly createdByUserId: Buffer;
}

/** The org-scoped handle for the current operation (spec §4: no org parameters). */
export function orgScope(ctx: RequestContext): TenantDatabase {
  return tenantDb(toOrgId(ctx.orgId));
}

/**
 * A client-supplied connection id as bytes, or `undefined` when it is not a UUID —
 * `payments-processing`'s `connectionIdBytes` reasoning: undefined routes a malformed
 * id through `assertFound` to the same 404 a nonexistent one produces, rather than a
 * distinguishable 400 for a class of ids (A7).
 */
export function connectionIdBytes(id: string): Buffer | undefined {
  return tryUuidToBuffer(id);
}

/**
 * Whether a bank account exists in this org — the connect pre-check's `assertFound`
 * (D-46: a feed connects to a bank account the org already has, D-23's "nominate,
 * don't invent"). A local read against a literal token rather than a cross-module
 * import, for `BANK_ACCOUNT_RESOURCE`'s stated reason.
 */
export async function selectBankAccountExists(
  db: TenantDatabase,
  bankAccountId: Buffer,
): Promise<boolean> {
  const row = await db
    .selectFrom('bank_accounts')
    .select('id')
    .where('id', '=', bankAccountId)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Flips a bank account's `feed_source` — to the connection's source on connect, back
 * to `file` on deactivate (D-126: "there is one live feed per bank account", and a
 * disconnect reverts the account to file import). `bank_accounts` is mutable
 * (`0999_app_grants`), so this UPDATE is granted, unlike a write to a journal.
 */
export async function setBankAccountFeedSource(
  db: TenantDatabase,
  bankAccountId: Buffer,
  feedSource: 'fake' | 'file' | 'stripe_financial_connections',
): Promise<void> {
  await db
    .updateTable('bank_accounts')
    .set({ feed_source: feedSource })
    .where('id', '=', bankAccountId)
    .execute();
}

export async function insertConnection(db: TenantDatabase, input: NewConnectionRow): Promise<void> {
  await db
    .insertInto('bank_feed_connections')
    .values({
      id: input.id,
      bank_account_id: input.bankAccountId,
      feed_source: input.feedSource,
      credential_source: input.credentialSource,
      secret_ref: input.secretRef,
      external_account_id: input.externalAccountId,
      institution: input.institution,
      // A fresh connection has synced nothing yet: no cursor to resume from, no last
      // run, no error. Nullable but not `Generated` (no schema `DEFAULT`), so Kysely's
      // insert type requires them named — the same reason `processor_connections`'
      // `last_polled_at`/`reconciled_through` are set to null here.
      sync_cursor: null,
      last_synced_at: null,
      last_sync_error: null,
      is_active: 1,
      created_by_user_id: input.createdByUserId,
    })
    .execute();
}

export async function selectConnectionById(
  db: TenantDatabase,
  id: Buffer,
): Promise<ConnectionRow | undefined> {
  return db
    .selectFrom('bank_feed_connections')
    .select(CONNECTION_COLUMNS)
    .where('id', '=', id)
    .executeTakeFirst();
}

/**
 * The same read, taking an exclusive row lock (`bank-accounts.repository.ts`'s
 * `selectBankAccountByIdForUpdate` shape). `feed-sync.service.ts` locks this row before
 * it advances the pull cursor because `bank_statement_lines` is append-only and cannot
 * itself be `SELECT … FOR UPDATE`'d (D-14): two concurrent syncs of one connection
 * serialize here, so the cursor advance is single-writer and a run never resumes from a
 * cursor a concurrent run has already moved past. `bank_feed_connections` is in
 * `0999_app_grants`'s mutable allowlist, which is what makes the locking read legal for
 * `openbooks_app` at all.
 */
export async function selectConnectionByIdForUpdate(
  db: TenantDatabase,
  id: Buffer,
): Promise<ConnectionRow | undefined> {
  return db
    .selectFrom('bank_feed_connections')
    .select(CONNECTION_COLUMNS)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
}

/**
 * Any existing connection for this bank account, active or not — the connect
 * pre-check for the one-feed-per-account rule (D-126). `uq_bank_feed_connections_org_bank_account`
 * makes this unconditional at the schema level; this turns a second `connectBankFeed`
 * for the same account into the readable `bank_feed_already_connected` precondition
 * rather than an opaque duplicate-key 500, the same pre-check/insert-catch pair
 * `connectProcessor` gives its own unique key.
 */
export async function selectConnectionByBankAccount(
  db: TenantDatabase,
  bankAccountId: Buffer,
): Promise<Pick<ConnectionRow, 'id'> | undefined> {
  return db
    .selectFrom('bank_feed_connections')
    .select('id')
    .where('bank_account_id', '=', bankAccountId)
    .executeTakeFirst();
}

/**
 * `(created_at, id)` — the default this API's lists use (D-21); `created_at` cannot
 * move, so a keyset over it never drops a row that shifted behind the cursor.
 */
const CONNECTION_KEYSET: KeysetOrdering<ConnectionRow> = [
  instantKey('bank_feed_connections.created_at', (row) => row.created_at),
  uuidKey('bank_feed_connections.id', (row) => row.id),
];

export interface ConnectionListFilters {
  readonly isActive?: boolean | undefined;
  readonly cursor?: string | undefined;
}

export async function listConnections(
  db: TenantDatabase,
  filters: ConnectionListFilters,
  limit: number,
): Promise<KeysetPage<ConnectionRow>> {
  let query = db.selectFrom('bank_feed_connections').select(CONNECTION_COLUMNS);

  if (filters.isActive !== undefined) {
    query = query.where('is_active', '=', filters.isActive ? 1 : 0);
  }

  const rows = await applyKeyset(query, CONNECTION_KEYSET, limit, filters.cursor).execute();
  return toKeysetPage(rows, CONNECTION_KEYSET, limit);
}

/** The columns the cross-org sweep needs — the org to enter and the connection to sync. */
const SYNC_SWEEP_COLUMNS = ['org_id', 'id'] as const;

export interface ActiveConnectionForSync {
  readonly org_id: Buffer;
  readonly id: Buffer;
}

/**
 * Every active connection, across every org — the D-129 daily sync's own worklist,
 * `selectAllActiveConnectionsAcrossOrgs` in `payments-processing/connections.repository.ts`
 * restated for this table: the sweep has no org yet, that is the question it is
 * answering, so it takes `Kysely<DB>` (the `systemDb()` handle) directly rather than
 * `tenantDb`. Nothing it returns is written back through this handle; `feed-sync.service.ts`
 * re-enters through `runAsAutomation` once each row's org is known.
 */
export async function selectAllActiveConnectionsAcrossOrgs(
  db: Kysely<DB>,
): Promise<readonly ActiveConnectionForSync[]> {
  return db
    .selectFrom('bank_feed_connections')
    .select(SYNC_SWEEP_COLUMNS)
    .where('is_active', '=', 1)
    .orderBy('org_id', 'asc')
    .orderBy('id', 'asc')
    .execute();
}

/**
 * Advances the pull cursor (D-128) and stamps a clean run: `last_synced_at` moves and
 * `last_sync_error` clears, so a previously-failed connection that succeeds no longer
 * reports the stale failure. The cursor is its own column, advanced only on a successful
 * sync — never a reused timestamp, the mistake `processor_connections`' poll made.
 */
export async function setConnectionCursor(
  db: TenantDatabase,
  id: Buffer,
  cursor: string,
  syncedAt: Date,
): Promise<void> {
  await db
    .updateTable('bank_feed_connections')
    .set({ sync_cursor: cursor, last_synced_at: syncedAt, last_sync_error: null })
    .where('id', '=', id)
    .execute();
}

/**
 * Records a sync failure without moving the cursor: the next run resumes from the same
 * point, so a provider outage costs a retry, not a gap. Advisory (`BankFeedConnection.lastSyncError`),
 * the way `poll.job.ts` logs a discrepancy rather than correcting it.
 */
export async function setConnectionSyncError(
  db: TenantDatabase,
  id: Buffer,
  error: string,
): Promise<void> {
  await db
    .updateTable('bank_feed_connections')
    .set({ last_sync_error: error })
    .where('id', '=', id)
    .execute();
}

export async function setConnectionActive(
  db: TenantDatabase,
  id: Buffer,
  isActive: boolean,
): Promise<void> {
  await db
    .updateTable('bank_feed_connections')
    .set({ is_active: isActive ? 1 : 0 })
    .where('id', '=', id)
    .execute();
}

/**
 * Never includes `secret_ref` or the value it names (D-83), and never `sync_cursor`,
 * which is the pull's internal resume point (D-128) and not something the management
 * screen has any use for.
 */
export function toBankFeedConnection(row: ConnectionRow): BankFeedConnection {
  return {
    id: bufferToUuid(row.id),
    bankAccountId: bufferToUuid(row.bank_account_id),
    feedSource: row.feed_source,
    credentialSource: row.credential_source,
    externalAccountId: row.external_account_id,
    institution: row.institution,
    isActive: row.is_active !== 0,
    lastSyncedAt: row.last_synced_at === null ? null : row.last_synced_at.toISOString(),
    lastSyncError: row.last_sync_error,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
