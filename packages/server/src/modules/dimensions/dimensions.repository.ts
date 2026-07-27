import type {
  Dimension,
  DimensionValue,
  ListDimensionValuesQuery,
  ListDimensionsQuery,
} from '@openbooks/shared-types';
import {
  DIMENSION_CODE_MAX_LENGTH,
  DIMENSION_VALUE_CODE_MAX_LENGTH,
} from '@openbooks/shared-types';

import type { RequestContext } from '../../context';
import type { KeysetOrdering, KeysetPage, TenantDatabase } from '../../db';
import {
  applyKeyset,
  bufferToUuid,
  isDuplicateEntryError,
  isStillReferencedError,
  newUuidBuffer,
  orgScope as toOrgId,
  tenantDb,
  textKey,
  toKeysetPage,
  tryUuidToBuffer,
  uuidKey,
} from '../../db';
import { ConflictError, InternalError, PreconditionFailedError } from '../../errors';

/**
 * Data access for the reporting axes and their values (OB-037).
 *
 * Everything here goes through `tenantDb`, so `org_id = ctx.orgId` is on every
 * statement before this file adds a predicate. That is what makes A7 a property of
 * the queries rather than of the service's care: a cross-org id matches nothing,
 * and the service's `assertFound` turns that into the one error a miss may
 * produce.
 *
 * The other job of this file is that no driver error escapes it. MySQL answers a
 * duplicate code with errno 1062 and a delete of a still-referenced row with errno
 * 1451; both are the client's situation rather than a fault, and both would
 * otherwise reach `toWireError` unrecognised and become an opaque 500.
 */

/**
 * The resource tokens every miss in this module reports (A7).
 *
 * Two of them and not one, because they are two kinds of thing a caller names
 * separately — the axis in a path, the value in a tag — and `NotFoundError`
 * carries the token as its only content. Neither token distinguishes a cross-org
 * row from a nonexistent one, which is the property that matters.
 */
export const DIMENSION_RESOURCE = 'dimension';
export const DIMENSION_VALUE_RESOURCE = 'dimension_value';

const DIMENSION_COLUMNS = [
  'id',
  'code',
  'name',
  'description',
  'is_active',
  'created_at',
  'updated_at',
] as const;

const DIMENSION_VALUE_COLUMNS = [
  'id',
  'dimension_id',
  'code',
  'name',
  'is_active',
  'created_at',
  'updated_at',
] as const;

