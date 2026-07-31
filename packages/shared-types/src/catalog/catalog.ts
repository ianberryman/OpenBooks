import { z } from 'zod';

import { minorUnitsSchema, pageQueryShape, pageSchema } from '../wire';

/**
 * Request and response schemas for the item catalog (initiative CAT; ROADMAP
 * D-CAT-1…D-CAT-5).
 *
 * A catalog item is a reusable, priced description a document line can be selected
 * from instead of typed from scratch. The `contacts.ts` split holds: the schema is
 * the shape, and everything needing authority or state — `requirePermission`, the
 * duplicate-`code` conflict, the delete restriction — stays on the server.
 *
 * ## The `id`s
 *
 * `contacts.ts`'s rule applies unchanged: an `id` goes on a body or response schema
 * a route references and nothing else. `listCatalogItemsQuerySchema` has none — a
 * querystring is emitted as individual `parameters`, so a component for it would be
 * referenced by nothing.
 *
 * ## Ordered by creation, not by name
 *
 * `catalogItemPageSchema` pages by `(created_at, id)`, the contacts precedent and
 * for its exact reason: `name` is mutable, and a keyset over a mutable column
 * silently drops the rows that move behind the cursor. The `< md` picker loads a
 * bounded set of active items and sorts by name in memory (the estimates
 * reference-data pattern); the settings list is chronological.
 */

/**
 * Column widths, restated from the `catalog_items` block in `0019_catalog`. The
 * inequality runs the safe way (`contacts.ts`): MySQL's `VARCHAR(n)` counts
 * characters and `String.length` counts UTF-16 code units.
 */
export const CATALOG_ITEM_NAME_MAX_LENGTH = 512;
export const CATALOG_ITEM_CODE_MAX_LENGTH = 64;

/**
 * `'sales'` items seed a document that *earns* — an invoice or an estimate — and
 * carry an income account; `'purchase'` items seed one that *spends* — a bill, a
 * purchase order, an expense — and carry an expense account. A thing bought and
 * sold is two items (D-CAT-1). Immutable after creation (absent from the update
 * schema): flipping an item's direction would leave every line that already cited
 * it citing the wrong kind, and the fix for a mis-directed item is to deactivate it
 * and make the other one — the `accounts.code` immutability argument.
 */
export const CATALOG_ITEM_DIRECTIONS = ['sales', 'purchase'] as const;

export type CatalogItemDirection = (typeof CATALOG_ITEM_DIRECTIONS)[number];

const directionSchema = z.enum(CATALOG_ITEM_DIRECTIONS).meta({
  description:
    'Which side of the books this item seeds. `sales` items appear on invoices and estimates and ' +
    'carry an income account; `purchase` items on bills, purchase orders and expenses and carry ' +
    'an expense account. A thing you both buy and sell is two items (D-CAT-1).',
});

const nameSchema = z.string().trim().min(1).max(CATALOG_ITEM_NAME_MAX_LENGTH).meta({
  description: 'What the item is called, and what fills the line description when it is selected.',
});

const codeSchema = z
  .string()
  .trim()
  .min(1)
  .max(CATALOG_ITEM_CODE_MAX_LENGTH)
  .meta({
    description:
      'Optional SKU, unique within the org under the column’s case- and accent-insensitive ' +
      'collation. `uq_catalog_items_org_code` treats NULLs as distinct, so any number of items ' +
      'may carry none. Send `null` to clear it.',
  });

const defaultAccountIdSchema = z.uuid().meta({
  description:
    'The account a line inherits when this item is chosen — income for a sales item, expense for ' +
    'a purchase one. A default the picker fills in, not a binding: the line keeps its own copy ' +
    '(D-CAT-2). Send `null` to leave the line’s account for the user to pick.',
});

const defaultUnitAmountSchema = minorUnitsSchema.meta({
  description:
    'The item’s default unit price in minor units, seeded onto the line. Null when the item has ' +
    'no standing price and the user types one each time.',
});

const defaultTaxRateIdSchema = z.uuid().meta({
  description:
    'The tax rate a line inherits when this item is chosen (D-35: one rate). Null means the line ' +
    'starts untaxed — there is no default rate, the `documentLineInputSchema` argument.',
});

