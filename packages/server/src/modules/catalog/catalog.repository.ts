import type {
  CatalogItem,
  CatalogItemDirection,
  ListCatalogItemsQuery,
} from '@openbooks/shared-types';

import type { RequestContext } from '../../context';
import type { KeysetOrdering, KeysetPage, TenantDatabase } from '../../db';
import {
  applyKeyset,
  bufferToUuid,
  instantKey,
  isDuplicateEntryError,
  newUuidBuffer,
  orgScope as toOrgId,
  tenantDb,
  toKeysetPage,
  tryUuidToBuffer,
  uuidKey,
} from '../../db';
import { ConflictError, InternalError } from '../../errors';

/**
 * Data access for the item catalog (initiative CAT; ROADMAP D-CAT-1…D-CAT-5).
 *
 * `contacts.repository.ts` is the shape this mirrors, and its two guarantees carry
 * over unchanged: every statement goes through `tenantDb`, so `org_id = ctx.orgId`
 * is on it before this file adds a predicate — a cross-org id matches nothing and
 * the service's `assertFound` turns that into A7's one sanctioned miss — and no
 * driver error escapes: a duplicate `code` is errno 1062, and it becomes the same
 * `ConflictError` a create and an update both raise rather than an opaque 500.
 */

/** The resource token every miss in this module reports (A7). */
export const CATALOG_ITEM_RESOURCE = 'catalog_item';

/** The columns every read in this module selects, so one mapper covers them all. */
const CATALOG_ITEM_COLUMNS = [
  'id',
  'direction',
  'name',
  'code',
  'account_id',
  'unit_amount_minor',
  'tax_rate_id',
  'is_active',
  'created_at',
  'updated_at',
] as const;

interface CatalogItemRow {
  readonly id: Buffer;
  readonly direction: string;
  readonly name: string;
  readonly code: string | null;
  readonly account_id: Buffer | null;
  readonly unit_amount_minor: bigint | null;
  readonly tax_rate_id: Buffer | null;
  readonly is_active: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface NewCatalogItemRow {
  readonly direction: CatalogItemDirection;
  readonly name: string;
  readonly code: string | null;
  readonly accountId: Buffer | null;
  readonly unitAmountMinor: bigint | null;
  readonly taxRateId: Buffer | null;
}

/**
 * `direction` is absent: it is immutable (see `directionSchema` in shared-types),
 * so there is nowhere on the patch to put a new one. `code` is present and nullable,
 * the `ContactPatch` shape: `null` gives the code up, absent leaves it alone.
 */
export interface CatalogItemPatch {
  readonly name?: string;
  readonly code?: string | null;
  readonly accountId?: Buffer | null;
  readonly unitAmountMinor?: bigint | null;
  readonly taxRateId?: Buffer | null;
  readonly isActive?: boolean;
}

/** The org-scoped handle for the current operation (spec §4: no org parameters). */
export function orgScope(ctx: RequestContext): TenantDatabase {
  return tenantDb(toOrgId(ctx.orgId));
}

/**
 * A client-supplied catalog-item id as bytes, or `undefined` when it is not a UUID.
 *
 * Undefined rather than a throw, so the service routes a malformed id through
 * `assertFound` to the same 404 a nonexistent one produces (A7).
 */
export function catalogItemIdBytes(catalogItemId: string): Buffer | undefined {
  return tryUuidToBuffer(catalogItemId);
}

export async function insertCatalogItem(
  db: TenantDatabase,
  input: NewCatalogItemRow,
): Promise<CatalogItemRow> {
  const id = newUuidBuffer();

  try {
    await db
      .insertInto('catalog_items')
      .values({
        id,
        direction: input.direction,
        name: input.name,
        code: input.code,
        account_id: input.accountId,
        unit_amount_minor: input.unitAmountMinor,
        tax_rate_id: input.taxRateId,
      })
      .execute();
  } catch (error) {
    throw translateDuplicateCode(error, input.code);
  }

  const row = await selectCatalogItemById(db, id);
  if (row === undefined) {
    throw new InternalError('The catalog item inserted by this statement could not be read back.');
  }
  return row;
}

export async function selectCatalogItemById(
  db: TenantDatabase,
  id: Buffer,
): Promise<CatalogItemRow | undefined> {
  return db
    .selectFrom('catalog_items')
    .select(CATALOG_ITEM_COLUMNS)
    .where('id', '=', id)
    .executeTakeFirst();
}

/**
 * `(created_at, id)` — the contacts precedent and for its exact reason
 * (`catalogItemPageSchema` states it): `name` is mutable, and a keyset over a
 * mutable column silently drops the rows that move behind the cursor. Both columns
 * here are written once. `idx_catalog_items_org_created` is `(org_id, created_at,
 * id)`, so a page is a range scan rather than a sort.
 */
const CATALOG_ITEM_KEYSET: KeysetOrdering<CatalogItemRow> = [
  instantKey('catalog_items.created_at', (row) => row.created_at),
  uuidKey('catalog_items.id', (row) => row.id),
];

export async function selectCatalogItemsPage(
  db: TenantDatabase,
  filters: ListCatalogItemsQuery,
  limit: number,
): Promise<KeysetPage<CatalogItemRow>> {
  let query = db.selectFrom('catalog_items').select(CATALOG_ITEM_COLUMNS);

  if (filters.direction !== undefined) {
    query = query.where('direction', '=', filters.direction);
  }
  if (filters.isActive !== undefined) {
    query = query.where('is_active', '=', filters.isActive ? 1 : 0);
  }
  if (filters.q !== undefined && filters.q.length > 0) {
    // The picker's type-ahead: a substring of either the name or the SKU. The
    // wildcards a user could type are escaped so `%` and `_` match themselves
    // rather than acting as LIKE metacharacters; the column collation
    // (`utf8mb4_0900_ai_ci`) makes the match case- and accent-insensitive.
    const term = `%${escapeLike(filters.q)}%`;
    query = query.where((eb) => eb.or([eb('name', 'like', term), eb('code', 'like', term)]));
  }

  const rows = await applyKeyset(query, CATALOG_ITEM_KEYSET, limit, filters.cursor).execute();
  return toKeysetPage(rows, CATALOG_ITEM_KEYSET, limit);
}

export async function updateCatalogItemRow(
  db: TenantDatabase,
  id: Buffer,
  patch: CatalogItemPatch,
): Promise<void> {
  try {
    await db
      .updateTable('catalog_items')
      .set({
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.code === undefined ? {} : { code: patch.code }),
        ...(patch.accountId === undefined ? {} : { account_id: patch.accountId }),
        ...(patch.unitAmountMinor === undefined
          ? {}
          : { unit_amount_minor: patch.unitAmountMinor }),
        ...(patch.taxRateId === undefined ? {} : { tax_rate_id: patch.taxRateId }),
        ...(patch.isActive === undefined ? {} : { is_active: patch.isActive ? 1 : 0 }),
      })
      .where('id', '=', id)
      .execute();
  } catch (error) {
    throw translateDuplicateCode(error, patch.code ?? null);
  }
}