export interface DimensionRow {
  readonly id: Buffer;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly is_active: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface DimensionValueRow {
  readonly id: Buffer;
  readonly dimension_id: Buffer;
  readonly code: string;
  readonly name: string;
  readonly is_active: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/** `code` is absent from both patches: a code is immutable once created. */
export interface DimensionPatch {
  readonly name?: string;
  readonly description?: string | null;
  readonly isActive?: boolean;
}

export interface DimensionValuePatch {
  readonly name?: string;
  readonly isActive?: boolean;
}

export function orgScope(ctx: RequestContext): TenantDatabase {
  return tenantDb(toOrgId(ctx.orgId));
}

/**
 * A client-supplied id as bytes, or `undefined` when it is not a UUID.
 *
 * Undefined rather than a throw, so the service routes a malformed id through
 * `assertFound` to the same 404 a nonexistent one produces. A 400 here would be a
 * distinguishable answer for a class of ids, which is the shape A7 rules out.
 */
export function dimensionIdBytes(id: string): Buffer | undefined {
  return tryUuidToBuffer(id);
}

export async function insertDimension(
  db: TenantDatabase,
  input: { readonly code: string; readonly name: string; readonly description: string | null },
): Promise<DimensionRow> {
  const id = newUuidBuffer();

  try {
    await db
      .insertInto('dimensions')
      .values({ id, code: input.code, name: input.name, description: input.description })
      .execute();
  } catch (error) {
    throw translateDuplicateDimensionCode(error, input.code);
  }

  const row = await selectDimensionById(db, id);
  if (row === undefined) {
    throw new InternalError('The dimension inserted by this statement could not be read back.');
  }
  return row;
}

export async function selectDimensionById(
  db: TenantDatabase,
  id: Buffer,
): Promise<DimensionRow | undefined> {
  return db
    .selectFrom('dimensions')
    .select(DIMENSION_COLUMNS)
    .where('id', '=', id)
    .executeTakeFirst();
}

/**
 * The same read, taking an exclusive row lock.
 *
 * Used wherever a check has to survive a concurrent writer: the delete path's
 * has-values check, and the archived-axis check in the tagging path. `dimensions`
 * is in `0004_app_grants`'s mutable allowlist, so the app user may take a locking
 * read on it — unlike the journal tables, which is why nothing in this codebase
 * locks a journal row.
 */
export async function selectDimensionByIdForUpdate(
  db: TenantDatabase,
  id: Buffer,
): Promise<DimensionRow | undefined> {
  return db
    .selectFrom('dimensions')
    .select(DIMENSION_COLUMNS)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
}

/**
 * How many axes this org holds, counted under a lock that also blocks inserts.
 *
 * A plain count would make the cap advisory: two concurrent creates against a
 * full-but-one slate would both read seven and both commit, and no constraint
 * below this service would notice, because the schema cannot express the bound at
 * all (`0002_ledger`, D-18). InnoDB's next-key locking is what closes that — a
 * `SELECT … WHERE org_id = ? FOR UPDATE` under REPEATABLE READ locks the org's
 * span of the index *and the gaps in it*, so a second transaction's `INSERT` into
 * that span waits rather than interleaving. The two creates therefore serialize
 * and the second one counts what the first wrote.
 *
 * The rows are counted in the service rather than by `count(*)` so the same
 * statement is both the lock and the answer; a `COUNT` under `FOR UPDATE` takes
 * the identical locks and returns one row that reads as if it were free.
 *
 * Asserted with two live connections in `test/dimensions/axis-bound.test.ts`
 * rather than simulated sequentially — a sequential simulation of that race
 * passes against code holding no locks at all.
 */
export async function countDimensionsForUpdate(db: TenantDatabase): Promise<number> {
  const rows = await db.selectFrom('dimensions').select('id').forUpdate().execute();
  return rows.length;
}

/**
 * `(code, id)`, and the code is immutable for exactly this reason (D-27's
 * argument, reached again in `dimensions.ts`): a keyset over a mutable column
 * drops rows silently, so an axis renamed mid-page would appear on no page.
 *
 * `uq_dimensions_org_code` covers it at no cost — a secondary index leaf carries
 * the primary key, so `(org_id, code)` is scanned in `(org_id, code, id)` order,
 * which is the tuple the predicate compares.
 */
const DIMENSION_KEYSET: KeysetOrdering<DimensionRow> = [
  textKey('dimensions.code', (row) => row.code, DIMENSION_CODE_MAX_LENGTH),
  uuidKey('dimensions.id', (row) => row.id),
];

export async function selectDimensionsPage(
  db: TenantDatabase,
  filters: ListDimensionsQuery,
  limit: number,
): Promise<KeysetPage<DimensionRow>> {
  let query = db.selectFrom('dimensions').select(DIMENSION_COLUMNS);

  if (filters.isActive !== undefined) {
    query = query.where('is_active', '=', filters.isActive ? 1 : 0);
  }

  // The filter goes on first so the keyset predicate composes with it rather than
  // with a different result set: a page of "active only" has to end where the next
  // page of "active only" begins.
  const rows = await applyKeyset(query, DIMENSION_KEYSET, limit, filters.cursor).execute();

  return toKeysetPage(rows, DIMENSION_KEYSET, limit);
}

/**
 * No error translation, unlike `insertDimension`: nothing this statement can set
 * is covered by a unique key, because `code` is not in the patch shape.
 */
export async function updateDimensionRow(
  db: TenantDatabase,
  id: Buffer,
  patch: DimensionPatch,
): Promise<void> {
  await db
    .updateTable('dimensions')
    .set({
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.description === undefined ? {} : { description: patch.description }),
      ...(patch.isActive === undefined ? {} : { is_active: patch.isActive ? 1 : 0 }),
    })
    .where('id', '=', id)
    .execute();

  // The affected-row count is deliberately not consulted, for the reason
  // `updateAccountRow` states: mysql2 does not set `CLIENT_FOUND_ROWS`, so
  // renaming an axis to the name it already has reports zero affected rows exactly
  // as a statement that matched nothing does. Existence is established by the
  // caller's read.
}

/**
 * Deletes the axis, or refuses because its values still exist.
 *
 * The refusal is the database's. `fk_dimension_values_dimension` is `ON DELETE
 * RESTRICT` — deliberately, so that deleting an axis cannot take the values
 * reports are grouped by with it — and it is the only foreign key pointing at
 * `dimensions`, which is what makes errno 1451 here unambiguous: it means values,
 * and it cannot mean anything else.
 */
export async function deleteDimensionRow(db: TenantDatabase, id: Buffer): Promise<void> {
  try {
    await db.deleteFrom('dimensions').where('id', '=', id).execute();
  } catch (error) {
    if (!isStillReferencedError(error)) throw error;
    throw dimensionHasValuesError();
  }
}

export async function insertDimensionValue(
  db: TenantDatabase,
  dimensionId: Buffer,
  input: { readonly code: string; readonly name: string },
): Promise<DimensionValueRow> {
  const id = newUuidBuffer();

  try {
    await db
      .insertInto('dimension_values')
      .values({ id, dimension_id: dimensionId, code: input.code, name: input.name })
      .execute();
  } catch (error) {
    throw translateDuplicateValueCode(error, input.code);
  }

  const row = await selectDimensionValueById(db, id);
  if (row === undefined) {
    throw new InternalError('The dimension value inserted by this statement could not be read.');
  }
  return row;
}

export async function selectDimensionValueById(
  db: TenantDatabase,
  id: Buffer,
): Promise<DimensionValueRow | undefined> {
  return db
    .selectFrom('dimension_values')
    .select(DIMENSION_VALUE_COLUMNS)
    .where('id', '=', id)
    .executeTakeFirst();
}

/**
 * The locking counterpart, and the reason the delete/tag race has an answer.
 *
 * Both paths that reference a value take this lock — tagging, before it inserts a
 * tag naming the value, and deletion, before its in-use check — so the two
 * serialize on the row: either the tag lands and the delete is refused, or the
 * delete commits and the tagging transaction resolves nothing to tag. Without it
 * the losing order is errno 1452 on the tag insert, which is a 500 for what is
 * plainly a client's situation.
 */
export async function selectDimensionValueByIdForUpdate(
  db: TenantDatabase,
  id: Buffer,
): Promise<DimensionValueRow | undefined> {
  return db
    .selectFrom('dimension_values')
    .select(DIMENSION_VALUE_COLUMNS)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
}

/** `(code, id)` within one axis, covered by `uq_dimension_values_dimension_code`. */
const DIMENSION_VALUE_KEYSET: KeysetOrdering<DimensionValueRow> = [
  textKey('dimension_values.code', (row) => row.code, DIMENSION_VALUE_CODE_MAX_LENGTH),
  uuidKey('dimension_values.id', (row) => row.id),
];

export async function selectDimensionValuesPage(
  db: TenantDatabase,
  dimensionId: Buffer,
  filters: ListDimensionValuesQuery,
  limit: number,
): Promise<KeysetPage<DimensionValueRow>> {
  let query = db
    .selectFrom('dimension_values')
    .select(DIMENSION_VALUE_COLUMNS)
    .where('dimension_id', '=', dimensionId);

  if (filters.isActive !== undefined) {
    query = query.where('is_active', '=', filters.isActive ? 1 : 0);
  }

  const rows = await applyKeyset(query, DIMENSION_VALUE_KEYSET, limit, filters.cursor).execute();

  return toKeysetPage(rows, DIMENSION_VALUE_KEYSET, limit);
}

export async function updateDimensionValueRow(
  db: TenantDatabase,
  id: Buffer,
  patch: DimensionValuePatch,
): Promise<void> {
  await db
    .updateTable('dimension_values')
    .set({
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.isActive === undefined ? {} : { is_active: patch.isActive ? 1 : 0 }),
    })
    .where('id', '=', id)
    .execute();
}