/**
 * A catalog item as the API returns it. Nullable-and-required rather than optional,
 * every-other-response-schema's convention: a persisted row holds a value or holds
 * NULL, and under `exactOptionalPropertyTypes` an absent key differs from a null one.
 */
export const catalogItemSchema = z
  .strictObject({
    id: z.uuid(),
    direction: directionSchema,
    name: nameSchema,
    code: codeSchema.nullable(),
    defaultAccountId: defaultAccountIdSchema.nullable(),
    defaultUnitAmount: defaultUnitAmountSchema.nullable(),
    defaultTaxRateId: defaultTaxRateIdSchema.nullable(),
    isActive: z.boolean().meta({
      description:
        'Inactive items keep every line that already cited them (the FK is `ON DELETE RESTRICT`) ' +
        'and cannot be chosen for new ones. This is the only removal a referenced item allows ' +
        '(D-CAT-5).',
    }),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({
    id: 'CatalogItem',
    description:
      'A reusable, priced item a document line can be selected from — a convenience that seeds the ' +
      'line’s description, account, price and tax, and never binds it (D-CAT-2).',
  });

export type CatalogItem = z.infer<typeof catalogItemSchema>;

/**
 * Creates one item. `name` and `direction` are required; the three defaults are
 * optional, because an item can be a reusable description alone.
 */
export const createCatalogItemRequestSchema = z
  .strictObject({
    direction: directionSchema,
    name: nameSchema,
    code: codeSchema.nullish(),
    defaultAccountId: defaultAccountIdSchema.nullish(),
    defaultUnitAmount: defaultUnitAmountSchema.nullish(),
    defaultTaxRateId: defaultTaxRateIdSchema.nullish(),
  })
  .meta({
    id: 'CreateCatalogItemRequest',
    description:
      'Creates one catalog item. Only `name` and `direction` are required; the defaults are ' +
      'optional, since an item can be a reusable description on its own.',
  });

export type CreateCatalogItemRequest = z.infer<typeof createCatalogItemRequestSchema>;

/**
 * Partial update; an absent field is left alone and an explicit `null` clears a
 * nullable one. `direction` is absent (immutable, see `directionSchema`), and
 * `isActive` is absent because deactivation is its own operation — the
 * `updateContactRequestSchema` shape.
 */
export const updateCatalogItemRequestSchema = z
  .strictObject({
    name: nameSchema.optional(),
    code: codeSchema.nullish(),
    defaultAccountId: defaultAccountIdSchema.nullish(),
    defaultUnitAmount: defaultUnitAmountSchema.nullish(),
    defaultTaxRateId: defaultTaxRateIdSchema.nullish(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: 'Supply at least one field to change.',
  })
  .meta({
    id: 'UpdateCatalogItemRequest',
    description:
      'Partial update. An absent field is unchanged and an explicit `null` clears it. `direction` ' +
      'is immutable and `isActive` is not here — deactivation is its own operation.',
  });

export type UpdateCatalogItemRequest = z.infer<typeof updateCatalogItemRequestSchema>;

/**
 * List filters, plus the shared pagination. `direction` and `isActive` are real
 * enums/booleans, not query-string flags — the `listContactsQuerySchema` reason
 * (a shared schema that accepted `'false'` would accept it from a JSON body too).
 * `q` is a name/code substring the picker types.
 */
export const listCatalogItemsQuerySchema = z.strictObject({
  ...pageQueryShape,
  direction: directionSchema.optional(),
  isActive: z.boolean().optional(),
  q: z
    .string()
    .trim()
    .min(1)
    .max(CATALOG_ITEM_NAME_MAX_LENGTH)
    .optional()
    .meta({ description: 'Filters to items whose name or code contains this text.' }),
});

/**
 * The *input* type, not `z.infer`: `limit` carries a `.default()`, so the parsed
 * output has it and a caller does not — two different types under
 * `exactOptionalPropertyTypes` (`listContactsQuerySchema`'s note).
 */
export type ListCatalogItemsQuery = z.input<typeof listCatalogItemsQuerySchema>;

export const catalogItemPageSchema = pageSchema(catalogItemSchema, {
  id: 'CatalogItemPage',
  description:
    'One page of the org’s catalog items, oldest first by creation (not by name: a cursor into a ' +
    'list ordered by an editable column drops the rows that moved behind it — the contacts note).',
});

export type CatalogItemPage = z.infer<typeof catalogItemPageSchema>;
