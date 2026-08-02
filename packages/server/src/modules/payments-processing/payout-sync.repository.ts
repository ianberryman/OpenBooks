import type { PayoutReportingCategory, PayoutSync } from '@openbooks/shared-types';

import type { TenantDatabase } from '../../db';
import { bufferToUuid, newUuidBuffer } from '../../db';

/**
 * Data access for `payout_syncs` (OB-237, D-237-2; migration `0024_payout_sync`) —
 * the staging row a payout becomes once the poll (`poll.job.ts`, D-85's cursor) or a
 * webhook observes it: the grossed-up breakdown a human reviews, or that auto-posts
 * (D-237-1), into a summary sales journal.
 *
 * Everything goes through `tenantDb`, so `org_id = ctx.orgId` is on every statement
 * before this file adds a predicate — `connections.repository.ts`'s header reasoning
 * applied to this table. `selectPayoutSyncByIdForUpdate` exists for the same reason
 * as that file's `selectConnectionByIdForUpdate`: the post step locks this row first
 * so two concurrent attempts to post the same payout serialize here rather than both
 * reaching `posting.service.ts` unguarded. `payout_syncs` is in `0999_app_grants`'s
 * mutable allowlist, which is what makes both the locking read and
 * `markPayoutSyncPosted`/`markPayoutSyncSkipped` legal for `openbooks_app` at all.
 */

export const PAYOUT_SYNC_RESOURCE = 'payout_sync';

const PAYOUT_SYNC_COLUMNS = [
  'id',
  'connection_id',
  'external_payout_id',
  'gross_minor',
  'fee_minor',
  'net_minor',
  'currency',
  'status',
  'breakdown',
  'journal_id',
  'skip_reason',
  'report_run_id',
  'occurred_at',
  'posted_by_user_id',
  'posted_at',
  'created_at',
  'updated_at',
] as const;

export interface PayoutSyncBreakdownLine {
  readonly reportingCategory: PayoutReportingCategory;
  readonly amountMinor: string;
  readonly count: number;
}

