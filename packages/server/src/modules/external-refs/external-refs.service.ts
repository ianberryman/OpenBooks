import type {
  CreateExternalRefRequest,
  ExternalRef,
  ExternalRefEntityType,
  ExternalRefPage,
  ExternalRefQuery,
} from '@openbooks/shared-types';
import { createExternalRefRequestSchema, externalRefQuerySchema } from '@openbooks/shared-types';

import type { RequestContext } from '../../context';
import type { TenantDatabase } from '../../db';
import { isDuplicateEntryError, resolvePageLimit, uuidToBuffer } from '../../db';
import type { ValidationIssue } from '../../errors';
import {
  assertFound,
  ConflictError,
  InternalError,
  parseInput,
  ValidationError,
} from '../../errors';
import { requirePermission } from '../permissions';
import type { ExternalRefRow } from './external-refs.repository';
import {
  EXTERNAL_REF_RESOURCE,
  insertExternalRef,
  orgScope,
  selectExternalRefByEntityIdentity,
  selectExternalRefByExternalIdentity,
  selectExternalRefsPage,
  toExternalRef,
} from './external-refs.repository';

/**
 * The `external_refs` correlation map (OB-102; ROADMAP D-58) — an integrator's own
 * id resolved to an OpenBooks entity, unique both ways, so a create carrying a
 * known ref returns the existing entity rather than duplicating. D-04's
 * idempotency lifted from a one-shot `Idempotency-Key` to a durable external
 * identity: what a weekly-running importer needs and a per-request key cannot
 * give it. Read `index.ts` for the surface; no routes live here (OB-104).
 *
 * Two things are uniform across every operation below, matching
 * `dimensions.service.ts`:
 *
 * 1. **`requirePermission` runs first**, before the payload is parsed.
 * 2. **A miss is `assertFound`**, never a hand-written throw — `tenantDb` has
 *    already confined every read to the context's org, so a cross-org identity
 *    and a nonexistent one reach the same line (A7).
 *
 * `entity_id` is never checked against `entity_type`. This module is a
 * correlation record, not a foreign key: `0010_platform.ts`'s migration comment
 * explains why the schema deliberately left it unconstrained, and validating it
 * here would couple this seam to every other module for a check the integrator
 * is already asserting by calling this endpoint at all.
 */

/**
 * Creates a correlation, idempotent by external identity (D-58).
 *
 * `uq_external_refs_external` and `uq_external_refs_entity` make the mapping
 * unique in both directions, and this function draws the line the schema cannot:
 * a create repeating an identity it already holds is a retry and succeeds
 * silently; a create whose identity collides with a *different* mapping is
 * refused loudly, because D-58 permits re-pointing a ref but never permits it to
 * happen without the caller asking for it by name — which this endpoint does not
 * offer (a dedicated re-point operation, if one is ever needed, is a different
 * ticket).
 *
 * `resolveExistingOrConflict` runs once before the insert (the common path, no
 * transaction needed) and once more only if the insert then loses a race to a
 * row committed in between — `isDuplicateEntryError` is the signal, and MySQL's
 * unique indexes are the real guarantee here exactly as `runClaimed` in the
 * idempotency module states for its own claim row. Both calls share one function
 * so the two paths cannot drift into disagreeing about what counts as a conflict.
 */
export async function createExternalRef(
  input: CreateExternalRefRequest,
  ctx: RequestContext,
): Promise<ExternalRef> {
  await requirePermission(ctx, 'integrations.write');
  const request = parseInput(createExternalRefRequestSchema, input);
  // `request.entityId` is `z.uuid()`-validated by the schema above, so this is a
  // shape conversion and not a trust decision.
  const entityId = uuidToBuffer(request.entityId);
  const db = orgScope(ctx);

  const existing = await resolveExistingOrConflict(db, request, entityId);
  if (existing !== undefined) return toExternalRef(existing);

  try {
    const row = await insertExternalRef(db, {
      externalSystem: request.externalSystem,
      entityType: request.entityType,
      externalId: request.externalId,
      entityId,
    });
    return toExternalRef(row);
  } catch (error) {
    if (!isDuplicateEntryError(error)) throw error;

    // Lost the race between the pre-check above and this insert: something else
    // committed the colliding row in the meantime. Re-running the same
    // resolution either returns it as the idempotent read D-58 promises, or
    // raises the same conflict a sequential caller would have seen — the race is
    // invisible to the caller rather than a different failure, the same property
    // `deleteDimensionRow` gives errno 1451.
    const raced = await resolveExistingOrConflict(db, request, entityId, { forUpdate: true });
    if (raced !== undefined) return toExternalRef(raced);

    throw new InternalError(
      'external_refs rejected a duplicate insert but neither uq_external_refs_external nor ' +
        'uq_external_refs_entity resolved to a row on re-read. Those are the only two unique ' +
        'constraints on this table, so this statement should be unreachable.',
    );
  }
}

/**
 * Resolves `request`'s identity against both of `external_refs`'s unique keys.
 *
 * Returns the row when the create is a retry (same external identity, same
 * entity), throws a `ConflictError` when either half of D-58's both-ways
 * uniqueness would be violated by a *different* mapping, and returns `undefined`
 * when the identity is genuinely new and safe to insert.
 */
async function resolveExistingOrConflict(
  db: TenantDatabase,
  request: CreateExternalRefRequest,
  entityId: Buffer,
  options: { readonly forUpdate?: boolean } = {},
): Promise<ExternalRefRow | undefined> {
  const byExternalIdentity = await selectExternalRefByExternalIdentity(
    db,
    request.externalSystem,
    request.entityType,
    request.externalId,
    options,
  );
  if (byExternalIdentity !== undefined) {
    if (byExternalIdentity.entity_id.equals(entityId)) return byExternalIdentity;
    throw externalRefRepointedError(request);
  }

  const byEntityIdentity = await selectExternalRefByEntityIdentity(
    db,
    request.externalSystem,
    request.entityType,
    entityId,
    options,
  );
  if (byEntityIdentity !== undefined) {
    throw externalRefEntityAlreadyMappedError(request, byEntityIdentity);
  }

  return undefined;
}

