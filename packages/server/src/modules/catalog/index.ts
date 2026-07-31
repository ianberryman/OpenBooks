/**
 * The item catalog (initiative CAT; ROADMAP D-CAT-1…D-CAT-5).
 *
 * A reusable, priced description a document line can be selected from instead of
 * typed from scratch. The catalog seeds a line's description, account, price and tax
 * and never binds it (D-CAT-2): the line keeps its own copy, and the `catalogItemId`
 * it records is provenance — where the line came from — not a live link.
 *
 * ## Surface
 *
 * | Operation                              | Permission       |
 * | -------------------------------------- | ---------------- |
 * | `createCatalogItem(input, ctx)`        | `catalog.write`  |
 * | `getCatalogItem(id, ctx)`              | `catalog.read`   |
 * | `listCatalogItems(query, ctx)`         | `catalog.read`   |
 * | `updateCatalogItem(id, input, ctx)`    | `catalog.write`  |
 * | `deactivateCatalogItem(id, ctx)`       | `catalog.write`  |
 * | `reactivateCatalogItem(id, ctx)`       | `catalog.write`  |
 *
 * There is no delete: a referenced item's line FKs are `ON DELETE RESTRICT`, so
 * deactivation is the only removal (D-CAT-5), mirroring how a posted-to contact can
 * only be deactivated.
 *
 * `listCatalogItems` returns one bounded, keyset-paginated page over `(created_at,
 * id)` — see `CATALOG_ITEM_KEYSET` in `catalog.repository.ts` and the block on
 * `catalogItemPageSchema` for why it is that pair and not `name`.
 *
 * ## Two decisions worth reading before changing anything here
 *
 * **A catalog item's `direction` is immutable.** `'sales'` and `'purchase'` items
 * carry different accounts and seed different documents (D-CAT-1); flipping the
 * direction would leave every line that already cited the item citing the wrong
 * kind. The correction for a mis-directed item is to deactivate it and make the
 * other one — the `accounts.code` immutability argument.
 *
 * **Provenance is never destructively re-validated (D-CAT-2).**
 * `assertCatalogItemsUsable` — the guard the document services call before they
 * persist a line — checks that a referenced item exists in the org (B11, a 404 for a
 * cross-org id) and that its direction matches the document, and it deliberately
 * does *not* check `is_active`. A line that cited an item later deactivated keeps its
 * provenance, and re-saving the document must not begin to fail because the catalog
 * was tidied afterwards.
 */

export type {
  CatalogItem,
  CatalogItemDirection,
  CatalogItemPage,
  CreateCatalogItemRequest,
  ListCatalogItemsQuery,
  UpdateCatalogItemRequest,
} from '@openbooks/shared-types';

export {
  assertCatalogItemsUsable,
  createCatalogItem,
  deactivateCatalogItem,
  getCatalogItem,
  listCatalogItems,
  reactivateCatalogItem,
  updateCatalogItem,
} from './catalog.service';
