import type { InventoryMovementType } from '@openbooks/shared-types';
import { sql } from 'kysely';

import type { RequestContext } from '../../context';
import type { TenantDatabase } from '../../db';
import { newUuidBuffer, orgScope as toOrgId, tenantDb } from '../../db';
import { InternalError } from '../../errors';

import type { OnHand } from './costing';

/**
 * Data access for `inventory_movements`, `inventory_adjustments`, the costing
 * fields on `catalog_items`, and `org_accounting_settings.inventory_shrinkage_account_id`
 * (OB-224). `fixed-assets.repository.ts` is the template this mirrors: every
 * statement goes through `tenantDb`, so a cross-org id matches nothing and the
 * service's `assertFound` turns that into A7's one sanctioned miss.
 *
 * `inventory_movements` is append-only (`0999_app_grants`'s `APPEND_ONLY_TABLES`) —
 * there is no update or delete function here, on purpose, matching there being none
 * for `journal_lines`. A correction is a compensating `reversal` movement, never an
 * edit to one already written.
 */

export const CATALOG_ITEM_RESOURCE = 'catalog_item';

export function orgScope(ctx: RequestContext): TenantDatabase {
  return tenantDb(toOrgId(ctx.orgId));
}

/**
 * `SUM` over a `BIGINT` column, which MySQL widens to `DECIMAL` and mysql2 returns
 * as a string — `payments.repository.ts`'s own `sumOf`, restated here rather than
 * imported across the module boundary (`depreciation.ts`'s reason for restating
 * `addMonths`: importing it would assert a dependency between two modules that do
 * not otherwise know about each other).
 */
function sumOf(column: string) {
  return sql<string>`COALESCE(SUM(${sql.ref(column)}), 0)`;
}

function toBigInt(value: string | number | bigint): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}

// ---------------------------------------------------------------------------
// inventory_movements
// ---------------------------------------------------------------------------

export interface NewMovementInput {
  readonly catalogItemId: Buffer;
  readonly movementType: InventoryMovementType;
  readonly qtyDeltaMicros: bigint;
  readonly valueDeltaMinor: bigint;
  readonly journalId: Buffer;
  readonly sourceDocType: string | null;
  readonly sourceDocId: Buffer | null;
  readonly movementDate: string;
}

export async function insertMovement(db: TenantDatabase, input: NewMovementInput): Promise<Buffer> {
  const id = newUuidBuffer();

  await db
    .insertInto('inventory_movements')
    .values({
      id,
      catalog_item_id: input.catalogItemId,
      movement_type: input.movementType,
      qty_delta_micros: input.qtyDeltaMicros,
      value_delta_minor: input.valueDeltaMinor,
      journal_id: input.journalId,
      source_doc_type: input.sourceDocType,
      source_doc_id: input.sourceDocId,
      movement_date: input.movementDate,
    })
    .execute();

  return id;
}

/**
 * On-hand qty and value for every item that has ever moved, as a fold over
 * `inventory_movements` — `SUM(qty_delta_micros)`, `SUM(value_delta_minor)`
 * grouped by item. `asOf` bounds the fold at `movement_date <= asOf` for a
 * point-in-time valuation (`getInventoryValuation`); omitted, the fold is over
 * every movement ever recorded, which is what a poster needs before appending the
 * next one.
 *
 * An item absent from the returned map has never moved — zero qty, zero value —
 * and every caller treats a missing key that way rather than this function
 * synthesizing a zero row for it.
 */
export async function selectOnHandFold(
  db: TenantDatabase,
  filters: { readonly asOf?: string } = {},
): Promise<ReadonlyMap<string, OnHand>> {
  let query = db
    .selectFrom('inventory_movements')
    .select([
      'catalog_item_id',
      sumOf('qty_delta_micros').as('qty_total'),
      sumOf('value_delta_minor').as('value_total'),
    ])
    .groupBy('catalog_item_id');

  if (filters.asOf !== undefined) {
    query = query.where('movement_date', '<=', filters.asOf);
  }

  const rows = await query.execute();

  return new Map(
    rows.map((row) => [
      row.catalog_item_id.toString('hex'),
      { qtyMicros: toBigInt(row.qty_total), valueMinor: toBigInt(row.value_total) },
    ]),
  );
}