/**
 * `uq_external_refs_external` as a `ConflictError`: the external id this create
 * named is already on file, mapped to a different entity than the one this
 * request asked for.
 *
 * Free text is permitted here, unlike on `NotFoundError` — the colliding row is
 * inside the caller's own org by construction (`tenantDb`), so naming it
 * discloses nothing they cannot already read, the same argument
 * `translateDuplicateDimensionCode` makes.
 */
function externalRefRepointedError(request: CreateExternalRefRequest): ConflictError {
  return new ConflictError(
    `The external id ${JSON.stringify(request.externalId)} from ` +
      `${JSON.stringify(request.externalSystem)} is already mapped to a different ` +
      `${request.entityType} in this organization. A create carrying a known external id ` +
      'returns the entity it is already mapped to (D-58) — it never silently re-points that ' +
      'mapping to a different one. If the upstream record genuinely moved, that is a ' +
      'deliberate re-point and not a retry of this create.',
    {
      externalSystem: request.externalSystem,
      entityType: request.entityType,
      externalId: request.externalId,
    },
  );
}

/**
 * `uq_external_refs_entity` as a `ConflictError`: the entity this create named
 * already carries a different external id under the same system and type.
 */
function externalRefEntityAlreadyMappedError(
  request: CreateExternalRefRequest,
  existing: ExternalRefRow,
): ConflictError {
  return new ConflictError(
    `This ${request.entityType} already carries a different external id ` +
      `(${JSON.stringify(existing.external_id)}) under ` +
      `${JSON.stringify(request.externalSystem)}. uq_external_refs_entity makes the mapping ` +
      'unique in both directions (D-58): one entity holds at most one external id per system, ' +
      'so mapping a second one to it here would leave the two rows disagreeing about which is ' +
      'current.',
    {
      externalSystem: request.externalSystem,
      entityType: request.entityType,
      entityId: request.entityId,
    },
  );
}

/**
 * Resolves external id → OpenBooks entity (D-58's reverse direction): the shape
 * a caller who only has the upstream id needs before it can address the entity
 * through any other endpoint.
 *
 * 404, never 403, on a miss — the same A7 guarantee every other lookup in this
 * codebase gives, and for the same reason: `tenantDb` has already confined the
 * read to this org, so a ref belonging to another org is indistinguishable from
 * one that was never created.
 */
export async function lookupExternalRef(
  query: ExternalRefQuery,
  ctx: RequestContext,
): Promise<ExternalRef> {
  await requirePermission(ctx, 'integrations.read');
  const filters = parseInput(externalRefQuerySchema, query);
  const identity = requireExternalIdentity(filters);

  const db = orgScope(ctx);
  const row = await selectExternalRefByExternalIdentity(
    db,
    identity.externalSystem,
    identity.entityType,
    identity.externalId,
  );

  return toExternalRef(assertFound(row, EXTERNAL_REF_RESOURCE));
}

/**
 * One page of the org's correlations, optionally narrowed by any combination of
 * `externalSystem`, `entityType`, and `externalId` — `externalRefQuerySchema`'s
 * own comment states this is the same shape a lookup from either direction
 * needs, so every filter it offers is honoured here rather than only the ones a
 * first caller happened to need.
 */
export async function listExternalRefs(
  query: ExternalRefQuery,
  ctx: RequestContext,
): Promise<ExternalRefPage> {
  await requirePermission(ctx, 'integrations.read');
  const filters = parseInput(externalRefQuerySchema, query);
  const limit = resolvePageLimit(filters.limit);

  const page = await selectExternalRefsPage(orgScope(ctx), filters, limit);
  return { items: page.rows.map(toExternalRef), nextCursor: page.nextCursor };
}

interface ExternalIdentity {
  readonly externalSystem: string;
  readonly entityType: ExternalRefEntityType;
  readonly externalId: string;
}

/**
 * A point lookup needs all three identity fields — `externalRefQuerySchema`
 * makes every filter optional because the same schema also serves `listExternalRefs`,
 * so this is where "resolve one ref" enforces the fuller requirement `lookupExternalRef`
 * actually has. A `ValidationError` naming whichever fields are missing, not a 404:
 * an incomplete identity is a malformed request, not a miss.
 */
function requireExternalIdentity(filters: {
  readonly externalSystem?: string | undefined;
  readonly entityType?: ExternalRefEntityType | undefined;
  readonly externalId?: string | undefined;
}): ExternalIdentity {
  const issues: ValidationIssue[] = [];
  const requiredMessage = 'Required to resolve a ref by external identity.';
  if (filters.externalSystem === undefined) {
    issues.push({ path: 'externalSystem', message: requiredMessage });
  }
  if (filters.entityType === undefined) {
    issues.push({ path: 'entityType', message: requiredMessage });
  }
  if (filters.externalId === undefined) {
    issues.push({ path: 'externalId', message: requiredMessage });
  }
  if (issues.length > 0) {
    throw new ValidationError(
      'lookupExternalRef resolves one ref and needs the full external identity: externalSystem, ' +
        'entityType, and externalId together.',
      issues,
    );
  }

  return {
    externalSystem: filters.externalSystem as string,
    entityType: filters.entityType as ExternalRefEntityType,
    externalId: filters.externalId as string,
  };
}
