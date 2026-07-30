import type { FixedAssetMethod, FixedAssetStatus } from '@openbooks/shared-types';
import type { Kysely } from 'kysely';

import type { RequestContext } from '../../context';
import type { DB, KeysetOrdering, KeysetPage, TenantDatabase } from '../../db';
import {
  applyKeyset,
  instantKey,
  newUuidBuffer,
  orgScope as toOrgId,
  tenantDb,
  toKeysetPage,
  tryUuidToBuffer,
  uuidKey,
} from '../../db';

import type { DepreciationScheduleRow } from './depreciation';

/**
 * Data access for `fixed_assets` and `fixed_asset_schedule` (OB-163, OB-164, OB-165).
 *
 * `recurring.repository.ts` is the template this mirrors: every statement goes
 * through `tenantDb`, so a cross-org id matches nothing and the service's
 * `assertFound` turns that into A7's one sanctioned miss — except
 * `selectDueScheduleRows`, which takes `Kysely<DB>` (the `systemDb()` handle) for
 * the same reason `selectDueTemplates` does: the daily sweep has no org yet, and
 * finding which org each due period belongs to is the question it answers. Nothing
 * it returns is written back through that handle; the per-period post that follows
 * re-enters through `orgScope` once the org is known (`depreciation-sweep.ts`).
 */

export const FIXED_ASSET_RESOURCE = 'fixed_asset';

const FIXED_ASSET_COLUMNS = [
  'id',
  'name',
  'description',
  'asset_account_id',
  'accumulated_depreciation_account_id',
  'depreciation_expense_account_id',
  'acquisition_cost_minor',
  'salvage_value_minor',
  'method',
  'useful_life_months',
  'declining_rate_ppm',
  'in_service_date',
  'status',
  'disposed_date',
  'disposal_journal_id',
  'created_at',
  'updated_at',
] as const;

