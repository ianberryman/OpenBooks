import type {
  CreateDimensionRequest,
  CreateDimensionValueRequest,
  Dimension,
  DimensionPage,
  DimensionValue,
  DimensionValuePage,
  ListDimensionValuesQuery,
  ListDimensionsQuery,
  UpdateDimensionRequest,
  UpdateDimensionValueRequest,
} from '@openbooks/shared-types';
import {
  createDimensionRequestSchema,
  createDimensionValueRequestSchema,
  listDimensionValuesQuerySchema,
  listDimensionsQuerySchema,
  MAX_DIMENSIONS_PER_ORG,
  updateDimensionRequestSchema,
  updateDimensionValueRequestSchema,
} from '@openbooks/shared-types';

import type { RequestContext } from '../../context';
import { resolvePageLimit } from '../../db';
import { assertFound, parseInput, PreconditionFailedError } from '../../errors';
import { requirePermission } from '../permissions';
import type { DimensionPatch } from './dimensions.repository';
import {
  countDimensionsForUpdate,
  deleteDimensionRow,
  dimensionArchivedError,
  deleteDimensionValueRow,
  DIMENSION_RESOURCE,
  DIMENSION_VALUE_RESOURCE,
  dimensionIdBytes,
  dimensionValueInUseError,
  hasDraftTags,
  hasPostedTags,
  hasValues,
  insertDimension,
  insertDimensionValue,
  orgScope,
  selectDimensionById,
  selectDimensionByIdForUpdate,
  selectDimensionsPage,
  selectDimensionValueById,
  selectDimensionValueByIdForUpdate,
  selectDimensionValuesPage,
  toDimension,
  toDimensionValue,
  updateDimensionRow,
  updateDimensionValueRow,
} from './dimensions.repository';

/**
 * The reporting axes and their values (OB-037; ROADMAP D-18).
 *
 * Read `index.ts` for the surface and for the three decisions this module records
 * — the axis bound, archive versus delete, and where retagging lives — and
 * `packages/shared-types/src/dimensions/dimensions.ts` for the wire contract.
 *
 * Three things are uniform across every operation below and stated once here
 * rather than at each, following `accounts.service.ts`:
 *
 * 1. **`requirePermission` runs first**, before the payload is parsed. A caller
 *    without authority learns that and nothing else; validating first would
 *    describe an API surface they are not entitled to. Enforcement is
 *    service-layer only (spec §2.4, §5).
 *
 * 2. **Every payload is parsed with the shared zod schema**, because the HTTP
 *    route is not the only caller (spec §12; see `input.ts`).
 *
 * 3. **A miss is `assertFound`**, never a hand-written throw. `tenantDb` has
 *    already confined the read to the context's org, so a cross-org id returns no
 *    row and reaches the same line a nonexistent id reaches (A7).
 */

/**
 * Creates one axis, active.
 *
 * `dimensions.write` alone and not `dimensions.write` plus `dimensions.read`, even
 * though this returns the created row: reading back what you just wrote is part of
 * the write, and requiring both would make every write role a read role for no
 * gain. The same applies to every other write below.
 *
 * The transaction is what makes `MAX_DIMENSIONS_PER_ORG` a bound rather than a
 * suggestion — see `countDimensionsForUpdate` for why the count is taken under a
 * lock and what InnoDB is doing to make it exact.
 */
export async function createDimension(
  input: CreateDimensionRequest,
  ctx: RequestContext,
): Promise<Dimension> {
  await requirePermission(ctx, 'dimensions.write');
  const request = parseInput(createDimensionRequestSchema, input);

  return orgScope(ctx).transaction(async (trx) => {
    if ((await countDimensionsForUpdate(trx)) >= MAX_DIMENSIONS_PER_ORG) {
      throw dimensionLimitError();
    }

    const row = await insertDimension(trx, {
      code: request.code,
      name: request.name,
      description: request.description ?? null,
    });

    return toDimension(row);
  });
}

