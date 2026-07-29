import {
  createExternalRefRequestSchema,
  externalRefEntityTypeSchema,
  externalRefPageSchema,
  externalRefQuerySchema,
  externalRefSchema,
} from '@openbooks/shared-types';
import type { ExternalRef, ExternalRefPage } from '@openbooks/shared-types';
import { z } from 'zod';

import { getContext } from '../../context';
import {
  createExternalRef,
  listExternalRefs,
  lookupExternalRef,
} from '../../modules/external-refs';
import { withIdempotency } from '../../modules/idempotency';
import type { App } from '../types';
import {
  ERROR_RESPONSES,
  ORG_SCOPED_WRITE_HOOKS,
  idempotencyKeyHeaderSchema,
  idempotentBody,
  requireOrgScope,
} from './support';

/**
 * `/v1/external-refs` — the correlation map from an integrator's own id to an
 * OpenBooks entity, unique both ways (OB-102, OB-104; ROADMAP D-58).
 *
 * There is no id-addressed read on this resource at all —
 * `external-refs.service.ts`'s two directions are both keyed off the external
 * identity or the OpenBooks entity, never off the correlation row's own id, so
 * `GET .../lookup` is the only single-item read this surface offers, and it is a
 * point lookup by identity rather than a `:externalRefId` path.
 *
 * `lookupExternalRefWireQuerySchema` narrows `externalRefQuerySchema`'s three
 * identity fields to their own querystring rather than reusing the paged one:
 * `limit`/`cursor` mean nothing on a point lookup, and `lookupExternalRef`'s own
 * `requireExternalIdentity` is what enforces "all three together" — declaring
 * them optional here and letting the service refuse an incomplete identity
 * matches every other route in this directory's rule that validation logic lives
 * in exactly one place.
 */

const TAG = 'external-refs';

/** Local and carrying no `id`: a querystring is emitted as individual `parameters`. */
const lookupExternalRefWireQuerySchema = z.strictObject({
  externalSystem: z.string().optional(),
  entityType: externalRefEntityTypeSchema.optional(),
  externalId: z.string().optional(),
});

export function registerExternalRefRoutes(app: App): void {
  app.post(
    '/v1/external-refs',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'createExternalRef',
        summary: 'Create an external-id correlation',
        description:
          'Idempotent by external identity (D-58): a create naming a pair already on file ' +
          'returns the existing entity rather than a conflict. A create whose identity collides ' +
          'with a *different* mapping is refused loudly instead.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        body: createExternalRefRequestSchema,
        response: { 201: externalRefSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const result = await withIdempotency(
        { endpoint: 'createExternalRef', request: request.body, successStatus: 201 },
        () => createExternalRef(request.body, ctx),
      );

      const ref = idempotentBody<ExternalRef>(result);
      return reply
        .status(result.status)
        .header('location', `/v1/external-refs/${ref.id}`)
        .send(ref);
    },
  );

  app.get(
    '/v1/external-refs',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listExternalRefs',
        summary: 'List external-id correlations',
        description:
          'One page of the org’s correlations, optionally narrowed by any combination of ' +
          '`externalSystem`, `entityType`, and `externalId`.',
        tags: [TAG],
        querystring: externalRefQuerySchema,
        response: { 200: externalRefPageSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<ExternalRefPage> => listExternalRefs(request.query, getContext()),
  );

  app.get(
    '/v1/external-refs/lookup',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'lookupExternalRef',
        summary: 'Resolve one external-id correlation',
        description:
          'Resolves external id → OpenBooks entity (D-58’s reverse direction): the shape a ' +
          'caller who only has the upstream id needs before it can address the entity through ' +
          'any other endpoint. All three of `externalSystem`, `entityType`, and `externalId` ' +
          'are required together — a `validation_failed` names whichever are missing.',
        tags: [TAG],
        querystring: lookupExternalRefWireQuerySchema,
        response: { 200: externalRefSchema, ...ERROR_RESPONSES },
      },
    },
    async (request): Promise<ExternalRef> => lookupExternalRef(request.query, getContext()),
  );
}
