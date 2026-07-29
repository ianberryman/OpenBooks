import { z } from 'zod';

import { pageQueryShape } from '../wire';

/**
 * `external_refs` (OB-097; ROADMAP D-58) — an integrator's own id mapped to an OpenBooks
 * entity, unique both ways, so a create carrying a known ref returns the existing entity
 * rather than duplicating. D-04's idempotency lifted from a one-shot `Idempotency-Key` to a
 * durable external identity: what a weekly-running importer needs and a per-request key
 * cannot give it.
 *
 * `.meta({ id })` (OB-104) on the request, entity, and page shapes, now that
 * `/v1/external-refs` gives them a route. `externalRefQuerySchema` stays un-ided — a
 * querystring is emitted as individual `parameters`, so a component for it would be
 * $ref'd by nothing.
 */

export const EXTERNAL_REF_ENTITY_TYPES = [
  'account',
  'contact',
  'invoice',
  'credit_note',
  'bill',
  'vendor_credit',
  'payment',
  'journal',
] as const;

export type ExternalRefEntityType = (typeof EXTERNAL_REF_ENTITY_TYPES)[number];

export const externalRefEntityTypeSchema = z.enum(EXTERNAL_REF_ENTITY_TYPES);

const EXTERNAL_SYSTEM_MAX_LENGTH = 80;
const EXTERNAL_ID_MAX_LENGTH = 255;

/**
 * Creates a correlation. Idempotent by construction (D-58): a create naming a
 * `(externalSystem, externalId)` pair already on file returns the existing entity rather
 * than a `conflict` — a re-run importer needs this to be safe to repeat, not an error to
 * catch.
 */
export const createExternalRefRequestSchema = z
  .strictObject({
    externalSystem: z.string().trim().min(1).max(EXTERNAL_SYSTEM_MAX_LENGTH).meta({
      description: 'The integrator’s own name for itself, e.g. `quickbooks` or `shopify`.',
    }),
    entityType: externalRefEntityTypeSchema,
    externalId: z.string().trim().min(1).max(EXTERNAL_ID_MAX_LENGTH).meta({
      description: 'The record’s id in the external system.',
    }),
    entityId: z.uuid().meta({
      description: 'The OpenBooks entity this external id names.',
    }),
  })
  .meta({
    id: 'CreateExternalRefRequest',
    description:
      'Creates a correlation, idempotent by external identity (D-58): a create naming a ' +
      'pair already on file returns the existing entity rather than a conflict.',
  });

export type CreateExternalRefRequest = z.infer<typeof createExternalRefRequestSchema>;

/**
 * A correlation as the API returns it. Unique on `(orgId, externalSystem, externalId)`
 * and on `(orgId, externalSystem, entityType, entityId)` (D-58) — one external id names
 * one entity and one entity has one external id per system, so either direction resolves
 * without ambiguity.
 */
export const externalRefSchema = z
  .strictObject({
    id: z.uuid(),
    externalSystem: z.string(),
    entityType: externalRefEntityTypeSchema,
    externalId: z.string(),
    entityId: z.uuid(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime().meta({
      description:
        'Set when a ref is re-pointed to a different entity — the map is mutable for that ' +
        'case (D-58), but never silent: an append-only ref history is out of M5.',
    }),
  })
  .meta({
    id: 'ExternalRef',
    description:
      'A correlation between an integrator’s own id and an OpenBooks entity, unique both ' +
      'ways (D-58).',
  });

export type ExternalRef = z.infer<typeof externalRefSchema>;

/**
 * Every filter optional — a caller narrows by system, by type, by external id, or by any
 * combination, the same shape a correlation lookup from either direction needs.
 */
export const externalRefQuerySchema = z.strictObject({
  ...pageQueryShape,
  externalSystem: z.string().optional(),
  entityType: externalRefEntityTypeSchema.optional(),
  externalId: z.string().optional(),
});

/** The *input* type: `limit` carries a `.default()`, so parsed output differs. */
export type ExternalRefQuery = z.input<typeof externalRefQuerySchema>;

/**
 * Local and inline rather than through `pageSchema` — `oauth.ts`'s `oauthClientPageSchema`
 * reasoning applied here too.
 */
export const externalRefPageSchema = z
  .strictObject({
    items: z.array(externalRefSchema),
    nextCursor: z.string().nullable(),
  })
  .meta({
    id: 'ExternalRefPage',
    description: 'One page of the org’s external-id correlations.',
  });

export type ExternalRefPage = z.infer<typeof externalRefPageSchema>;