export async function getDimension(dimensionId: string, ctx: RequestContext): Promise<Dimension> {
  await requirePermission(ctx, 'dimensions.read');

  const db = orgScope(ctx);
  const id = assertFound(dimensionIdBytes(dimensionId), DIMENSION_RESOURCE);

  return toDimension(assertFound(await selectDimensionById(db, id), DIMENSION_RESOURCE));
}

/**
 * One page of the org's axes, in code order (D-21).
 *
 * Paginated even though `MAX_DIMENSIONS_PER_ORG` already bounds the list at eight,
 * and deliberately so: an endpoint exempted from the convention is the one a
 * client writes a second paging loop for. `resolvePageLimit` and not the parsed
 * `limit`, because the schema is a restatement and the function is the authority —
 * spec §12 puts an MCP tool and the workflow engine on this service with no schema
 * in front of them.
 */
export async function listDimensions(
  query: ListDimensionsQuery,
  ctx: RequestContext,
): Promise<DimensionPage> {
  await requirePermission(ctx, 'dimensions.read');
  const filters = parseInput(listDimensionsQuerySchema, query);
  const limit = resolvePageLimit(filters.limit);

  const page = await selectDimensionsPage(orgScope(ctx), filters, limit);
  return { items: page.rows.map(toDimension), nextCursor: page.nextCursor };
}

/**
 * Renames an axis, and changes its description.
 *
 * Those are the only two mutable fields. `code` is immutable (the list is ordered
 * by it, and a keyset over a mutable column drops rows silently), and `isActive`
 * is its own pair of operations rather than a flag in a patch body — archiving
 * decides whether the axis is offered for new tags, which is not a side effect of
 * relabelling it.
 *
 * No has-tags check, unlike the account type rule. A rename cannot restate a
 * report: the tags still point at the same axis, every slice still holds the same
 * lines, and only the heading changes. That is precisely the difference between a
 * label and a classification, and it is why this operation is unrestricted while
 * deleting a value is not.
 */
export async function updateDimension(
  dimensionId: string,
  input: UpdateDimensionRequest,
  ctx: RequestContext,
): Promise<Dimension> {
  await requirePermission(ctx, 'dimensions.write');
  const request = parseInput(updateDimensionRequestSchema, input);

  const db = orgScope(ctx);
  const id = assertFound(dimensionIdBytes(dimensionId), DIMENSION_RESOURCE);
  assertFound(await selectDimensionById(db, id), DIMENSION_RESOURCE);

  const patch: DimensionPatch = {
    ...(request.name === undefined ? {} : { name: request.name }),
    // `null` clears, absent leaves alone. JSON has no way to send `undefined`, so a
    // client wanting to clear the field sends `null` and gets exactly that.
    ...(request.description === undefined ? {} : { description: request.description }),
  };

  await updateDimensionRow(db, id, patch);
  return toDimension(assertFound(await selectDimensionById(db, id), DIMENSION_RESOURCE));
}

/**
 * Takes an axis out of circulation without removing it from the books.
 *
 * This is the only form of removal available to an axis whose values are in use,
 * and it is what the delete path's error names. Idempotent: an already-archived
 * axis is returned unchanged rather than refused, because a retry of an archive is
 * a retry and not a conflict.
 *
 * Archiving an axis does not archive its values, and does not need to — an
 * archived axis offers neither new values nor new tags, so its values are already
 * unreachable for new work, and cascading would destroy the information about
 * which of them the org had retired on their own.
 */
export async function archiveDimension(
  dimensionId: string,
  ctx: RequestContext,
): Promise<Dimension> {
  return setDimensionActive(dimensionId, false, ctx);
}

/**
 * The counterpart, and not an optional convenience — the same argument
 * `reactivateAccount` makes. Without it, archiving is a one-way door: the only
 * other way out is deletion, which is exactly what an axis with values cannot do,
 * and `uq_dimensions_org_code` covers archived rows, so the code could not be
 * reused either.
 */
