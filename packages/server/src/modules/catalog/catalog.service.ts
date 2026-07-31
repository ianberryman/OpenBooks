import type {
  CatalogItem,
  CatalogItemDirection,
  CatalogItemPage,
  CreateCatalogItemRequest,
  ListCatalogItemsQuery,
  UpdateCatalogItemRequest,
} from '@openbooks/shared-types';
import {
  createCatalogItemRequestSchema,
  listCatalogItemsQuerySchema,
  updateCatalogItemRequestSchema,
} from '@openbooks/shared-types';
import { fromMinorString, toMinorUnits } from '@openbooks/shared-types/money';

import type { RequestContext } from '../../context';
import type { TenantDatabase } from '../../db';
import { resolvePageLimit, tryUuidToBuffer, uuidToBuffer } from '../../db';
import { NotFoundError, PreconditionFailedError, assertFound, parseInput } from '../../errors';
import { requirePermission } from '../permissions';

import type { CatalogItemPatch } from './catalog.repository';
import {
  CATALOG_ITEM_RESOURCE as RESOURCE,
  accountExists,
  catalogItemIdBytes,
  insertCatalogItem,
  orgScope,
  selectCatalogItemById,
  selectCatalogItemDirections,
  selectCatalogItemsPage,
  taxRateExists,
  toCatalogItem,
  updateCatalogItemRow,
} from './catalog.repository';

/**
 * The item catalog (initiative CAT; ROADMAP D-CAT-1…D-CAT-5).
 *
 * A catalog item is a reusable, priced description a document line can be selected
 * from instead of typed from scratch. This module owns the CRUD; the document
 * services own the *use*, and the only thing they reach back for is
 * `assertCatalogItemsUsable`, the cross-org and wrong-direction guard below.
 *
 * The three uniformities `contacts.service.ts` sets out hold here too, stated once:
 *
 * 1. **`requirePermission` runs first**, before the payload is parsed, so a caller
 *    without authority learns nothing about the shape of an API it cannot use.
 *    Enforcement is service-layer only (spec §2.4, §5).
 * 2. **Every payload is parsed with the shared zod schema**, because the HTTP route
 *    is not the only caller (spec §12).
 * 3. **A miss is `assertFound`**, never a hand-written throw. `tenantDb` has already
 *    confined the read to the context's org, so a cross-org id returns no row and
 *    reaches the same line a nonexistent id reaches (A7).
 *
 * ## `direction` is immutable, and `isActive` is not on the patch
 *
 * A `'sales'` item seeds a document that earns and a `'purchase'` item one that
 * spends (D-CAT-1); flipping the direction would leave every line that already cited
 * the item citing the wrong kind, so the fix for a mis-directed item is to
 * deactivate it and make the other one — the `accounts.code` immutability argument.
 * Deactivation is its own operation rather than a field in a patch, for the reason
 * `deactivateContact` gives: reactivation has to exist or deactivation is a one-way
 * door, and the two read as operations, not as a boolean toggle.
 */

export async function createCatalogItem(
  input: CreateCatalogItemRequest,
  ctx: RequestContext,
): Promise<CatalogItem> {
  await requirePermission(ctx, 'catalog.write');
  const request = parseInput(createCatalogItemRequestSchema, input);

  const db = orgScope(ctx);
  const accountId =
    request.defaultAccountId == null ? null : await requireAccount(db, request.defaultAccountId);
  const taxRateId =
    request.defaultTaxRateId == null ? null : await requireTaxRate(db, request.defaultTaxRateId);

  const row = await insertCatalogItem(db, {
    direction: request.direction,
    name: request.name,
    code: request.code ?? null,
    accountId,
    // Parsed as a cents-only string by `minorUnitsSchema`; stored as the `BIGINT`
    // the column takes. `fromMinorString` rejects a decimal, so this cannot land a
    // fractional cent in the column (D-13).
    unitAmountMinor:
      request.defaultUnitAmount == null
        ? null
        : toMinorUnits(fromMinorString(request.defaultUnitAmount)),
    taxRateId,
  });

  return toCatalogItem(row);
}

