import type { JournalLineDimension } from '@openbooks/shared-types';

import type { TenantDatabase } from '../../db';
import { bufferToUuid } from '../../db';

/**
 * Data access for `journal_line_dimensions` — the tags themselves (OB-037).
 *
 * ## Why a module other than the posting repository may write this table
 *
 * `openbooks/no-journal-writes` restricts `journals` and `journal_lines` to
 * `posting.repository.ts`, and this table is deliberately not one of them. The
 * reason is the one `0999_app_grants` gives at length: a tag names which slice of
 * the business an amount belongs to, and it is an analysis dimension laid over the
 * ledger rather than a term of the entry. Nothing in the trial balance, the P&L,
 * or the balance sheet moves when one changes — only how a sliced report divides a
 * total that stays the same, which is the property acceptance B6 asserts. That is
 * also why the table appears in the grants file's *mutable* list while the line it
 * tags does not.
 *
 * The rule this file therefore has to keep on its own: **nothing here writes an
 * amount, an account, or a line.** It reads `journal_lines` to establish that a
 * line exists in this org, and it writes three id columns. There is no statement
 * in this module through which a debit or a credit could change, which is what
 * makes retagging safe to expose at all.
 */

export const JOURNAL_LINE_RESOURCE = 'journal_line';

/**
 * A client-supplied line id as a `BIGINT`, or `undefined` when it is not one.
 *
 * `journal_lines.id` crosses the wire as a decimal string, because a JSON number
 * cannot carry a `BIGINT` past 2^53 (`postedJournalLineSchema`). Undefined rather
 * than a throw for the reason `tryUuidToBuffer` gives: the service routes a
 * malformed id through `assertFound` to the same 404 a nonexistent one produces,
 * so no class of ids gets a distinguishable answer (A7).
 *
 * Bounded at 20 digits before `BigInt` sees it — the widest an unsigned `BIGINT`
 * can be — so a megabyte of digits is refused rather than parsed.
 */
const LINE_ID = /^(?:0|[1-9][0-9]{0,19})$/;

export function journalLineIdOrUndefined(lineId: string): bigint | undefined {
  if (!LINE_ID.test(lineId)) return undefined;

  const value = BigInt(lineId);
  return value > 0n ? value : undefined;
}

/**
 * Whether this line exists in the caller's org.
 *
 * A plain read, not a locking one. The app user holds no `UPDATE`/`DELETE` on
 * `journal_lines` (`0999_app_grants`), so it also cannot take a locking read
 * there — MySQL requires one of those privileges for `FOR UPDATE`. Nothing is
 * lost: journals are append-only, so a line that exists keeps existing, and the
 * check cannot go stale in the direction that would matter. `fk_jld_line` is the
 * backstop regardless.
 */
export async function selectJournalLineId(
  db: TenantDatabase,
  lineId: bigint,
): Promise<bigint | undefined> {
  const row = await db
    .selectFrom('journal_lines')
    .select('id')
    .where('id', '=', lineId)
    .executeTakeFirst();

  return row?.id;
}

export interface TagRow {
  readonly dimension_id: Buffer;
  readonly dimension_value_id: Buffer;
}

/** Every tag on one line, read from the clustered primary key. */
export async function selectLineTags(
  db: TenantDatabase,
  lineId: bigint,
): Promise<readonly TagRow[]> {
  return db
    .selectFrom('journal_line_dimensions')
    .select(['dimension_id', 'dimension_value_id'])
    .where('journal_line_id', '=', lineId)
    .execute();
}

export async function deleteLineTag(
  db: TenantDatabase,
  lineId: bigint,
  dimensionId: Buffer,
): Promise<void> {
  await db
    .deleteFrom('journal_line_dimensions')
    .where('journal_line_id', '=', lineId)
    .where('dimension_id', '=', dimensionId)
    .execute();
}

export async function insertLineTag(
  db: TenantDatabase,
  lineId: bigint,
  dimensionId: Buffer,
  valueId: Buffer,
): Promise<void> {
  await db
    .insertInto('journal_line_dimensions')
    .values({
      journal_line_id: lineId,
      dimension_id: dimensionId,
      dimension_value_id: valueId,
    })
    .execute();
}

/**
 * Moves an existing tag to a different value on the same axis.
 *
 * An `UPDATE` rather than a delete-and-insert, and the difference is visible in
 * the row: `created_at` keeps saying when the line was first tagged on this axis
 * and `updated_at` moves, which is the pair of facts someone auditing a
 * reclassification asks for. Delete-and-insert would report every retagged line as
 * newly tagged.
 */
export async function updateLineTagValue(
  db: TenantDatabase,
  lineId: bigint,
  dimensionId: Buffer,
  valueId: Buffer,
): Promise<void> {
  await db
    .updateTable('journal_line_dimensions')
    .set({ dimension_value_id: valueId })
    .where('journal_line_id', '=', lineId)
    .where('dimension_id', '=', dimensionId)
    .execute();
}

export function toJournalLineDimension(lineId: bigint, row: TagRow): JournalLineDimension {
  return {
    lineId: lineId.toString(),
    dimensionId: bufferToUuid(row.dimension_id),
    dimensionValueId: bufferToUuid(row.dimension_value_id),
  };
}