export interface FixedAssetRow {
  readonly id: Buffer;
  readonly name: string;
  readonly description: string | null;
  readonly asset_account_id: Buffer;
  readonly accumulated_depreciation_account_id: Buffer;
  readonly depreciation_expense_account_id: Buffer;
  readonly acquisition_cost_minor: bigint;
  readonly salvage_value_minor: bigint;
  // Read back as `string` rather than the narrower `FixedAssetMethod`/`FixedAssetStatus`
  // literal unions — `recurring.service.ts`'s own commentary on
  // `recurring_invoice_templates.materialization_mode`: whether kysely-codegen
  // widens an ENUM column to a literal type or not is a fact about the generator
  // pass, not something this repository controls, so the service casts at the
  // one seam that needs the narrower type (`toFixedAsset` in `fixed-assets.service.ts`).
  // The CHECK constraints these columns carry are the actual guarantee either way.
  readonly method: string;
  readonly useful_life_months: number;
  readonly declining_rate_ppm: number | null;
  readonly in_service_date: string;
  readonly status: string;
  readonly disposed_date: string | null;
  readonly disposal_journal_id: Buffer | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface NewFixedAssetRow {
  readonly name: string;
  readonly description: string | null;
  readonly assetAccountId: Buffer;
  readonly accumulatedDepreciationAccountId: Buffer;
  readonly depreciationExpenseAccountId: Buffer;
  readonly acquisitionCostMinor: bigint;
  readonly salvageValueMinor: bigint;
  readonly method: FixedAssetMethod;
  readonly usefulLifeMonths: number;
  readonly decliningRatePpm: number | null;
  readonly inServiceDate: string;
  readonly createdByUserId: Buffer;
}

/**
 * Everything but the disposal fields and `status` is patchable — those two are
 * `updateFixedAsset`'s own dedicated write, from `disposeFixedAsset`
 * (`fixed-assets.service.ts`), never from an ordinary edit.
 */
export interface FixedAssetPatch {
  readonly name?: string;
  readonly description?: string | null;
  readonly assetAccountId?: Buffer;
  readonly accumulatedDepreciationAccountId?: Buffer;
  readonly depreciationExpenseAccountId?: Buffer;
  readonly acquisitionCostMinor?: bigint;
  readonly salvageValueMinor?: bigint;
  readonly method?: FixedAssetMethod;
  readonly usefulLifeMonths?: number;
  readonly decliningRatePpm?: number | null;
  readonly inServiceDate?: string;
  readonly status?: FixedAssetStatus;
  readonly disposedDate?: string | null;
  readonly disposalJournalId?: Buffer | null;
}

export interface FixedAssetScheduleRowRecord {
  readonly id: Buffer;
  readonly periodIndex: number;
  readonly periodDate: string;
  readonly depreciationAmountMinor: bigint;
  readonly postedJournalId: Buffer | null;
}

/**
 * A due period, carrying everything the sweep needs to post it without a second
 * round trip: which org it belongs to, and the asset's two depreciation accounts —
 * `DueRecurringTemplateRow`'s own shape, extended with the join `fixed_assets`
 * supplies that a template's due row never needed.
 */
export interface DueScheduleRow {
  readonly id: Buffer;
  readonly orgId: Buffer;
  readonly fixedAssetId: Buffer;
  readonly periodDate: string;
  readonly depreciationAmountMinor: bigint;
  readonly depreciationExpenseAccountId: Buffer;
  readonly accumulatedDepreciationAccountId: Buffer;
}

export function orgScope(ctx: RequestContext): TenantDatabase {
  return tenantDb(toOrgId(ctx.orgId));
}

/**
 * A client-supplied fixed-asset id as bytes, or `undefined` when it is not a
 * UUID — routed through `assertFound` to the same 404 a nonexistent one produces
 * (A7), `accountIdBytes`'s own shape.
 */
export function assetIdBytes(fixedAssetId: string): Buffer | undefined {
  return tryUuidToBuffer(fixedAssetId);
}

export async function insertFixedAsset(
  db: TenantDatabase,
  input: NewFixedAssetRow,
): Promise<Buffer> {
  const id = newUuidBuffer();

  await db
    .insertInto('fixed_assets')
    .values({
      id,
      name: input.name,
      description: input.description,
      asset_account_id: input.assetAccountId,
      accumulated_depreciation_account_id: input.accumulatedDepreciationAccountId,
      depreciation_expense_account_id: input.depreciationExpenseAccountId,
      acquisition_cost_minor: input.acquisitionCostMinor,
      salvage_value_minor: input.salvageValueMinor,
      method: input.method,
      useful_life_months: input.usefulLifeMonths,
      declining_rate_ppm: input.decliningRatePpm,
      in_service_date: input.inServiceDate,
      status: 'active',
      disposed_date: null,
      disposal_journal_id: null,
      created_by_user_id: input.createdByUserId,
    })
    .execute();

  return id;
}

export async function selectFixedAssetById(
  db: TenantDatabase,
  id: Buffer,
): Promise<FixedAssetRow | undefined> {
  return db
    .selectFrom('fixed_assets')
    .select(FIXED_ASSET_COLUMNS)
    .where('id', '=', id)
    .executeTakeFirst();
}

/**
 * The same read, taking an exclusive row lock — the guard `disposeFixedAsset` and
 * `updateFixedAsset` both take before touching an asset a concurrent write might
 * also be reaching for. `fixed_assets` is in `0999_app_grants`'s mutable
 * allowlist, so the app user may take a locking read on it.
 */
export async function selectFixedAssetByIdForUpdate(
  db: TenantDatabase,
  id: Buffer,
): Promise<FixedAssetRow | undefined> {
  return db
    .selectFrom('fixed_assets')
    .select(FIXED_ASSET_COLUMNS)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
}

/** `(created_at, id)` — `contacts.repository.ts`'s reasoning applied to a fixed asset. */
const FIXED_ASSET_KEYSET: KeysetOrdering<FixedAssetRow> = [
  instantKey('fixed_assets.created_at', (row) => row.created_at),
  uuidKey('fixed_assets.id', (row) => row.id),
];

export interface FixedAssetFilters {
  readonly status?: FixedAssetStatus;
  readonly cursor?: string;
}

export async function selectFixedAssetsPage(
  db: TenantDatabase,
  filters: FixedAssetFilters,
  limit: number,
): Promise<KeysetPage<FixedAssetRow>> {
  let query = db.selectFrom('fixed_assets').select(FIXED_ASSET_COLUMNS);

  if (filters.status !== undefined) {
    query = query.where('status', '=', filters.status);
  }

  const rows = await applyKeyset(query, FIXED_ASSET_KEYSET, limit, filters.cursor).execute();
  return toKeysetPage(rows, FIXED_ASSET_KEYSET, limit);
}

export async function updateFixedAssetRow(
  db: TenantDatabase,
  id: Buffer,
  patch: FixedAssetPatch,
): Promise<void> {
  await db
    .updateTable('fixed_assets')
    .set({
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.description === undefined ? {} : { description: patch.description }),
      ...(patch.assetAccountId === undefined ? {} : { asset_account_id: patch.assetAccountId }),
      ...(patch.accumulatedDepreciationAccountId === undefined
        ? {}
        : { accumulated_depreciation_account_id: patch.accumulatedDepreciationAccountId }),
      ...(patch.depreciationExpenseAccountId === undefined
        ? {}
        : { depreciation_expense_account_id: patch.depreciationExpenseAccountId }),
      ...(patch.acquisitionCostMinor === undefined
        ? {}
        : { acquisition_cost_minor: patch.acquisitionCostMinor }),
      ...(patch.salvageValueMinor === undefined
        ? {}
        : { salvage_value_minor: patch.salvageValueMinor }),
      ...(patch.method === undefined ? {} : { method: patch.method }),
      ...(patch.usefulLifeMonths === undefined
        ? {}
        : { useful_life_months: patch.usefulLifeMonths }),
      ...(patch.decliningRatePpm === undefined
        ? {}
        : { declining_rate_ppm: patch.decliningRatePpm }),
      ...(patch.inServiceDate === undefined ? {} : { in_service_date: patch.inServiceDate }),
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.disposedDate === undefined ? {} : { disposed_date: patch.disposedDate }),
      ...(patch.disposalJournalId === undefined
        ? {}
        : { disposal_journal_id: patch.disposalJournalId }),
    })
    .where('id', '=', id)
    .execute();

  /**
   * The affected-row count is deliberately not consulted, `updateAccountRow`'s
   * reason: mysql2 does not set `CLIENT_FOUND_ROWS`, so a no-op update and a miss
   * report the same zero. Existence is established by the caller's own read.
   */
}