export async function getCatalogItem(
  catalogItemId: string,
  ctx: RequestContext,
): Promise<CatalogItem> {
  await requirePermission(ctx, 'catalog.read');

  const db = orgScope(ctx);
  const id = assertFound(catalogItemIdBytes(catalogItemId), RESOURCE);

  return toCatalogItem(assertFound(await selectCatalogItemById(db, id), RESOURCE));
}

/**
 * One page of the org's catalog items, oldest first (D-21).
 *
 * `resolvePageLimit` and not the parsed `limit`, `listContacts`'s reason: the schema
 * is a restatement for `openapi.json`'s benefit and the function is the authority,
 * because spec §12 puts an MCP tool and the workflow engine on this service with no
 * schema in front of them.
 */
export async function listCatalogItems(
  query: ListCatalogItemsQuery,
  ctx: RequestContext,
): Promise<CatalogItemPage> {
  await requirePermission(ctx, 'catalog.read');
  const filters = parseInput(listCatalogItemsQuerySchema, query);
  const limit = resolvePageLimit(filters.limit);

  const page = await selectCatalogItemsPage(orgScope(ctx), filters, limit);
  return { items: page.rows.map(toCatalogItem), nextCursor: page.nextCursor };
}

/**
 * Updates the mutable fields of one item. `direction` is not among them (see the
 * file header); an absent field is left alone and an explicit `null` clears a
 * nullable one — the `updateContact` shape.
 */
export async function updateCatalogItem(
  catalogItemId: string,
  input: UpdateCatalogItemRequest,
  ctx: RequestContext,
): Promise<CatalogItem> {
  await requirePermission(ctx, 'catalog.write');
  const request = parseInput(updateCatalogItemRequestSchema, input);

  const db = orgScope(ctx);
  const id = assertFound(catalogItemIdBytes(catalogItemId), RESOURCE);
  assertFound(await selectCatalogItemById(db, id), RESOURCE);

  const patch: CatalogItemPatch = {
    ...(request.name === undefined ? {} : { name: request.name }),
    ...(request.code === undefined ? {} : { code: request.code }),
    ...(request.defaultAccountId === undefined
      ? {}
      : {
          accountId:
            request.defaultAccountId === null
              ? null
              : await requireAccount(db, request.defaultAccountId),
        }),
    ...(request.defaultUnitAmount === undefined
      ? {}
      : {
          unitAmountMinor:
            request.defaultUnitAmount === null
              ? null
              : toMinorUnits(fromMinorString(request.defaultUnitAmount)),
        }),
    ...(request.defaultTaxRateId === undefined
      ? {}
      : {
          taxRateId:
            request.defaultTaxRateId === null
              ? null
              : await requireTaxRate(db, request.defaultTaxRateId),
        }),
  };

  await updateCatalogItemRow(db, id, patch);
  return toCatalogItem(assertFound(await selectCatalogItemById(db, id), RESOURCE));
}

/**
 * Takes an item out of circulation without removing it (D-CAT-5).
 *
 * This is the only removal a referenced item allows — the line FKs are
 * `ON DELETE RESTRICT` — and it is idempotent: an already-inactive item is returned
 * unchanged, because a retry of a deactivation is a retry, not a conflict.
 */
export async function deactivateCatalogItem(
  catalogItemId: string,
  ctx: RequestContext,
): Promise<CatalogItem> {
  return setActive(catalogItemId, false, ctx);
}

/** The counterpart, so deactivation is not a one-way door (`reactivateContact`). */
export async function reactivateCatalogItem(
  catalogItemId: string,
  ctx: RequestContext,
): Promise<CatalogItem> {
  return setActive(catalogItemId, true, ctx);
}

/**
 * The default account, validated to exist in this org (B11).
 *
 * A cross-org or nonexistent account is A7's 404 — read through `tenantDb`, so the FK
 * never fires (which would be a 500) and the answer is the same `NotFoundError` a
 * document line's `accountId` produces. Existence only, not type: the account a sales
 * item nominates should be income and a purchase item's expense, but that is the
 * picker's convenience, not a binding the line inherits (D-CAT-2). The id is a
 * schema-validated `z.uuid()`, so `uuidToBuffer` cannot fail on shape.
 */