/**
 * Deletes the value, or refuses because something still carries it.
 *
 * Two foreign keys reach this row and both are `ON DELETE RESTRICT`:
 * `fk_jld_value` from the posted tags and `fk_jdld_value` from the draft ones.
 * The errno cannot say which, so this raises the reference error in its general
 * wording; the service's pre-checks, which can tell them apart, raise the same
 * *token* with prose naming the one it found. That split is the same one
 * `accountReferencedError` makes: one machine-readable fact, several remedies.
 */
export async function deleteDimensionValueRow(db: TenantDatabase, id: Buffer): Promise<void> {
  try {
    await db.deleteFrom('dimension_values').where('id', '=', id).execute();
  } catch (error) {
    if (!isStillReferencedError(error)) throw error;
    throw dimensionValueInUseError();
  }
}

/**
 * Whether the axis has any values at all, active or archived.
 *
 * Existence, not a count: nothing needs the number, and `SELECT 1 … LIMIT 1` stops
 * at the first match on `idx_dimension_values_org_dimension_active`.
 */
export async function hasValues(db: TenantDatabase, dimensionId: Buffer): Promise<boolean> {
  const row = await db
    .selectFrom('dimension_values')
    .select('id')
    .where('dimension_id', '=', dimensionId)
    .limit(1)
    .executeTakeFirst();

  return row !== undefined;
}