// ---------------------------------------------------------------------------
// fixed_asset_schedule
// ---------------------------------------------------------------------------

const SCHEDULE_COLUMNS = [
  'id',
  'period_index',
  'period_date',
  'depreciation_amount_minor',
  'posted_journal_id',
] as const;

function toScheduleRowRecord(row: {
  readonly id: Buffer;
  readonly period_index: number;
  readonly period_date: string;
  readonly depreciation_amount_minor: bigint;
  readonly posted_journal_id: Buffer | null;
}): FixedAssetScheduleRowRecord {
  return {
    id: row.id,
    periodIndex: row.period_index,
    periodDate: row.period_date,
    depreciationAmountMinor: row.depreciation_amount_minor,
    postedJournalId: row.posted_journal_id,
  };
}

/**
 * The whole schedule computed at registration (or recomputed at an edit —
 * `replaceSchedule` below), ordered by `periodIndex` so a client reads it the way
 * it depreciates.
 */
export async function insertScheduleRows(
  db: TenantDatabase,
  fixedAssetId: Buffer,
  rows: readonly DepreciationScheduleRow[],
): Promise<void> {
  if (rows.length === 0) return;

  await db
    .insertInto('fixed_asset_schedule')
    .values(
      rows.map((row) => ({
        id: newUuidBuffer(),
        fixed_asset_id: fixedAssetId,
        period_index: row.periodIndex,
        period_date: row.periodDate,
        depreciation_amount_minor: row.depreciationAmountMinor,
        posted_journal_id: null,
      })),
    )
    .execute();
}