async function requireAccount(db: TenantDatabase, accountId: string): Promise<Buffer> {
  const bytes = uuidToBuffer(accountId);
  if (!(await accountExists(db, bytes))) throw new NotFoundError('account');
  return bytes;
}

/** The `defaultTaxRateId` counterpart of `requireAccount` (D-35: one rate). */
async function requireTaxRate(db: TenantDatabase, taxRateId: string): Promise<Buffer> {
  const bytes = uuidToBuffer(taxRateId);
  if (!(await taxRateExists(db, bytes))) throw new NotFoundError('tax_rate');
  return bytes;
}

async function setActive(
  catalogItemId: string,
  isActive: boolean,
  ctx: RequestContext,
): Promise<CatalogItem> {
  await requirePermission(ctx, 'catalog.write');

  const db = orgScope(ctx);
  const id = assertFound(catalogItemIdBytes(catalogItemId), RESOURCE);
  assertFound(await selectCatalogItemById(db, id), RESOURCE);

  await updateCatalogItemRow(db, id, { isActive });
  return toCatalogItem(assertFound(await selectCatalogItemById(db, id), RESOURCE));
}

/**
 * Refuses a document line that cites an unusable catalog item — the guard the four
 * document services call before they persist their lines.
 *
 * Two failures, and they are the two D-CAT-1 makes possible:
 *
 *  - **A missing id is a 404 (B11).** The read goes through `tenantDb`, so a
 *    cross-org item is indistinguishable from a nonexistent one — the same A7 shape
 *    every other reference resolution in the document services uses, and the reason
 *    the check is a `tenantDb` read rather than letting the line FK answer errno
 *    1452 with a 500.
 *  - **A wrong-direction item is a `precondition_failed`.** A sales document
 *    (`'sales'`) accepts only a sales item and a purchase document only a purchase
 *    one; the stable token `catalog_item_wrong_direction` is what a client branches
 *    on. The fix is to pick the other item, so the message points there.
 *
 * `is_active` is deliberately **not** checked (D-CAT-2): provenance is never
 * destructively re-validated. A line that cited an item which was later deactivated
 * keeps that provenance, and re-saving the document — repricing, converting a
 * pre-document — must not start failing because the catalog was tidied afterwards.
 * The item still exists (deactivation is not deletion), so both checks above still
 * pass for it.
 *
 * Takes the caller's tenant handle so the read joins their open transaction
 * (`transaction-scope.ts`) rather than opening a connection of its own.
 */
export async function assertCatalogItemsUsable(
  db: TenantDatabase,
  refs: readonly { readonly catalogItemId: string; readonly expected: CatalogItemDirection }[],
): Promise<void> {
  if (refs.length === 0) return;

  const idByHex = new Map<string, Buffer>();
  for (const ref of refs) {
    const bytes = assertFound(tryUuidToBuffer(ref.catalogItemId), RESOURCE);
    idByHex.set(bytes.toString('hex'), bytes);
  }

  const directions = await selectCatalogItemDirections(db, [...idByHex.values()]);

  for (const ref of refs) {
    const bytes = assertFound(tryUuidToBuffer(ref.catalogItemId), RESOURCE);
    const direction = directions.get(bytes.toString('hex'));

    // Absent means missing or cross-org: A7's one miss, a 404 (B11).
    if (direction === undefined) throw new NotFoundError(RESOURCE);

    if (direction !== ref.expected) {
      throw new PreconditionFailedError(
        'catalog_item_wrong_direction',
        `This catalog item is a ${direction} item and cannot be put on a ${ref.expected} ` +
          'document. A sales document takes only sales items and a purchase document only ' +
          'purchase ones (D-CAT-1); a thing you both buy and sell is two items. Pick the ' +
          `${ref.expected} item instead.`,
      );
    }
  }
}