/**
 * The direction of each of `ids` that exists in this org, keyed by hex id.
 *
 * The read behind `assertCatalogItemsUsable` (B11): a cross-org or nonexistent id
 * is simply absent from the map, and the caller turns that into A7's 404 rather
 * than letting `fk_*_document_lines_catalog_item` answer errno 1452 with a 500.
 */
export async function selectCatalogItemDirections(
  db: TenantDatabase,
  ids: readonly Buffer[],
): Promise<ReadonlyMap<string, CatalogItemDirection>> {
  if (ids.length === 0) return new Map();

  const rows = await db
    .selectFrom('catalog_items')
    .select(['id', 'direction'])
    .where('id', 'in', ids)
    .execute();

  return new Map(
    rows.map((row) => [row.id.toString('hex'), row.direction as CatalogItemDirection]),
  );
}

/**
 * Whether `id` is an account of this org — the existence read behind the
 * `defaultAccountId` guard.
 *
 * Read through `tenantDb`, so another org's account does not merely fail the FK on
 * insert (errno 1452 → a 500) but is *absent* here, and the service turns that into
 * A7's 404 exactly as a document line's `accountId` does (B11).
 */
export async function accountExists(db: TenantDatabase, id: Buffer): Promise<boolean> {
  const row = await db.selectFrom('accounts').select('id').where('id', '=', id).executeTakeFirst();
  return row !== undefined;
}

/** The `defaultTaxRateId` counterpart of `accountExists`, and for the same reason. */
export async function taxRateExists(db: TenantDatabase, id: Buffer): Promise<boolean> {
  const row = await db.selectFrom('tax_rates').select('id').where('id', '=', id).executeTakeFirst();
  return row !== undefined;
}

export function toCatalogItem(row: CatalogItemRow): CatalogItem {
  return {
    id: bufferToUuid(row.id),
    direction: row.direction as CatalogItemDirection,
    name: row.name,
    code: row.code,
    defaultAccountId: row.account_id === null ? null : bufferToUuid(row.account_id),
    // Minor units as a cents-only string — the money wire form (D-13). Null when the
    // item carries no standing price.
    defaultUnitAmount: row.unit_amount_minor === null ? null : row.unit_amount_minor.toString(),
    defaultTaxRateId: row.tax_rate_id === null ? null : bufferToUuid(row.tax_rate_id),
    isActive: row.is_active !== 0,
    // `timezone: 'Z'` on the pool and `DATETIME(3)` left as a `Date`
    // (`src/db/connection.ts`), so these are real instants.
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * `uq_catalog_items_org_code` as a `ConflictError`, the `translateDuplicateCode`
 * shape from contacts.
 *
 * Free text is permitted on a conflict, unlike on a 404: the unique key is
 * `(org_id, code)`, so the row this collides with is inside the caller's own org and
 * naming the code discloses nothing they cannot already read. A `null` code cannot
 * collide (MySQL treats NULLs as distinct in a unique index), so an errno 1062
 * alongside one is a constraint this function does not know about and is passed
 * through untouched to become an opaque 500 — which is correct.
 */
function translateDuplicateCode(error: unknown, code: string | null): unknown {
  if (!isDuplicateEntryError(error) || code === null) return error;

  return new ConflictError(
    `A catalog item with code ${JSON.stringify(code)} already exists in this organization. Codes ` +
      'are compared case-insensitively, so a code differing only in case is the same code. Any ' +
      'number of items may have no code at all.',
    { code },
  );
}

/** Escapes the three LIKE metacharacters so a `q` substring matches literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