/**
 * Recomputes a schedule wholesale — `replaceRecurringTemplateLines`'s own shape,
 * a whole-set replace rather than a diff. Callable only while the asset has no
 * posted period: `fixed-assets.service.ts`'s `updateFixedAsset` checks
 * `hasPostedScheduleRows` first and refuses the edit otherwise, so by the time
 * this runs every row for the asset is known to be unposted and deleting all of
 * them (rather than only the unposted ones) is safe.
 */
export async function replaceSchedule(
  db: TenantDatabase,
  fixedAssetId: Buffer,
  rows: readonly DepreciationScheduleRow[],
): Promise<void> {
  await db.deleteFrom('fixed_asset_schedule').where('fixed_asset_id', '=', fixedAssetId).execute();
  await insertScheduleRows(db, fixedAssetId, rows);
}

export async function selectFixedAssetSchedule(
  db: TenantDatabase,
  fixedAssetId: Buffer,
): Promise<readonly FixedAssetScheduleRowRecord[]> {
  const rows = await db
    .selectFrom('fixed_asset_schedule')
    .select(SCHEDULE_COLUMNS)
    .where('fixed_asset_id', '=', fixedAssetId)
    .orderBy('period_index', 'asc')
    .execute();

  return rows.map(toScheduleRowRecord);
}

/**
 * Every period due by `runDate`, across every org — `selectDueTemplates`'s own
 * cross-org shape, reading `idx_fixed_asset_schedule_due (org_id,
 * posted_journal_id, period_date)` joined to the asset it belongs to for the
 * org, the two depreciation accounts, and the `status = 'active'` guard (a
 * disposed asset's remaining rows are deleted at disposal, but the guard costs
 * nothing and does not depend on that cleanup having run first).
 *
 * Nothing here writes. The per-period post that follows re-enters through
 * `orgScope` once the org is known (`depreciation-sweep.ts`).
 */
export async function selectDueScheduleRows(
  db: Kysely<DB>,
  runDate: string,
): Promise<readonly DueScheduleRow[]> {
  const rows = await db
    .selectFrom('fixed_asset_schedule')
    .innerJoin('fixed_assets', (join) =>
      join
        .onRef('fixed_assets.org_id', '=', 'fixed_asset_schedule.org_id')
        .onRef('fixed_assets.id', '=', 'fixed_asset_schedule.fixed_asset_id'),
    )
    .select([
      'fixed_asset_schedule.id as id',
      'fixed_asset_schedule.org_id as org_id',
      'fixed_asset_schedule.fixed_asset_id as fixed_asset_id',
      'fixed_asset_schedule.period_date as period_date',
      'fixed_asset_schedule.depreciation_amount_minor as depreciation_amount_minor',
      'fixed_assets.depreciation_expense_account_id as depreciation_expense_account_id',
      'fixed_assets.accumulated_depreciation_account_id as accumulated_depreciation_account_id',
    ])
    .where('fixed_asset_schedule.posted_journal_id', 'is', null)
    .where('fixed_asset_schedule.period_date', '<=', runDate)
    .where('fixed_assets.status', '=', 'active')
    .execute();

  return rows.map((row) => ({
    id: row.id,
    orgId: row.org_id,
    fixedAssetId: row.fixed_asset_id,
    periodDate: row.period_date,
    depreciationAmountMinor: row.depreciation_amount_minor,
    depreciationExpenseAccountId: row.depreciation_expense_account_id,
    accumulatedDepreciationAccountId: row.accumulated_depreciation_account_id,
  }));
}

