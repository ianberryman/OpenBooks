import type { ExternalRef, ExternalRefEntityType } from '@openbooks/shared-types';

import type { RequestContext } from '../../context';
import type { KeysetOrdering, KeysetPage, TenantDatabase } from '../../db';
import {
  applyKeyset,
  bufferToUuid,
  instantKey,
  newUuidBuffer,
  orgScope as toOrgId,
  tenantDb,
  toKeysetPage,
  uuidKey,
} from '../../db';
import { InternalError } from '../../errors';

/**
 * Data access for `external_refs` (OB-102; ROADMAP D-58, migration `0010_platform`).
 *
 * Everything goes through `tenantDb`, so `org_id = ctx.orgId` is on every
 * statement before this file adds a predicate — the same A7 argument
 * `dimensions.repository.ts` makes.
 *
 * `entity_id` is carried as opaque `BINARY(16)` throughout and never checked
 * against the table `entity_type` names. That is deliberate, not an omission:
 * `0010_platform.ts`'s migration comment says `entity_id` is not a foreign key
 * because `entity_type` names *which* OpenBooks table it points into, a fact only
 * that table's own service could resolve — coupling this correlation map to every
 * other module for a check the integrator is already asserting would be exactly
 * the dependency the schema chose not to take. See `createExternalRef` in the
 * service for where that is restated at the call site.
 */

/** The resource token an unknown or cross-org ref reports (A7). */
export const EXTERNAL_REF_RESOURCE = 'external_ref';

const EXTERNAL_REF_COLUMNS = [
  'id',
  'external_system',
  'entity_type',
  'external_id',
  'entity_id',
  'created_at',
  'updated_at',
] as const;

