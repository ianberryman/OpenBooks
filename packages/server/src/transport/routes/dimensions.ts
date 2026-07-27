import {
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  createDimensionRequestSchema,
  createDimensionValueRequestSchema,
  dimensionPageSchema,
  dimensionSchema,
  dimensionValuePageSchema,
  dimensionValueSchema,
  pageCursorSchema,
  updateDimensionRequestSchema,
  updateDimensionValueRequestSchema,
} from '@openbooks/shared-types';
import type {
  Dimension,
  DimensionPage,
  DimensionValue,
  DimensionValuePage,
} from '@openbooks/shared-types';
import { z } from 'zod';

import { getContext } from '../../context';
import {
  archiveDimension,
  archiveDimensionValue,
  createDimension,
  createDimensionValue,
  deleteDimension,
  deleteDimensionValue,
  getDimension,
  getDimensionValue,
  listDimensionValues,
  listDimensions,
  unarchiveDimension,
  unarchiveDimensionValue,
  updateDimension,
  updateDimensionValue,
} from '../../modules/dimensions';
import { withIdempotency } from '../../modules/idempotency';
import type { App } from '../types';
import {
  ERROR_RESPONSES,
  ORG_SCOPED_WRITE_HOOKS,
  idempotencyKeyHeaderSchema,
  idempotentBody,
  noContentSchema,
  requireOrgScope,
} from './support';

/**
 * `/v1/dimensions` and `/v1/dimension-values` — the reporting axes and their
 * values (OB-037; spec §2.5, ROADMAP D-18).
 *
 * ## Why values are not nested under their axis for every operation
 *
 * Create and list are: a new value needs to be told which axis it belongs to, and
 * a list of values is a list *of an axis*, so `/v1/dimensions/{dimensionId}/values`
 * is the resource in both cases and the path carries the argument the service
 * takes.
 *
 * Read, update, archive, unarchive and delete are not. `getDimensionValue(valueId)`
 * and its four siblings take the value id alone, because a value id already names
 * its axis — that is what the three-column foreign key `fk_jld_value` guarantees.
 * Nesting them would put a `dimensionId` in the path that no service argument
 * consumes, leaving the route two bad options: ignore it, and publish a path
 * segment that means nothing, or check that it matches the value's real axis, which
 * is authorization-shaped logic in a layer that may hold none (spec §2.4). A flat
 * `/v1/dimension-values/{valueId}` has neither problem, and the asymmetry is honest
 * about which operations need the axis and which do not.
 *
 * ## Archive and unarchive, not a flag on the patch
 *
 * `accounts.ts` makes the argument and it applies unchanged, one level down:
 * archiving decides whether an axis or a value is offered for new tagging, which
 * every sliced report's contents depend on, so it is not expressible as a side
 * effect of renaming. Unarchive exists because otherwise archiving is a one-way
 * door — deletion is unavailable to anything a journal line already carries.
 */

const TAG = 'dimensions';

const dimensionParamsSchema = z.strictObject({ dimensionId: z.uuid() });
const dimensionValueParamsSchema = z.strictObject({ valueId: z.uuid() });

/**
 * Local and carrying no `id`, like every other list query here: a querystring is
 * emitted as individual `parameters`. The coercions are the route's, because this
 * is the only layer that knows the values arrived as text.
 */
const listWireQuerySchema = z.strictObject({
  isActive: z
    .stringbool()
    .optional()
    .meta({
      description:
        'Accepts `true`/`false` (and `1`/`0`, `yes`/`no`, `on`/`off`). Omitted matches archived ' +
        'and unarchived alike.',
    }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PAGE_SIZE_MAX)
    .default(PAGE_SIZE_DEFAULT)
    .meta({
      description:
        'How many to return, at most. Over the maximum is refused rather than clamped, so a ' +
        'short page always means the list is short.',
    }),
  cursor: pageCursorSchema.optional(),
});

