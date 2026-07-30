import {
  FIXED_ASSET_STATUSES,
  createFixedAssetRequestSchema,
  disposeFixedAssetRequestSchema,
  fixedAssetPageSchema,
  fixedAssetScheduleSchema,
  fixedAssetSchema,
  pageCursorSchema,
  updateFixedAssetRequestSchema,
} from '@openbooks/shared-types';
import type { FixedAsset, FixedAssetPage, FixedAssetSchedule } from '@openbooks/shared-types';
import { z } from 'zod';

import { getContext } from '../../context';
import {
  disposeFixedAsset,
  getFixedAsset,
  getFixedAssetSchedule,
  listFixedAssets,
  registerFixedAsset,
  updateFixedAsset,
} from '../../modules/fixed-assets';
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
 * `/v1/fixed-assets` — the fixed-asset register, its depreciation schedule, and
 * disposal (OB-167, transport for `modules/fixed-assets`).
 *
 * Handlers map arguments and hold no logic (spec §2.4): the depreciation schedule is
 * computed in `depreciation.ts`, the daily sweep that posts a due period lives in
 * `depreciation-sweep.ts` and reaches the repository directly under
 * `runAsAutomation` — never through HTTP — and every refusal (a wrong-typed account,
 * a change to a posted period, a second disposal) is the service's, not this file's.
 *
 * ## The schedule is its own route, not a field on the asset
 *
 * `fixedAssetSchema` carries no `lines`-shaped schedule array, unlike a recurring
 * journal template's `lines`: a template's lines are fixed at authoring and posted
 * verbatim, while a fixed asset's schedule can run to hundreds of monthly rows and is
 * mostly read once, at registration, to confirm the numbers rather than on every
 * fetch of the asset. `GET …/schedule` is the one place a caller pays for computing
 * or reading every row.
 *
 * ## Disposal is `POST`, not `DELETE`, and it is not reachable through `PATCH`
 *
 * `fixed-assets.ts`'s own header calls disposal D-116's one-way status change —
 * exactly the shape `deactivateAccount` and `deactivateRecurringInvoiceTemplate`
 * already take on this surface, so it gets the same `POST …/dispose` rather than a
 * `status` field a `PATCH` could set. Unlike a deactivation, though, disposing posts
 * a journal, so idempotency here answers the same question it answers for
 * `approveInvoice`: a double-clicked dispose replays the first disposal's journal
 * rather than posting a second removal of the same asset — the service's own
 * `fixed_asset_already_disposed` guard is the belt to this belt-and-suspenders.
 */

const TAG = 'fixed-assets';

const fixedAssetParamsSchema = z.strictObject({ fixedAssetId: z.uuid() });

/**
 * Local and carrying no `id`, `listAccountsWireQuerySchema`'s reason: a querystring
 * is emitted as individual `parameters`, so a component for one would be referenced
 * by nothing.
 */
const listFixedAssetsWireQuerySchema = z.strictObject({
  status: z.enum(FIXED_ASSET_STATUSES).optional(),
  limit: pageLimitQuery('fixed assets'),
  cursor: pageCursorSchema.optional(),
});

export function registerFixedAssetRoutes(app: App): void {
  app.post(
    '/v1/fixed-assets',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'registerFixedAsset',
        summary: 'Register a fixed asset',
        description:
          'Cost, salvage, method, life and in-service date (OB-163, OB-164). Registration ' +
          'computes the whole depreciation schedule from these five fields and nothing else — ' +
          'the schedule itself is never supplied, fetched separately through ' +
          '`getFixedAssetSchedule`.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        body: createFixedAssetRequestSchema,
        response: { 201: fixedAssetSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const result = await withIdempotency(
        { endpoint: 'registerFixedAsset', request: request.body, successStatus: 201 },
        () => registerFixedAsset(request.body, ctx),
      );

      const asset = idempotentBody<FixedAsset>(result);
      return reply
        .status(result.status)
        .header('location', `/v1/fixed-assets/${asset.id}`)
        .send(asset);
    },
  );

  app.get(
    '/v1/fixed-assets',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listFixedAssets',
        summary: 'List the fixed-asset register',
        description: 'One page of the register, ordered by `(created_at, id)`, oldest first.',
        tags: [TAG],
        querystring: listFixedAssetsWireQuerySchema,
        response: { 200: fixedAssetPageSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<FixedAssetPage> => {
      const { status, limit, cursor } = request.query;
      return listFixedAssets(
        {
          limit,
          ...(cursor === undefined ? {} : { cursor }),
          ...(status === undefined ? {} : { status }),
        },
        getContext(),
      );
    },
  );

  app.get(
    '/v1/fixed-assets/:fixedAssetId',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getFixedAsset',
        summary: 'One registered fixed asset',
        tags: [TAG],
        params: fixedAssetParamsSchema,
        response: { 200: fixedAssetSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<FixedAsset> =>
      getFixedAsset(request.params.fixedAssetId, getContext()),
  );

  app.get(
    '/v1/fixed-assets/:fixedAssetId/schedule',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'getFixedAssetSchedule',
        summary: 'A fixed asset’s whole depreciation schedule',
        description:
          'Every period, ordered by `periodIndex` (OB-164). `postedJournalId` is null on a ' +
          'period still due and set once the daily sweep posts it (D-113); a set value is ' +
          'permanent — a posted period is never reopened.',
        tags: [TAG],
        params: fixedAssetParamsSchema,
        response: { 200: fixedAssetScheduleSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<FixedAssetSchedule> =>
      getFixedAssetSchedule(request.params.fixedAssetId, getContext()),
  );

  app.patch(
    '/v1/fixed-assets/:fixedAssetId',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'updateFixedAsset',
        summary: 'Edit a fixed asset',
        description:
          'Account repointing and `name`/`description` are always accepted. Changing anything ' +
          'the schedule was computed from — `method`, `salvageValueMinor`, `usefulLifeMonths`, ' +
          '`decliningRatePpm`, `acquisitionCostMinor` or `inServiceDate` — is accepted only while ' +
          'no period has posted; once one has, this is refused with ' +
          '`fixed_asset_has_posted_depreciation` rather than silently re-forecasting periods ' +
          'that already posted under the old numbers (ROADMAP: no mid-life re-forecast in v1).',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: fixedAssetParamsSchema,
        body: updateFixedAssetRequestSchema,
        response: { 200: fixedAssetSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { fixedAssetId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'updateFixedAsset',
          request: { fixedAssetId, patch: request.body },
          successStatus: 200,
        },
        () => updateFixedAsset(fixedAssetId, request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<FixedAsset>(result));
    },
  );

  app.post(
    '/v1/fixed-assets/:fixedAssetId/dispose',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'disposeFixedAsset',
        summary: 'Dispose of a fixed asset',
        description:
          'Full disposal only (D-116): a fresh journal recognises the gain or loss against ' +
          'proceeds, the asset moves to `disposed`, and its remaining unposted schedule rows ' +
          'are discarded. There is no reversal of depreciation already posted, and a ' +
          'second dispose of an already-disposed asset is refused with ' +
          '`fixed_asset_already_disposed` rather than posting a second removal.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: fixedAssetParamsSchema,
        body: disposeFixedAssetRequestSchema,
        response: { 200: fixedAssetSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { fixedAssetId } = request.params;
      const result = await withIdempotency(
        {
          endpoint: 'disposeFixedAsset',
          request: { fixedAssetId, dispose: request.body },
          successStatus: 200,
        },
        () => disposeFixedAsset(fixedAssetId, request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<FixedAsset>(result));
    },
  );
}
