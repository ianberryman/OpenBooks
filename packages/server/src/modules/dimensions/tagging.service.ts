import type {
  JournalLineDimension,
  SetJournalLineDimensionsRequest,
} from '@openbooks/shared-types';
import { setJournalLineDimensionsRequestSchema } from '@openbooks/shared-types';

import type { RequestContext } from '../../context';
import type { TenantDatabase } from '../../db';
import { assertFound, parseInput, PreconditionFailedError } from '../../errors';
import { requirePermission } from '../permissions';
import type { DimensionValueRow } from './dimensions.repository';
import {
  DIMENSION_VALUE_RESOURCE,
  dimensionArchivedError,
  dimensionIdBytes,
  dimensionValueArchivedError,
  orgScope,
  selectDimensionById,
  selectDimensionValueByIdForUpdate,
} from './dimensions.repository';
import type { TagRow } from './tags.repository';
import {
  deleteLineTag,
  insertLineTag,
  JOURNAL_LINE_RESOURCE,
  journalLineIdOrUndefined,
  selectJournalLineId,
  selectLineTags,
  toJournalLineDimension,
  updateLineTagValue,
} from './tags.repository';

/**
 * Retagging a posted journal line (OB-037; ROADMAP D-18, D-16).
 *
 * ## Why this operation exists, and why it lives here
 *
 * `journal_line_dimensions` is in `0004_app_grants`'s *mutable* list while the line
 * it tags is append-only, and that asymmetry is the whole argument: a tag names
 * which slice of the business an amount belongs to, not a term of the entry.
 * Nothing in the trial balance, the P&L, or the balance sheet moves when one
 * changes — only how a sliced report divides a total that stays the same. Refusing
 * the edit would mean the only way to fix a mis-tagged line is to reverse and
 * repost a journal that was financially correct, and manufacturing two entries to
 * correct a label is a worse record of what happened than the edit is. That is
 * D-16's reasoning applied to the one thing attached to a posting that is not part
 * of it.
 *
 * It lives in this module rather than in the posting path because
 * `openbooks/no-journal-writes` restricts `journals` and `journal_lines` to
 * `posting.repository.ts` and deliberately does not name this table — the rule's
 * subject is the ledger, and the tags are the analysis laid over it. Putting a
 * retag in the posting service would also give it the posting service's
 * apparatus — a sequence number, a period lock, actor provenance — none of which
 * applies to changing a label.
 *
 * ## What cannot happen here
 *
 * No statement in this module or in `tags.repository.ts` writes an amount, an
 * account, or a line. `journal_lines` is read once, to establish that the line
 * exists in the caller's org, and the writes touch three id columns of the tag
 * table. Retagging therefore cannot move money, and `test/dimensions/tagging.test.ts`
 * asserts that against a real trial balance rather than trusting the reading.
 *
 * ## One question left open on purpose
 *
 * Whether a line in a *closed* period may be retagged. There is an argument each
 * way — the period lock exists so the books for a month stop moving, and a tag is
 * not part of what the books say — and answering it belongs with the sliced
 * reports that would be restated (OB-053), where the cost is visible. Today the
 * period is not consulted.
 */

/**
 * Replaces the complete set of dimension values a journal line carries.
 *
 * `dimensions.write`, and not `journals.post`. The permission that governs an
 * operation is the one that describes what it changes, and this changes the axes'
 * assignment rather than the ledger: the person who maintains the department list
 * is the person who says which department an expense belonged to. It is also
 * unobservable in the shipped roles — every seeded role holding `dimensions.write`
 * (owner, bookkeeper) holds `journals.post` too, and none of the roles holding
 * `journals.post` alone exists — so the choice is about which rule a *custom* role
 * in v2 will be written against.
 *
 * ## The order of the checks, and why each is where it is
 *
 * The line is resolved first, so a nonexistent or cross-org line is a 404 before
 * anything about the caller's values is examined. Each value is then resolved
 * `FOR UPDATE`, which is what serializes this against `deleteDimensionValue`:
 * without the lock, the losing order is errno 1452 on the tag insert, which is a
 * 500 for what is plainly a client's situation.
 *
 * The archived checks apply to *added* tags only, and that is the part worth being
 * careful about. Archiving stops a value being chosen anew; it does not retract the
 * tags already carrying it. Since this operation states the whole set, a caller
 * adding a project tag to a line that already carries an archived department tag
 * has to resend that department tag — and refusing it would make the line
 * permanently untaggable on every other axis. So a tag that is already present,
 * unchanged, passes whatever its value's state; a new or moved one does not.
 */