/**
 * The row lock the sweep's per-period post takes before checking
 * `posted_journal_id` — D-113's once-per-period guard, `selectRecurringTemplateByIdForUpdate`'s
 * own reason: the row must be reloaded under `FOR UPDATE` inside the org's own
 * transaction, not trusted from the cross-org snapshot the sweep read it from.
 */
export async function selectScheduleRowByIdForUpdate(
  db: TenantDatabase,
  scheduleRowId: Buffer,
): Promise<FixedAssetScheduleRowRecord | undefined> {
  const row = await db
    .selectFrom('fixed_asset_schedule')
    .select(SCHEDULE_COLUMNS)
    .where('id', '=', scheduleRowId)
    .forUpdate()
    .executeTakeFirst();

  return row === undefined ? undefined : toScheduleRowRecord(row);
}

export async function markScheduleRowPosted(
  db: TenantDatabase,
  scheduleRowId: Buffer,
  journalId: Buffer,
): Promise<void> {
  await db
    .updateTable('fixed_asset_schedule')
    .set({ posted_journal_id: journalId })
    .where('id', '=', scheduleRowId)
    .execute();
}

/**
 * Discards every not-yet-posted row — `disposeFixedAsset`'s cleanup (D-116) and
 * an edit that recomputes the schedule before replacing it wholesale (though
 * `replaceSchedule` above deletes every row rather than calling this, since by
 * the time it runs the caller has already established none are posted).
 * `DELETE` rather than a status flip, because a schedule row that never posted
 * carries no financial fact for a flag to preserve.
 */
export async function deleteUnpostedScheduleRows(
  db: TenantDatabase,
  fixedAssetId: Buffer,
): Promise<void> {
  await db
    .deleteFrom('fixed_asset_schedule')
    .where('fixed_asset_id', '=', fixedAssetId)
    .where('posted_journal_id', 'is', null)
    .execute();
}

/**
 * Σ `depreciation_amount_minor` over every posted period — the accumulated
 * depreciation `disposeFixedAsset` nets against `acquisition_cost_minor` to get
 * the book value a disposal's gain or loss is measured from. Computed on read
 * rather than cached anywhere, `0005_subledger`'s D-34 argument applied to a
 * forecast instead of a document: the only durable record of "this period
 * posted" is the journal `posted_journal_id` points at.
 */
export async function sumPostedDepreciation(
  db: TenantDatabase,
  fixedAssetId: Buffer,
): Promise<bigint> {
  const row = await db
    .selectFrom('fixed_asset_schedule')
    .where('fixed_asset_id', '=', fixedAssetId)
    .where('posted_journal_id', 'is not', null)
    .select((eb) =>
      eb.fn.coalesce(eb.fn.sum<bigint>('depreciation_amount_minor'), eb.lit(0)).as('total'),
    )
    .executeTakeFirst();

  return BigInt(row?.total ?? 0);
}

/**
 * Whether any period of this asset has posted — `updateFixedAsset`'s no-mid-life-
 * re-forecast gate (ROADMAP "no mid-life re-forecast in v1"). A plain existence
 * check rather than reusing `sumPostedDepreciation`'s `> 0` (a posted period can
 * legitimately be zero minor units — a base far smaller than its own life floors
 * to zero for most periods, `depreciation.ts`'s own commentary), so the sum is
 * the wrong thing to test for "has anything posted".
 */
export async function hasPostedScheduleRows(
  db: TenantDatabase,
  fixedAssetId: Buffer,
): Promise<boolean> {
  const row = await db
    .selectFrom('fixed_asset_schedule')
    .select('id')
    .where('fixed_asset_id', '=', fixedAssetId)
    .where('posted_journal_id', 'is not', null)
    .executeTakeFirst();

  return row !== undefined;
}