/** Whether any posted journal line carries this value. Reads `idx_jld_org_dimension_value`. */
export async function hasPostedTags(db: TenantDatabase, valueId: Buffer): Promise<boolean> {
  const row = await db
    .selectFrom('journal_line_dimensions')
    .select('journal_line_id')
    .where('dimension_value_id', '=', valueId)
    .limit(1)
    .executeTakeFirst();

  return row !== undefined;
}

/**
 * Whether any *draft* line carries it (OB-038).
 *
 * Checked separately from the posted tags because `fk_jdld_value` restricts the
 * delete just as `fk_jld_value` does, and the remedy is entirely different: a
 * draft is editable, so the caller removes the tag and the delete succeeds. A
 * message naming journal lines when the only holder is a draft would send someone
 * looking through the ledger for a tag that is not there.
 */
export async function hasDraftTags(db: TenantDatabase, valueId: Buffer): Promise<boolean> {
  const row = await db
    .selectFrom('journal_draft_line_dimensions')
    .select('draft_line_id')
    .where('dimension_value_id', '=', valueId)
    .limit(1)
    .executeTakeFirst();

  return row !== undefined;
}

/**
 * The one token for "an axis still has values", from the pre-check and from the
 * `RESTRICT` backstop, so the race is invisible to the caller rather than a
 * different failure.
 *
 * `PreconditionFailedError` and not `ConflictError`: the request is well-formed
 * and permitted, and it is the state that forbids it.
 */
export function dimensionHasValuesError(): PreconditionFailedError {
  return new PreconditionFailedError(
    'dimension_has_values',
    'This dimension still has values and cannot be deleted. Deleting it would take the values ' +
      'reports are grouped by with it, without naming them. Delete the values first — each one ' +
      'no journal line carries deletes freely — or archive the dimension, which keeps every ' +
      'tag and simply stops offering the axis for new ones.',
  );
}