export function registerDimensionRoutes(app: App): void {
  app.post(
    '/v1/dimensions',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'createDimension',
        summary: 'Create a dimension',
        description:
          'An org may define at most eight axes, archived ones included, and over that is ' +
          '`precondition_failed` with `dimension_limit_reached` — every axis is another join in ' +
          'every sliced report and another row per tagged line (D-18). `code` is immutable once ' +
          'created.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        body: createDimensionRequestSchema,
        response: { 201: dimensionSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const result = await withIdempotency(
        { endpoint: 'createDimension', request: request.body, successStatus: 201 },
        () => createDimension(request.body, ctx),
      );

      const dimension = idempotentBody<Dimension>(result);
      return reply
        .status(result.status)
        .header('location', `/v1/dimensions/${dimension.id}`)
        .send(dimension);
    },
  );

  app.get(
    '/v1/dimensions',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listDimensions',
        summary: 'List dimensions',
        description:
          'One page, in `code` order. Paging is safe against a cursor because a dimension’s code ' +
          'is immutable — the same dependency D-27 created for the chart of accounts.',
        tags: [TAG],
        querystring: listWireQuerySchema,
        response: { 200: dimensionPageSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<DimensionPage> => {
      const { isActive, limit, cursor } = request.query;
      return listDimensions(
        {
          limit,
          ...(cursor === undefined ? {} : { cursor }),
          ...(isActive === undefined ? {} : { isActive }),
        },
        getContext(),
      );
    },
  );

  app.get(
    '/v1/dimensions/:dimensionId',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getDimension',
        summary: 'One dimension',
        tags: [TAG],
        params: dimensionParamsSchema,
        response: { 200: dimensionSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<Dimension> => getDimension(request.params.dimensionId, getContext()),
  );

  app.patch(
    '/v1/dimensions/:dimensionId',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'updateDimension',
        summary: 'Rename a dimension',
        description:
          'Rename, and nothing else. `code` is immutable and `isActive` belongs to the archive ' +
          'routes, so sending either is a `validation_failed` naming the field.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: dimensionParamsSchema,
        body: updateDimensionRequestSchema,
        response: { 200: dimensionSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { dimensionId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'updateDimension',
          request: { dimensionId, patch: request.body },
          successStatus: 200,
        },
        () => updateDimension(dimensionId, request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<Dimension>(result));
    },
  );

  for (const route of [
    {
      path: '/v1/dimensions/:dimensionId/archive',
      operationId: 'archiveDimension',
      summary: 'Archive a dimension',
      description:
        'An archived axis keeps every tag its values carry and every report they slice; it is ' +
        'offered for nothing new — no new values, and no new tags on a line. Idempotent.',
      run: archiveDimension,
    },
    {
      path: '/v1/dimensions/:dimensionId/unarchive',
      operationId: 'unarchiveDimension',
      summary: 'Unarchive a dimension',
      description: 'The counterpart, so that archiving is not a one-way door.',
      run: unarchiveDimension,
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
          params: dimensionParamsSchema,
          response: { 200: dimensionSchema, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        const ctx = getContext();
        const { dimensionId } = request.params;
        const result = await withIdempotency(
          { endpoint: route.operationId, request: { dimensionId }, successStatus: 200 },
          () => route.run(dimensionId, ctx),
        );

        return reply.status(result.status).send(idempotentBody<Dimension>(result));
      },
    );
  }

  app.delete(
    '/v1/dimensions/:dimensionId',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'deleteDimension',
        summary: 'Delete a dimension that has no values',
        description:
          'An axis with values answers `precondition_failed` with `dimension_has_values`: ' +
          'deleting it would take the values reports are grouped by with it, without naming ' +
          'them. Delete the values first, or archive the axis. Deleting is also how an org that ' +
          'has reached the eight-axis bound frees a slot — archiving is not, because an archived ' +
          'axis still costs what the bound is counting.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: dimensionParamsSchema,
        response: { 204: noContentSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { dimensionId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'deleteDimension', request: { dimensionId }, successStatus: 204 },
        () => deleteDimension(dimensionId, ctx),
      );

      return reply.status(result.status).send(idempotentBody<null>(result));
    },
  );

  app.post(
    '/v1/dimensions/:dimensionId/values',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'createDimensionValue',
        summary: 'Add a value to a dimension',
        description:
          'The axis must not be archived — an archived one is offered for nothing new, and ' +
          'answers `dimension_archived`. `code` is unique within the axis and immutable.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: dimensionParamsSchema,
        body: createDimensionValueRequestSchema,
        response: { 201: dimensionValueSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { dimensionId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'createDimensionValue',
          request: { dimensionId, value: request.body },
          successStatus: 201,
        },
        () => createDimensionValue(dimensionId, request.body, ctx),
      );

      const value = idempotentBody<DimensionValue>(result);
      return reply
        .status(result.status)
        .header('location', `/v1/dimension-values/${value.id}`)
        .send(value);
    },
  );

  app.get(
    '/v1/dimensions/:dimensionId/values',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listDimensionValues',
        summary: 'List one dimension’s values',
        description: 'One page, in `code` order, which is likewise immutable and therefore safe.',
        tags: [TAG],
        params: dimensionParamsSchema,
        querystring: listWireQuerySchema,
        response: { 200: dimensionValuePageSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<DimensionValuePage> => {
      const { isActive, limit, cursor } = request.query;
      return listDimensionValues(
        request.params.dimensionId,
        {
          limit,
          ...(cursor === undefined ? {} : { cursor }),
          ...(isActive === undefined ? {} : { isActive }),
        },
        getContext(),
      );
    },
  );

  app.get(
    '/v1/dimension-values/:valueId',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getDimensionValue',
        summary: 'One dimension value',
        description: 'A value names its own axis, so the axis is not part of the path.',
        tags: [TAG],
        params: dimensionValueParamsSchema,
        response: { 200: dimensionValueSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<DimensionValue> =>
      getDimensionValue(request.params.valueId, getContext()),
  );

  app.patch(
    '/v1/dimension-values/:valueId',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'updateDimensionValue',
        summary: 'Rename a dimension value',
        description:
          '`name` is the only mutable field a value has, so it is required rather than optional.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: dimensionValueParamsSchema,
        body: updateDimensionValueRequestSchema,
        response: { 200: dimensionValueSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { valueId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'updateDimensionValue',
          request: { valueId, patch: request.body },
          successStatus: 200,
        },
        () => updateDimensionValue(valueId, request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<DimensionValue>(result));
    },
  );

  for (const route of [
    {
      path: '/v1/dimension-values/:valueId/archive',
      operationId: 'archiveDimensionValue',
      summary: 'Archive a dimension value',
      description:
        'An archived value keeps every line already tagged with it and cannot be chosen for a ' +
        'new tag. This is the only removal available to a value journal lines carry.',
      run: archiveDimensionValue,
    },
    {
      path: '/v1/dimension-values/:valueId/unarchive',
      operationId: 'unarchiveDimensionValue',
      summary: 'Unarchive a dimension value',
      description:
        'The counterpart. Refused while the axis itself is archived (`dimension_archived`) — a ' +
        'live value on a dead axis is a value nothing can be tagged with anyway.',
      run: unarchiveDimensionValue,
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
          params: dimensionValueParamsSchema,
          response: { 200: dimensionValueSchema, ...ERROR_RESPONSES },
        },
      },
      async (request, reply) => {
        const ctx = getContext();
        const { valueId } = request.params;
        const result = await withIdempotency(
          { endpoint: route.operationId, request: { valueId }, successStatus: 200 },
          () => route.run(valueId, ctx),
        );

        return reply.status(result.status).send(idempotentBody<DimensionValue>(result));
      },
    );
  }

  app.delete(
    '/v1/dimension-values/:valueId',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'deleteDimensionValue',
        summary: 'Delete a dimension value nothing carries',
        description:
          'A value any journal line or draft line carries answers `precondition_failed` with ' +
          '`dimension_value_in_use`. Deleting one would restate every sliced report ever run ' +
          'without moving a single amount — dangerous precisely because the trial balance would ' +
          'not change. Archive it instead.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: dimensionValueParamsSchema,
        response: { 204: noContentSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { valueId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'deleteDimensionValue', request: { valueId }, successStatus: 204 },
        () => deleteDimensionValue(valueId, ctx),
      );

      return reply.status(result.status).send(idempotentBody<null>(result));
    },
  );
}