export interface ExternalRefRow {
  readonly id: Buffer;
  readonly external_system: string;
  readonly entity_type: string;
  readonly external_id: string;
  readonly entity_id: Buffer;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface NewExternalRefRow {
  readonly externalSystem: string;
  readonly entityType: ExternalRefEntityType;
  readonly externalId: string;
  readonly entityId: Buffer;
}

/** Every filter the query schema offers (`platform/external-refs.ts`), all optional. */
export interface ExternalRefFilters {
  readonly externalSystem?: string | undefined;
  readonly entityType?: ExternalRefEntityType | undefined;
  readonly externalId?: string | undefined;
  readonly cursor?: string | undefined;
}

export function orgScope(ctx: RequestContext): TenantDatabase {
  return tenantDb(toOrgId(ctx.orgId));
}

/**
 * Resolves `(external_system, entity_type, external_id)` to its row —
 * `uq_external_refs_external`, and the direction a bulk importer asks in most:
 * "I already know this row by my own id, do I have to create it."
 */
export async function selectExternalRefByExternalIdentity(
  db: TenantDatabase,
  externalSystem: string,
  entityType: string,
  externalId: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<ExternalRefRow | undefined> {
  const query = db
    .selectFrom('external_refs')
    .select(EXTERNAL_REF_COLUMNS)
    .where('external_system', '=', externalSystem)
    .where('entity_type', '=', entityType)
    .where('external_id', '=', externalId);
  // A locking read for the post-duplicate recovery only: under REPEATABLE READ a plain
  // re-read sees the transaction's snapshot, which predates the racing row's commit, so it
  // would miss the very row that just rejected the insert. `FOR UPDATE` is a current read —
  // it sees the latest committed version — and `external_refs` is mutable, so it holds the
  // grant a locking read needs (unlike `journals`, D-14).
  return (options.forUpdate ? query.forUpdate() : query).executeTakeFirst();
}

/**
 * The other half of D-58's both-ways uniqueness — `uq_external_refs_entity`:
 * whether this entity already carries a *different* external id under this system
 * and type.
 */
export async function selectExternalRefByEntityIdentity(
  db: TenantDatabase,
  externalSystem: string,
  entityType: string,
  entityId: Buffer,
  options: { readonly forUpdate?: boolean } = {},
): Promise<ExternalRefRow | undefined> {
  const query = db
    .selectFrom('external_refs')
    .select(EXTERNAL_REF_COLUMNS)
    .where('external_system', '=', externalSystem)
    .where('entity_type', '=', entityType)
    .where('entity_id', '=', entityId);
  // See `selectExternalRefByExternalIdentity` — the recovery re-read locks so it sees the
  // row a concurrent commit just created.
  return (options.forUpdate ? query.forUpdate() : query).executeTakeFirst();
}

export async function selectExternalRefById(
  db: TenantDatabase,
  id: Buffer,
): Promise<ExternalRefRow | undefined> {
  return db
    .selectFrom('external_refs')
    .select(EXTERNAL_REF_COLUMNS)
    .where('id', '=', id)
    .executeTakeFirst();
}

/**
 * Inserts a new correlation. No duplicate-key translation here, unlike
 * `insertDimension` — this table carries *two* unique constraints
 * (`uq_external_refs_external`, `uq_external_refs_entity`) and mysql2's errno
 * cannot say which one refused, so there is no single message this function could
 * produce. `createExternalRef` in the service is what tells them apart, by
 * re-running the same two reads its caller already ran before this insert was
 * attempted — see `resolveExistingOrConflict` there.
 */
export async function insertExternalRef(
  db: TenantDatabase,
  input: NewExternalRefRow,
): Promise<ExternalRefRow> {
  const id = newUuidBuffer();

  await db
    .insertInto('external_refs')
    .values({
      id,
      external_system: input.externalSystem,
      entity_type: input.entityType,
      external_id: input.externalId,
      entity_id: input.entityId,
    })
    .execute();

  const row = await selectExternalRefById(db, id);
  if (row === undefined) {
    throw new InternalError('The external ref inserted by this statement could not be read back.');
  }
  return row;
}

/**
 * `(created_at, id)`, matching every other keyset in this codebase that has no
 * immutable business key to order by (`keyset.ts`'s file header; `api_keys`,
 * `contacts`, `tax_rates` all make the same choice). `external_id` cannot serve —
 * it is unique only within `(external_system, entity_type)`, not across the org.
 */
const EXTERNAL_REF_KEYSET: KeysetOrdering<ExternalRefRow> = [
  instantKey('external_refs.created_at', (row) => row.created_at),
  uuidKey('external_refs.id', (row) => row.id),
];

export async function selectExternalRefsPage(
  db: TenantDatabase,
  filters: ExternalRefFilters,
  limit: number,
): Promise<KeysetPage<ExternalRefRow>> {
  let query = db.selectFrom('external_refs').select(EXTERNAL_REF_COLUMNS);

  if (filters.externalSystem !== undefined) {
    query = query.where('external_system', '=', filters.externalSystem);
  }
  if (filters.entityType !== undefined) {
    query = query.where('entity_type', '=', filters.entityType);
  }
  if (filters.externalId !== undefined) {
    query = query.where('external_id', '=', filters.externalId);
  }

  const rows = await applyKeyset(query, EXTERNAL_REF_KEYSET, limit, filters.cursor).execute();
  return toKeysetPage(rows, EXTERNAL_REF_KEYSET, limit);
}

/**
 * `entity_type` is cast rather than validated on the way out: the only values
 * ever written are the ones `createExternalRefRequestSchema` already checked
 * against `EXTERNAL_REF_ENTITY_TYPES` on the way in, so a row that exists is a
 * row whose `entity_type` is a member of the union. The column itself is a plain
 * `VARCHAR(40)` (not a MySQL `ENUM`), so the generated row type is `string` and
 * the narrowing has to happen here rather than falling out of codegen.
 */
export function toExternalRef(row: ExternalRefRow): ExternalRef {
  return {
    id: bufferToUuid(row.id),
    externalSystem: row.external_system,
    entityType: row.entity_type as ExternalRefEntityType,
    externalId: row.external_id,
    entityId: bufferToUuid(row.entity_id),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