/**
 * "Something carries this value", in the general wording the errno 1451 backstop
 * has to use. The service's pre-checks raise the same token with prose naming
 * which holder they found.
 */
export function dimensionValueInUseError(detail?: string): PreconditionFailedError {
  return new PreconditionFailedError(
    'dimension_value_in_use',
    `${
      detail ??
      'A journal line or a draft line carries this dimension value, so it cannot be deleted.'
    } Deleting it would restate every sliced report that has ever been run — the slices would ` +
      'no longer sum to the whole, and nothing in the report would say so, which is ROADMAP ' +
      'D-16’s argument one level down. Archive it instead: an archived value keeps every line ' +
      'already tagged with it and cannot be chosen for a new tag.',
  );
}

/**
 * "This axis is out of circulation", raised from both places that would put it
 * back into circulation without saying so: adding a value to it, and tagging a
 * line with one of its values.
 *
 * One message rather than one per caller, because the fact and the remedy are the
 * same in both — unarchive the axis if the org is tracking it again — and two
 * messages for one state is how a token starts meaning two things.
 */
export function dimensionArchivedError(): PreconditionFailedError {
  return new PreconditionFailedError(
    'dimension_archived',
    'This dimension is archived. An archived axis keeps every tag its values already carry and ' +
      'is offered for nothing new: no new values, and no new tags on a journal line. Unarchive ' +
      'it if the organization is tracking it again.',
  );
}

export function dimensionValueArchivedError(code: string): PreconditionFailedError {
  return new PreconditionFailedError(
    'dimension_value_archived',
    `The dimension value ${JSON.stringify(code)} is archived and cannot be applied to a ` +
      'journal line. Archiving is what an organization does to a value it has stopped using, ' +
      'and it deliberately leaves every line already tagged with it untouched — so a line that ' +
      'already carries this value keeps it, and this refusal is only about applying it anew.',
  );
}

export function toDimension(row: DimensionRow): Dimension {
  return {
    id: bufferToUuid(row.id),
    code: row.code,
    name: row.name,
    description: row.description,
    isActive: row.is_active !== 0,
    // `timezone: 'Z'` on the pool and `DATETIME(3)` left as a `Date`, so these are
    // real instants and this is a lossless rendering of one.
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function toDimensionValue(row: DimensionValueRow): DimensionValue {
  return {
    id: bufferToUuid(row.id),
    dimensionId: bufferToUuid(row.dimension_id),
    code: row.code,
    name: row.name,
    isActive: row.is_active !== 0,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * `uq_dimensions_org_code` as a `ConflictError`.
 *
 * Free text is permitted on a conflict, unlike on a 404: the unique key is
 * `(org_id, code)`, so the row this collides with is inside the caller's own org
 * and naming the code discloses nothing they cannot already read. Any other driver
 * error is rethrown untouched — this function knows about one constraint and must
 * not guess about the rest.
 */
function translateDuplicateDimensionCode(error: unknown, code: string): unknown {
  if (!isDuplicateEntryError(error)) return error;

  return new ConflictError(
    `A dimension with code ${JSON.stringify(code)} already exists in this organization. Codes ` +
      'are compared case-insensitively, so a code differing only in case is the same code, and ' +
      'a code cannot be changed once created.',
    { code },
  );
}

/** `uq_dimension_values_dimension_code` — unique within the axis, not across the org. */
function translateDuplicateValueCode(error: unknown, code: string): unknown {
  if (!isDuplicateEntryError(error)) return error;

  return new ConflictError(
    `This dimension already has a value with code ${JSON.stringify(code)}. Value codes are ` +
      'unique within their own dimension and compared case-insensitively; the same code on a ' +
      'different dimension is a different value and is not a conflict.',
    { code },
  );
}