export async function unarchiveDimension(
  dimensionId: string,
  ctx: RequestContext,
): Promise<Dimension> {
  return setDimensionActive(dimensionId, true, ctx);
}

/**
 * Deletes an axis that has no values.
 *
 * ROADMAP D-16 settles that ledger entries are never deleted, and an axis is not a
 * ledger entry — it is configuration, a heading that reports group by. An axis
 * with no values has never sliced anything, so deleting it changes no past figure.
 *
 * Refusing outright would have a real cost, the same one `deleteAccount` names:
 * archiving is not equivalent, because `uq_dimensions_org_code` covers archived
 * rows, so an org that mistyped an axis code during setup would carry that row and
 * that code forever. It would also make the axis bound permanent — eight typos
 * would be eight axes, and `MAX_DIMENSIONS_PER_ORG` counts archived rows on
 * purpose (see the constant). Deletion is the escape hatch that makes the bound
 * safe to enforce.
 *
 * The pre-check is not what makes this safe. `fk_dimension_values_dimension` is
 * `ON DELETE RESTRICT`, so the database refuses regardless of what this service
 * concluded, and `deleteDimensionRow` translates errno 1451 into the same error
 * the pre-check raises — the race is invisible to the caller rather than a
 * different failure. The lock on the axis row is what makes the pre-check's
 * *answer* stable long enough to be worth giving: `createDimensionValue` takes the
 * same lock, so a value cannot appear between the check and the delete.
 */
export async function deleteDimension(dimensionId: string, ctx: RequestContext): Promise<void> {
  await requirePermission(ctx, 'dimensions.write');

  await orgScope(ctx).transaction(async (trx) => {
    const id = assertFound(dimensionIdBytes(dimensionId), DIMENSION_RESOURCE);

    // Establishes existence, so deleting an axis that never existed — or one
    // belonging to another org — is a 404 rather than a silent success.
    assertFound(await selectDimensionByIdForUpdate(trx, id), DIMENSION_RESOURCE);

    if (await hasValues(trx, id)) throw dimensionHasValuesPrecheckError();

    await deleteDimensionRow(trx, id);
  });
}

/**
 * Adds one value to an axis.
 *
 * The axis is resolved through `tenantDb` and `assertFound` before any statement
 * names it, and that resolution is the 404: letting `fk_dimension_values_dimension`
 * refuse would be equivalent for integrity and wrong for the error surface —
 * another org's dimension id would arrive as errno 1452 and become an opaque 500,
 * where A7 requires it to be indistinguishable from a nonexistent one.
 *
 * The lock on the axis row is held for the insert, which is what makes
 * `deleteDimension`'s has-values check exact rather than probable: the two
 * serialize, so either the value lands and the delete is refused, or the delete
 * commits and this transaction has no axis to add to.
 */
export async function createDimensionValue(
  dimensionId: string,
  input: CreateDimensionValueRequest,
  ctx: RequestContext,
): Promise<DimensionValue> {
  await requirePermission(ctx, 'dimensions.write');
  const request = parseInput(createDimensionValueRequestSchema, input);

  return orgScope(ctx).transaction(async (trx) => {
    const id = assertFound(dimensionIdBytes(dimensionId), DIMENSION_RESOURCE);
    const dimension = assertFound(await selectDimensionByIdForUpdate(trx, id), DIMENSION_RESOURCE);

    if (dimension.is_active === 0) throw dimensionArchivedError();

    const row = await insertDimensionValue(trx, id, { code: request.code, name: request.name });
    return toDimensionValue(row);
  });
}

/**
 * One value, by its own id.
 *
 * Not scoped to an axis in the signature, because a value id is unique within the
 * org — `uq_dimension_values_org_id` — and requiring the axis would let a caller
 * ask a question whose two arguments can disagree. The axis comes back on the row.
 */