export interface MovementRow {
  readonly id: Buffer;
  readonly catalogItemId: Buffer;
  readonly movementType: string;
  readonly qtyDeltaMicros: bigint;
  readonly valueDeltaMinor: bigint;
  readonly journalId: Buffer;
  readonly sourceDocType: string | null;
}

/**
 * Every movement tied to one source document — the void-ripple read
 * (`reverseInventoryMovements`). Not scoped by `movement_type`: a document's
 * movements are whatever it posted (a bill's `receipt`s, an invoice's `sale`s),
 * and the caller reverses all of them, whichever type they are.
 */
export async function selectMovementsForSourceDoc(
  db: TenantDatabase,
  sourceDocId: Buffer,
): Promise<readonly MovementRow[]> {
  const rows = await db
    .selectFrom('inventory_movements')
    .select([
      'id',
      'catalog_item_id',
      'movement_type',
      'qty_delta_micros',
      'value_delta_minor',
      'journal_id',
      'source_doc_type',
    ])
    .where('source_doc_id', '=', sourceDocId)
    .execute();

  return rows.map((row) => ({
    id: row.id,
    catalogItemId: row.catalog_item_id,
    movementType: row.movement_type,
    qtyDeltaMicros: row.qty_delta_micros,
    valueDeltaMinor: row.value_delta_minor,
    journalId: row.journal_id,
    sourceDocType: row.source_doc_type,
  }));
}

// ---------------------------------------------------------------------------
// inventory_adjustments
// ---------------------------------------------------------------------------

export interface NewAdjustmentHeaderInput {
  readonly adjustmentDate: string;
  readonly memo: string | null;
  readonly createdByUserId: Buffer;
}

export async function insertAdjustmentHeader(
  db: TenantDatabase,
  input: NewAdjustmentHeaderInput,
): Promise<Buffer> {
  const id = newUuidBuffer();

  await db
    .insertInto('inventory_adjustments')
    .values({
      id,
      adjustment_date: input.adjustmentDate,
      memo: input.memo,
      journal_id: null,
      reversed_by_journal_id: null,
      created_by_user_id: input.createdByUserId,
    })
    .execute();

  return id;
}

/**
 * Stamps the journal an adjustment posted — `markScheduleRowPosted`'s own shape.
 * `inventory_adjustments` is in `0999_app_grants`'s mutable allowlist, so the app
 * user holds the `UPDATE` this needs.
 */
export async function stampAdjustmentJournal(
  db: TenantDatabase,
  adjustmentId: Buffer,
  journalId: Buffer,
): Promise<void> {
  await db
    .updateTable('inventory_adjustments')
    .set({ journal_id: journalId })
    .where('id', '=', adjustmentId)
    .execute();
}

export interface AdjustmentHeaderRow {
  readonly id: Buffer;
  readonly adjustmentDate: string;
  readonly memo: string | null;
  readonly journalId: Buffer | null;
  readonly reversedByJournalId: Buffer | null;
  readonly createdAt: Date;
}

