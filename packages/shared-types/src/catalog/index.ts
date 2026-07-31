/**
 * The item catalog wire contract (initiative CAT).
 *
 * Read `catalog.ts` for why `direction` is immutable (the `accounts.code`
 * argument), why the list is ordered by `(created_at, id)` rather than by name (the
 * contacts note), and why the three defaults are a convenience the picker fills in
 * rather than a binding on the line (D-CAT-2).
 *
 * The bodies and responses carry `.meta({ id })` and the list query deliberately
 * does not — a querystring is emitted as individual `parameters`.
 */

export type {
  CatalogItem,
  CatalogItemDirection,
  CatalogItemPage,
  CreateCatalogItemRequest,
  ListCatalogItemsQuery,
  UpdateCatalogItemRequest,
} from './catalog';
export {
  CATALOG_ITEM_CODE_MAX_LENGTH,
  CATALOG_ITEM_DIRECTIONS,
  CATALOG_ITEM_NAME_MAX_LENGTH,
  catalogItemPageSchema,
  catalogItemSchema,
  createCatalogItemRequestSchema,
  listCatalogItemsQuerySchema,
  updateCatalogItemRequestSchema,
} from './catalog';