export async function getDimensionValue(
  valueId: string,
  ctx: RequestContext,
): Promise<DimensionValue> {
  await requirePermission(ctx, 'dimensions.read');

  const db = orgScope(ctx);
  const id = assertFound(dimensionIdBytes(valueId), DIMENSION_VALUE_RESOURCE);

  return toDimensionValue(
    assertFound(await selectDimensionValueById(db, id), DIMENSION_VALUE_RESOURCE),
  );
}

/**
 * One page of an axis's values, in code order.
 *
 * The axis is resolved first, so listing the values of a nonexistent — or another
 * org's — dimension is a 404 rather than an empty page. An empty page would be a
 * true statement about the caller's org and a misleading answer to the question
 * asked, and it would also be the one shape that distinguishes "no values" from
 * "no such axis" by omission.
 */
export async function listDimensionValues(
  dimensionId: string,
  query: ListDimensionValuesQuery,
  ctx: RequestContext,
): Promise<DimensionValuePage> {
  await requirePermission(ctx, 'dimensions.read');
  const filters = parseInput(listDimensionValuesQuerySchema, query);
  const limit = resolvePageLimit(filters.limit);

  const db = orgScope(ctx);
  const id = assertFound(dimensionIdBytes(dimensionId), DIMENSION_RESOURCE);
  assertFound(await selectDimensionById(db, id), DIMENSION_RESOURCE);

  const page = await selectDimensionValuesPage(db, id, filters, limit);
  return { items: page.rows.map(toDimensionValue), nextCursor: page.nextCursor };
}

/** Renames a value. `code` is immutable and `isActive` has its own operations. */
export async function updateDimensionValue(
  valueId: string,
  input: UpdateDimensionValueRequest,
  ctx: RequestContext,
): Promise<DimensionValue> {
  await requirePermission(ctx, 'dimensions.write');
  const request = parseInput(updateDimensionValueRequestSchema, input);

  const db = orgScope(ctx);
  const id = assertFound(dimensionIdBytes(valueId), DIMENSION_VALUE_RESOURCE);
  assertFound(await selectDimensionValueById(db, id), DIMENSION_VALUE_RESOURCE);

  await updateDimensionValueRow(db, id, { name: request.name });
  return toDimensionValue(
    assertFound(await selectDimensionValueById(db, id), DIMENSION_VALUE_RESOURCE),
  );
}

/**
 * The sanctioned removal for a value journal lines carry. Idempotent, like
 * archiving an axis.
 */
export async function archiveDimensionValue(
  valueId: string,
  ctx: RequestContext,
): Promise<DimensionValue> {
  return setDimensionValueActive(valueId, false, ctx);
}

export async function unarchiveDimensionValue(
  valueId: string,
  ctx: RequestContext,
): Promise<DimensionValue> {
  return setDimensionValueActive(valueId, true, ctx);
}

/**
 * Deletes a value nothing carries.
 *
 * ## Why deletion is refused once a line carries it
 *
 * `fk_jld_value` is `ON DELETE RESTRICT`, so the database is the guarantee and
 * this service cannot override it — which is the point. Deleting a value that
 * journal lines carry would silently restate every sliced report that has ever
 * been run: the amounts do not move, but the slices stop summing to the whole, and
 * the tag that used to say which department an expense belonged to is simply gone.
 * That is ROADMAP D-16's argument one level down, and the fact that the amounts
 * are untouched is what makes it dangerous rather than harmless — nothing in the
 * trial balance changes, so nothing signals that a report has changed meaning.
 *
 * ## What the caller actually sees
 *
 * A `precondition_failed` carrying `dimension_value_in_use`, whose prose names
 * which holder was found — a posted line, or a draft — and points at archiving.
 * Never a 500: the errno 1451 that the `RESTRICT` produces when the pre-check
 * loses a race is translated into the same token by `deleteDimensionValueRow`, in
 * the general wording it has to use because the errno cannot say which foreign key
 * refused.
 *
 * The lock on the value row is what makes the pre-check's answer meaningful:
 * `setJournalLineDimensions` takes the same lock before it inserts a tag naming
 * this value, so the two serialize — either the tag lands first and this delete is
 * refused, or this delete commits and the tagging transaction finds nothing to
 * resolve. Draft tags (OB-038) are not covered by that ordering, which is why the
 * `RESTRICT` backstop matters and why its message names both possibilities.
 */