export async function setJournalLineDimensions(
  journalLineId: string,
  input: SetJournalLineDimensionsRequest,
  ctx: RequestContext,
): Promise<readonly JournalLineDimension[]> {
  await requirePermission(ctx, 'dimensions.write');
  const request = parseInput(setJournalLineDimensionsRequestSchema, input);

  return orgScope(ctx).transaction(async (trx) => {
    const lineId = assertFound(journalLineIdOrUndefined(journalLineId), JOURNAL_LINE_RESOURCE);
    assertFound(await selectJournalLineId(trx, lineId), JOURNAL_LINE_RESOURCE);

    const desired = await resolveDesiredTags(trx, request.valueIds);
    const current = byAxis(await selectLineTags(trx, lineId));

    for (const [axis, value] of desired) {
      const held = current.get(axis);
      if (held !== undefined && held.id.equals(value.id)) continue;

      await assertApplicable(trx, value);
      if (held === undefined) {
        await insertLineTag(trx, lineId, value.dimension_id, value.id);
      } else {
        await updateLineTagValue(trx, lineId, value.dimension_id, value.id);
      }
    }

    for (const [axis, tag] of current) {
      if (!desired.has(axis)) await deleteLineTag(trx, lineId, tag.dimension_id);
    }

    return readTags(trx, lineId);
  });
}

/**
 * The values a line carries.
 *
 * `dimensions.read` rather than `journals.read`, mirroring the write. The same
 * observation applies: every seeded role that can reach this can already read the
 * journal it belongs to.
 */
export async function getJournalLineDimensions(
  journalLineId: string,
  ctx: RequestContext,
): Promise<readonly JournalLineDimension[]> {
  await requirePermission(ctx, 'dimensions.read');

  const db = orgScope(ctx);
  const lineId = assertFound(journalLineIdOrUndefined(journalLineId), JOURNAL_LINE_RESOURCE);
  assertFound(await selectJournalLineId(db, lineId), JOURNAL_LINE_RESOURCE);

  return readTags(db, lineId);
}

/**
 * The requested value ids as rows, keyed by their axis.
 *
 * The axis is derived from the value and never taken from the caller, which is
 * what makes a tag filed under the wrong axis unrepresentable rather than merely
 * refused — the same guarantee `fk_jld_value`'s three columns give at the
 * database, arrived at one layer earlier so it cannot become a 500.
 *
 * Two values on one axis is refused rather than resolved last-one-wins. The
 * primary key `(org_id, journal_line_id, dimension_id)` forbids the state, and it
 * forbids it because a line counted twice makes acceptance B6 false — the slices
 * of a report would no longer sum to the whole. A request that names both is a
 * request whose author believes something untrue about the line, and silently
 * keeping one of them would leave that belief in place.
 */
async function resolveDesiredTags(
  db: TenantDatabase,
  valueIds: readonly string[],
): Promise<ReadonlyMap<string, DimensionValueRow>> {
  const desired = new Map<string, DimensionValueRow>();

  for (const valueId of valueIds) {
    const id = assertFound(dimensionIdBytes(valueId), DIMENSION_VALUE_RESOURCE);
    const value = assertFound(
      await selectDimensionValueByIdForUpdate(db, id),
      DIMENSION_VALUE_RESOURCE,
    );

    const axis = value.dimension_id.toString('hex');
    const clash = desired.get(axis);
    if (clash !== undefined) {
      if (clash.id.equals(value.id)) continue;
      throw axisConflictError(clash.code, value.code);
    }

    desired.set(axis, value);
  }

  return desired;
}

/**
 * Whether this value may be applied to a line now.
 *
 * The axis is read without a lock, unlike the value. An archive landing
 * concurrently would lose the race and leave one tag applied to a just-archived
 * axis — which changes nothing about any amount and is undone by removing the tag,
 * where locking every axis on every retag would serialize unrelated tagging across
 * the whole org.
 */
async function assertApplicable(db: TenantDatabase, value: DimensionValueRow): Promise<void> {
  if (value.is_active === 0) throw dimensionValueArchivedError(value.code);

  const dimension = await selectDimensionById(db, value.dimension_id);
  if (dimension === undefined || dimension.is_active === 0) throw dimensionArchivedError();
}

function byAxis(tags: readonly TagRow[]): Map<string, { dimension_id: Buffer; id: Buffer }> {
  return new Map(
    tags.map((tag) => [
      tag.dimension_id.toString('hex'),
      { dimension_id: tag.dimension_id, id: tag.dimension_value_id },
    ]),
  );
}

async function readTags(
  db: TenantDatabase,
  lineId: bigint,
): Promise<readonly JournalLineDimension[]> {
  const rows = await selectLineTags(db, lineId);
  return rows.map((row) => toJournalLineDimension(lineId, row));
}

function axisConflictError(first: string, second: string): PreconditionFailedError {
  return new PreconditionFailedError(
    'dimension_axis_conflict',
    `The values ${JSON.stringify(first)} and ${JSON.stringify(second)} belong to the same ` +
      'dimension, and a journal line carries at most one value per dimension. A line tagged ' +
      'twice on one axis is counted twice by every report grouped on it, so the slices stop ' +
      'summing to the whole. Send the one value this line belongs to.',
  );
}