export interface PayoutSyncRow {
  readonly id: Buffer;
  readonly connection_id: Buffer;
  readonly external_payout_id: string;
  readonly gross_minor: bigint;
  readonly fee_minor: bigint;
  readonly net_minor: bigint;
  readonly currency: string;
  /**
   * `VARCHAR + CHECK`, not `ENUM` (the `customer_statements.status` precedent) —
   * `Generated<string>` on the generated row, not a literal union, so this is typed
   * `string` and narrowed to `PayoutSync['status']` in `toPayoutSync`.
   */
  readonly status: string;
  /** JSON, already parsed by mysql2 (`Json`'s select type) — narrowed in `toPayoutSync`. */
  readonly breakdown: unknown;
  readonly journal_id: Buffer | null;
  readonly skip_reason: string | null;
  /** The async Stripe report-run id for an `awaiting_report` manual payout (D-237-10); else null. */
  readonly report_run_id: string | null;
  readonly occurred_at: Date;
  readonly posted_by_user_id: Buffer | null;
  readonly posted_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface NewPayoutSync {
  readonly connectionId: Buffer;
  readonly externalPayoutId: string;
  readonly grossMinor: bigint;
  readonly feeMinor: bigint;
  readonly netMinor: bigint;
  readonly currency: string;
  readonly status: 'pending_review' | 'posted' | 'skipped' | 'awaiting_report';
  readonly breakdown: readonly PayoutSyncBreakdownLine[];
  readonly skipReason: string | null;
  /** The async Stripe report-run id for an `awaiting_report` manual payout (D-237-10); else null. */
  readonly reportRunId: string | null;
  readonly occurredAt: Date;
  readonly journalId: Buffer | null;
  readonly postedByUserId: Buffer | null;
  readonly postedAt: Date | null;
}

/**
 * Inserts a `payout_syncs` staging row and returns its new id.
 *
 * No `ON DUPLICATE` here: the caller (the poll/webhook path) is expected to have
 * already checked `selectPayoutSyncByExternal` under whatever lock it holds, the
 * same two-step `insertProcessorEventIfNew`'s sibling guard
 * (`posting.service.ts`'s external_refs check) takes at the object level. A
 * duplicate-key error surfacing here means that check was skipped or lost a race,
 * so it is left to propagate rather than swallowed into a silent no-op.
 */
export async function insertPayoutSync(db: TenantDatabase, input: NewPayoutSync): Promise<string> {
  const id = newUuidBuffer();

  await db
    .insertInto('payout_syncs')
    .values({
      id,
      connection_id: input.connectionId,
      external_payout_id: input.externalPayoutId,
      gross_minor: input.grossMinor,
      fee_minor: input.feeMinor,
      net_minor: input.netMinor,
      currency: input.currency,
      status: input.status,
      // Stringified here rather than by the caller — `automations/repository.ts`'s
      // `insertAutomation` reasoning for its own `Json` column: one place knows the
      // column is JSON-as-string, not every caller.
      breakdown: JSON.stringify(input.breakdown),
      journal_id: input.journalId,
      skip_reason: input.skipReason,
      report_run_id: input.reportRunId,
      occurred_at: input.occurredAt,
      posted_by_user_id: input.postedByUserId,
      posted_at: input.postedAt,
    })
    .execute();

  return bufferToUuid(id);
}

export async function selectPayoutSyncByExternal(
  db: TenantDatabase,
  connectionId: Buffer,
  externalPayoutId: string,
): Promise<PayoutSyncRow | undefined> {
  return db
    .selectFrom('payout_syncs')
    .select(PAYOUT_SYNC_COLUMNS)
    .where('connection_id', '=', connectionId)
    .where('external_payout_id', '=', externalPayoutId)
    .executeTakeFirst();
}

export async function selectPayoutSyncById(
  db: TenantDatabase,
  id: Buffer,
): Promise<PayoutSyncRow | undefined> {
  return db
    .selectFrom('payout_syncs')
    .select(PAYOUT_SYNC_COLUMNS)
    .where('id', '=', id)
    .executeTakeFirst();
}

/**
 * The same read, taking an exclusive row lock — the post step's serialization point
 * (`connections.repository.ts`'s `selectConnectionByIdForUpdate` reasoning, applied
 * here so two concurrent attempts to post the same payout do not both proceed).
 */
export async function selectPayoutSyncByIdForUpdate(
  db: TenantDatabase,
  id: Buffer,
): Promise<PayoutSyncRow | undefined> {
  return db
    .selectFrom('payout_syncs')
    .select(PAYOUT_SYNC_COLUMNS)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
}

/** The review list, newest occurrence first; `status` narrows it to one tab. */
export async function selectPayoutSyncsForConnection(
  db: TenantDatabase,
  connectionId: Buffer,
  status?: 'pending_review' | 'posted' | 'skipped' | 'awaiting_report',
): Promise<readonly PayoutSyncRow[]> {
  let query = db
    .selectFrom('payout_syncs')
    .select(PAYOUT_SYNC_COLUMNS)
    .where('connection_id', '=', connectionId);

  if (status !== undefined) {
    query = query.where('status', '=', status);
  }

  return query.orderBy('occurred_at', 'desc').orderBy('id', 'asc').execute();
}

export async function markPayoutSyncPosted(
  db: TenantDatabase,
  id: Buffer,
  journalId: Buffer,
  postedByUserId: Buffer,
  postedAt: Date,
): Promise<void> {
  await db
    .updateTable('payout_syncs')
    .set({
      status: 'posted',
      journal_id: journalId,
      posted_by_user_id: postedByUserId,
      posted_at: postedAt,
    })
    .where('id', '=', id)
    .execute();
}

export async function markPayoutSyncSkipped(
  db: TenantDatabase,
  id: Buffer,
  reason: string,
): Promise<void> {
  await db
    .updateTable('payout_syncs')
    .set({ status: 'skipped', skip_reason: reason })
    .where('id', '=', id)
    .execute();
}

/**
 * The `awaiting_report` manual payouts for a connection whose async report the
 * finalize sweep polls (OB-237b, D-237-10). A plain read: each row is then
 * re-selected `FOR UPDATE` in its own transaction before finalizing, so the
 * network poll never holds a row lock (`finalizePayoutReports`'s reasoning).
 */
export async function selectAwaitingReportSyncsForConnection(
  db: TenantDatabase,
  connectionId: Buffer,
): Promise<readonly PayoutSyncRow[]> {
  return db
    .selectFrom('payout_syncs')
    .select(PAYOUT_SYNC_COLUMNS)
    .where('connection_id', '=', connectionId)
    .where('status', '=', 'awaiting_report')
    .orderBy('occurred_at', 'asc')
    .orderBy('id', 'asc')
    .execute();
}

/**
 * Finalizes an `awaiting_report` row once its async report has resolved (D-237-10):
 * fills the now-known gross/fee/net and per-category breakdown, and moves it to
 * `posted` (auto-post — `journalId`/`postedAt` set) or `pending_review` (a human
 * reviews the real numbers — both null). `posted_by_user_id` stays null: an
 * auto-post is the automation actor, not a user (D-237-2). The `report_run_id` is
 * kept for audit.
 */
export async function markPayoutSyncReportReady(
  db: TenantDatabase,
  id: Buffer,
  input: {
    readonly status: 'pending_review' | 'posted';
    readonly grossMinor: bigint;
    readonly feeMinor: bigint;
    readonly netMinor: bigint;
    readonly breakdown: readonly PayoutSyncBreakdownLine[];
    readonly journalId: Buffer | null;
    readonly postedAt: Date | null;
  },
): Promise<void> {
  await db
    .updateTable('payout_syncs')
    .set({
      status: input.status,
      gross_minor: input.grossMinor,
      fee_minor: input.feeMinor,
      net_minor: input.netMinor,
      breakdown: JSON.stringify(input.breakdown),
      journal_id: input.journalId,
      posted_at: input.postedAt,
    })
    .where('id', '=', id)
    .execute();
}

/**
 * `breakdown` is `JSON NOT NULL`, written by `insertPayoutSync` above and nowhere
 * else, so a value that is not the shape below here is this process's own write
 * having gone wrong rather than anything a caller sent — mysql2 has already parsed
 * the column by the time Kysely hands it back, `oauth.repository.ts`'s
 * `toRedirectUris` reasoning for its own `Json` column.
 */
function toBreakdown(value: unknown): readonly PayoutSyncBreakdownLine[] {
  if (
    Array.isArray(value) &&
    value.every(
      (item): item is PayoutSyncBreakdownLine =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as { reportingCategory?: unknown }).reportingCategory === 'string' &&
        typeof (item as { amountMinor?: unknown }).amountMinor === 'string' &&
        typeof (item as { count?: unknown }).count === 'number',
    )
  ) {
    return value;
  }
  throw new TypeError('payout_syncs.breakdown did not hold the expected category-line shape.');
}

export function toPayoutSync(row: PayoutSyncRow): PayoutSync {
  return {
    id: bufferToUuid(row.id),
    connectionId: bufferToUuid(row.connection_id),
    externalPayoutId: row.external_payout_id,
    grossMinor: row.gross_minor.toString(),
    feeMinor: row.fee_minor.toString(),
    netMinor: row.net_minor.toString(),
    currency: row.currency,
    status: row.status as PayoutSync['status'],
    breakdown: toBreakdown(row.breakdown).map((line) => ({ ...line })),
    journalId: row.journal_id === null ? null : bufferToUuid(row.journal_id),
    skipReason: row.skip_reason,
    reportRunId: row.report_run_id,
    occurredAt: row.occurred_at.toISOString(),
    postedAt: row.posted_at === null ? null : row.posted_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}