export async function deleteDimensionValue(valueId: string, ctx: RequestContext): Promise<void> {
  await requirePermission(ctx, 'dimensions.write');

  await orgScope(ctx).transaction(async (trx) => {
    const id = assertFound(dimensionIdBytes(valueId), DIMENSION_VALUE_RESOURCE);
    assertFound(await selectDimensionValueByIdForUpdate(trx, id), DIMENSION_VALUE_RESOURCE);

    if (await hasPostedTags(trx, id)) {
      throw dimensionValueInUseError(
        'At least one journal line carries this dimension value, so it cannot be deleted.',
      );
    }
    if (await hasDraftTags(trx, id)) {
      throw dimensionValueInUseError(
        'A draft journal carries this dimension value, so it cannot be deleted. Remove the tag ' +
          'from the draft — a draft has not reached the ledger and is freely editable — and the ' +
          'value deletes.',
      );
    }

    await deleteDimensionValueRow(trx, id);
  });
}

async function setDimensionActive(
  dimensionId: string,
  isActive: boolean,
  ctx: RequestContext,
): Promise<Dimension> {
  await requirePermission(ctx, 'dimensions.write');

  const db = orgScope(ctx);
  const id = assertFound(dimensionIdBytes(dimensionId), DIMENSION_RESOURCE);
  assertFound(await selectDimensionById(db, id), DIMENSION_RESOURCE);

  await updateDimensionRow(db, id, { isActive });
  return toDimension(assertFound(await selectDimensionById(db, id), DIMENSION_RESOURCE));
}

async function setDimensionValueActive(
  valueId: string,
  isActive: boolean,
  ctx: RequestContext,
): Promise<DimensionValue> {
  await requirePermission(ctx, 'dimensions.write');

  const db = orgScope(ctx);
  const id = assertFound(dimensionIdBytes(valueId), DIMENSION_VALUE_RESOURCE);
  assertFound(await selectDimensionValueById(db, id), DIMENSION_VALUE_RESOURCE);

  await updateDimensionValueRow(db, id, { isActive });
  return toDimensionValue(
    assertFound(await selectDimensionValueById(db, id), DIMENSION_VALUE_RESOURCE),
  );
}

/**
 * The bound D-18 asked this service to choose. See `MAX_DIMENSIONS_PER_ORG` for
 * the number and the reasoning; this is only its refusal.
 *
 * The message says what to do instead, because the usual ninth axis is not an axis
 * — it is a value on one of the eight, or a distinction the chart of accounts
 * already draws.
 */
function dimensionLimitError(): PreconditionFailedError {
  return new PreconditionFailedError(
    'dimension_limit_reached',
    `An organization may define at most ${String(MAX_DIMENSIONS_PER_ORG)} dimensions, and this ` +
      'one already has that many. Every axis is another join in every sliced report and another ' +
      'tag row on every line, which is the cost ROADMAP D-18 accepted a bound to contain. ' +
      'Delete a dimension no value belongs to, or ask whether the new axis is really a value on ' +
      'an existing one. Archived dimensions count towards the limit, because their values are ' +
      'still carried by journal lines and still joined by every historical report.',
  );
}

/**
 * Shares `dimensionHasValuesError`'s token and carries the pre-check's own
 * wording, which is the same construction `accountTypeLockedError` uses: the
 * machine-readable fact is one fact, and a client branching on it should not have
 * to learn two names for it.
 */
function dimensionHasValuesPrecheckError(): PreconditionFailedError {
  return new PreconditionFailedError(
    'dimension_has_values',
    'This dimension still has values and cannot be deleted. Delete them first — a value no ' +
      'journal line and no draft carries deletes freely — or archive the dimension, which keeps ' +
      'every tag its values carry and stops offering the axis for new ones.',
  );
}