/** Read back after `stampAdjustmentJournal`, for the response's `createdAt` and `journalId`. */
export async function selectAdjustmentHeaderById(
  db: TenantDatabase,
  id: Buffer,
): Promise<AdjustmentHeaderRow | undefined> {
  const row = await db
    .selectFrom('inventory_adjustments')
    .select(['id', 'adjustment_date', 'memo', 'journal_id', 'reversed_by_journal_id', 'created_at'])
    .where('id', '=', id)
    .executeTakeFirst();

  if (row === undefined) return undefined;

  return {
    id: row.id,
    adjustmentDate: row.adjustment_date,
    memo: row.memo,
    journalId: row.journal_id,
    reversedByJournalId: row.reversed_by_journal_id,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// catalog_items — the costing fields
// ---------------------------------------------------------------------------

export interface InventoryItemRow {
  readonly id: Buffer;
  readonly name: string;
  readonly code: string | null;
  readonly inventoryAssetAccountId: Buffer;
  readonly cogsAccountId: Buffer;
  readonly defaultCostMinor: bigint | null;
  readonly reorderPointMicros: bigint | null;
}

const INVENTORY_ITEM_COLUMNS = [
  'id',
  'name',
  'code',
  'inventory_asset_account_id',
  'cogs_account_id',
  'default_cost_minor',
  'reorder_point_micros',
] as const;

/**
 * `item_type = 'inventory'` rows carry `inventory_asset_account_id` and
 * `cogs_account_id` `NOT NULL` by the app-level invariant `catalog.service.ts`
 * enforces at write time (`0025_inventory`'s own commentary on why that cannot be
 * a CHECK). A `null` here despite the `item_type` filter every caller applies is a
 * fault in that invariant, not a shape this module can carry forward silently —
 * `InternalError` rather than a narrowing cast, `ar-documents.service.ts`'s own
 * "the pricing returned fewer lines than it was given" reasoning.
 */
function toInventoryItemRow(row: {
  readonly id: Buffer;
  readonly name: string;
  readonly code: string | null;
  readonly inventory_asset_account_id: Buffer | null;
  readonly cogs_account_id: Buffer | null;
  readonly default_cost_minor: bigint | null;
  readonly reorder_point_micros: bigint | null;
}): InventoryItemRow {
  if (row.inventory_asset_account_id === null || row.cogs_account_id === null) {
    throw new InternalError(
      `Inventory item ${row.id.toString('hex')} is missing its inventory-asset or COGS account.`,
    );
  }

  return {
    id: row.id,
    name: row.name,
    code: row.code,
    inventoryAssetAccountId: row.inventory_asset_account_id,
    cogsAccountId: row.cogs_account_id,
    defaultCostMinor: row.default_cost_minor,
    reorderPointMicros: row.reorder_point_micros,
  };
}

/** The named items, filtered to `item_type = 'inventory'` — a non-inventory id costs nothing. */
export async function loadInventoryItems(
  db: TenantDatabase,
  ids: readonly Buffer[],
): Promise<readonly InventoryItemRow[]> {
  if (ids.length === 0) return [];

  const rows = await db
    .selectFrom('catalog_items')
    .select(INVENTORY_ITEM_COLUMNS)
    .where('id', 'in', ids)
    .where('item_type', '=', 'inventory')
    .execute();

  return rows.map(toInventoryItemRow);
}

/**
 * Every active tracked item — the valuation report and the reorder-alert scan.
 * `is_active` is filtered here and nowhere else in this file: a posting keeps
 * costing a line against whatever item it already names (`catalog.ts`'s D-CAT-2,
 * provenance is never destructively re-validated), but a listing has no line to
 * be provenance for and simply should not show a retired item.
 */
export async function loadAllInventoryItems(
  db: TenantDatabase,
): Promise<readonly InventoryItemRow[]> {
  const rows = await db
    .selectFrom('catalog_items')
    .select(INVENTORY_ITEM_COLUMNS)
    .where('item_type', '=', 'inventory')
    .where('is_active', '=', 1)
    .execute();

  return rows.map(toInventoryItemRow);
}

// ---------------------------------------------------------------------------
// org_accounting_settings — the shrinkage account
// ---------------------------------------------------------------------------

/**
 * The org's nominated shrinkage account, or `null` when none has been set —
 * `resolveControlAccount`'s own read, restated here rather than imported from
 * `modules/settings/` because that module's control/discount/depreciation
 * resolvers are each hand-written for their own two-sided setting and gain
 * nothing from a third caller reaching in; the resolve-and-error wrapper lives in
 * `inventory.service.ts`, `resolveDepreciationAccount`'s own split between a
 * plain repository read and the service-level refusal.
 */
export async function selectInventoryShrinkageAccountId(
  db: TenantDatabase,
): Promise<Buffer | null> {
  const row = await db
    .selectFrom('org_accounting_settings')
    .select('inventory_shrinkage_account_id')
    .executeTakeFirst();

  return row?.inventory_shrinkage_account_id ?? null;
}
