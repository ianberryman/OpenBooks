import {
  CATALOG_ITEM_DIRECTIONS,
  catalogItemPageSchema,
  catalogItemSchema,
  createCatalogItemRequestSchema,
  pageCursorSchema,
  updateCatalogItemRequestSchema,
} from '@openbooks/shared-types';
import type { CatalogItem, CatalogItemPage } from '@openbooks/shared-types';
import { z } from 'zod';

import { getContext } from '../../context';
import {
  createCatalogItem,
  deactivateCatalogItem,
  getCatalogItem,
  listCatalogItems,
  reactivateCatalogItem,
  updateCatalogItem,
} from '../../modules/catalog';
import { withIdempotency } from '../../modules/idempotency';
import type { App } from '../types';
import {
  ERROR_RESPONSES,
  ORG_SCOPED_WRITE_HOOKS,
  idempotencyKeyHeaderSchema,
  idempotentBody,
  pageLimitQuery,
  requireOrgScope,
} from './support';

/**
 * `/v1/catalog-items` — the reusable, priced items a document line is selected from
 * (initiative CAT; ROADMAP D-CAT-1…D-CAT-5).
 *
 * The surface is `/v1/contacts`'s, deliberately: create, read, list, patch, and the
 * two activation routes. There is no delete — a referenced item's line FKs are
 * `ON DELETE RESTRICT`, so deactivation is the only removal (D-CAT-5), exactly as a
 * posted-to contact can only be deactivated.
 *
 * A handler here maps arguments and nothing else (spec §2.4): no validation beyond
 * the schema, no `requirePermission` (service-layer only, spec §5), and no queries.
 */

const TAG = 'catalog';

const catalogItemParamsSchema = z.strictObject({ catalogItemId: z.uuid() });

/**
 * Local and carrying no `id`, the list-query convention: a querystring is emitted as
 * individual `parameters`, so a component for the object would be referenced by
 * nothing. The coercions are here because this is the only layer that knows the
 * values arrived as text — `listCatalogItemsQuerySchema` in `@openbooks/shared-types`
 * takes a real boolean and a real enum, because a shared schema that accepted
 * `'false'` would accept it from a JSON body too.
 */
const listCatalogItemsWireQuerySchema = z.strictObject({
  direction: z.enum(CATALOG_ITEM_DIRECTIONS).optional().meta({
    description: 'Restrict to sales items or to purchase items.',
  }),
  isActive: z.stringbool().optional().meta({
    description: 'Omitted matches active and inactive items alike.',
  }),
  q: z.string().trim().min(1).optional().meta({
    description: 'Filters to items whose name or code contains this text.',
  }),
  limit: pageLimitQuery('catalog items'),
  cursor: pageCursorSchema.optional(),
});

export function registerCatalogRoutes(app: App): void {
  app.post(
    '/v1/catalog-items',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'createCatalogItem',
        summary: 'Create a catalog item',
        description:
          'Items are created active. Only `name` and `direction` are required: the defaults ' +
          '(account, unit price, tax rate) are optional, since an item can be a reusable ' +
          'description on its own. `direction` is immutable — a thing you both buy and sell is ' +
          'two items (D-CAT-1).',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        body: createCatalogItemRequestSchema,
        response: { 201: catalogItemSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const result = await withIdempotency(
        { endpoint: 'createCatalogItem', request: request.body, successStatus: 201 },
        () => createCatalogItem(request.body, ctx),
      );

      const item = idempotentBody<CatalogItem>(result);
      return reply
        .status(result.status)
        .header('location', `/v1/catalog-items/${item.id}`)
        .send(item);
    },
  );

  app.get(
    '/v1/catalog-items',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listCatalogItems',
        summary: 'List catalog items',
        description:
          'One page, oldest first by creation. Deliberately not alphabetical: `name` is the field ' +
          'most likely to be edited, and a keyset cursor over a mutable column drops the rows ' +
          'that moved behind it (ROADMAP D-21). A picker that wants the list by name sorts the ' +
          'bounded set it holds.',
        tags: [TAG],
        querystring: listCatalogItemsWireQuerySchema,
        response: { 200: catalogItemPageSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<CatalogItemPage> => {
      const { direction, isActive, q, limit, cursor } = request.query;
      return listCatalogItems(
        {
          limit,
          ...(cursor === undefined ? {} : { cursor }),
          ...(direction === undefined ? {} : { direction }),
          ...(isActive === undefined ? {} : { isActive }),
          ...(q === undefined ? {} : { q }),
        },
        getContext(),
      );
    },
  );

  app.get(
    '/v1/catalog-items/:catalogItemId',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getCatalogItem',
        summary: 'One catalog item',
        tags: [TAG],
        params: catalogItemParamsSchema,
        response: { 200: catalogItemSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<CatalogItem> =>
      getCatalogItem(request.params.catalogItemId, getContext()),
  );

  app.patch(
    '/v1/catalog-items/:catalogItemId',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'updateCatalogItem',
        summary: 'Update a catalog item',
        description:
          'An absent field is unchanged and an explicit `null` clears it. `direction` is not here ' +
          '— it is immutable — and `isActive` is not either: deactivation is its own operation.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: catalogItemParamsSchema,
        body: updateCatalogItemRequestSchema,
        response: { 200: catalogItemSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { catalogItemId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'updateCatalogItem',
          request: { catalogItemId, patch: request.body },
          successStatus: 200,
        },
        () => updateCatalogItem(catalogItemId, request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<CatalogItem>(result));
    },
  );

  /** Registered from a table for the reason `contacts.ts` gives: they differ in one word. */
  for (const route of [
    {
      path: '/v1/catalog-items/:catalogItemId/deactivate',
      operationId: 'deactivateCatalogItem',
      summary: 'Deactivate a catalog item',
      description:
        'Takes an item out of circulation without removing it, which is the only removal a ' +
        'referenced item allows (the line FKs are `ON DELETE RESTRICT`, D-CAT-5). An inactive ' +
        'item keeps every line that already cited it and cannot be chosen for new ones. ' +
        'Idempotent: an already-inactive item is returned unchanged.',
      run: deactivateCatalogItem,
    },
    {
      path: '/v1/catalog-items/:catalogItemId/reactivate',
      operationId: 'reactivateCatalogItem',
      summary: 'Reactivate a catalog item',
      description: 'The counterpart, so that deactivation is not a one-way door.',
      run: reactivateCatalogItem,
    },
  ] as const) {
    app.post(
      route.path,
      {
        onRequest: ORG_SCOPED_WRITE_HOOKS,
        schema: {
          operationId: route.operationId,
          summary: route.summary,
          description: route.description,
          tags: [TAG],
          headers: idempotencyKeyHeaderSchema,
          params: catalogItemParamsSchema,
          response: { 200: catalogItemSchema, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        const ctx = getContext();
        const { catalogItemId } = request.params;
        const result = await withIdempotency(
          { endpoint: route.operationId, request: { catalogItemId }, successStatus: 200 },
          () => route.run(catalogItemId, ctx),
        );

        return reply.status(result.status).send(idempotentBody<CatalogItem>(result));
      },
    );
  }
}
