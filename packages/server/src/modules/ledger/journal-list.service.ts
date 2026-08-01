import type { JournalPage, JournalSummary, ListJournalsQuery } from '@openbooks/shared-types';

import { getContext } from '../../context';
import type { RequestContext } from '../../context';
import type { KeysetOrdering } from '../../db';
import {
  applyKeyset,
  bufferToUuid,
  calendarDateKey,
  counterKey,
  orgScope,
  resolvePageLimit,
  tenantDb,
  toKeysetPage,
} from '../../db';
import { requirePermission } from '../permissions';

import { selectReversalsFor } from './posting.repository';

/**
 * Reading the journal list (spec §7; D-21).
 *
 * Separate from `posting.service.ts` for the reason `index.ts` gives about the
 * trial balance: this holds no write path, so a caller that only needs to read the
 * ledger never holds a handle that can post.
 *
 * ## Why this is the list keyset pagination was decided for
 *
 * `(entry_date, sequence_number)`, ascending. `entry_date` alone is not a total
 * ordering — a day's entries are all equal under it — and `sequence_number` is
 * what makes it one, which is part of why D-14 requires the sequence at all.
 *
 * The failure this avoids is specific and it is the ledger's, not a general
 * paging concern. Journals arrive while a user pages, and they do not only arrive
 * at the end: a correction posted today with an entry date of last month lands in
 * the middle of the list, *behind* a cursor that has already passed that date.
 * Under `OFFSET`, every row after the insertion point shifts by one and the next
 * page begins one row late, so a journal is skipped — silently, in a list of
 * financial records, which is the outcome the whole append-only design exists to
 * make impossible. Under a keyset predicate the page boundary is a row, not a
 * count, so an insertion anywhere leaves it exactly where it was.
 *
 * ## Why the ordering is not newest-first
 *
 * A journal list, the general ledger (OB-044), and a running balance all read in
 * the same direction, and a running balance only has one. Two directions would
 * also be two cursor semantics, which is the multiplication this ticket exists to
 * prevent.
 */

interface JournalListRow {
  readonly id: Buffer;
  readonly sequence_number: bigint;
  readonly entry_date: string;
  readonly memo: string | null;
  readonly source: string;
  readonly created_at: Date;
  readonly actor_type: 'user' | 'automation' | 'agent';
  readonly actor_id: Buffer;
  readonly reverses_journal_id: Buffer | null;
}

const JOURNAL_KEYSET: KeysetOrdering<JournalListRow> = [
  calendarDateKey('journals.entry_date', (row) => row.entry_date),
  counterKey('journals.sequence_number', (row) => row.sequence_number),
];

/**
 * The query is pagination and nothing else, so it is not parsed with a Zod schema
 * here.
 *
 * `resolvePageLimit` and the cursor decoder are the validation, and they are the
 * validation for every list endpoint rather than for this one — which matters more
 * than a second parse would, because the cursor is the one piece of client input
 * on this path that becomes a `WHERE` clause. `listJournalsQuerySchema` exists for
 * the published artifact; it is not what refuses a bad page.
 */
export async function listJournals(
  query: ListJournalsQuery = {},
  ctx: RequestContext = getContext('listJournals()'),
): Promise<JournalPage> {
  await requirePermission(ctx, 'journals.read');

  const limit = resolvePageLimit(query.limit);

  const db = tenantDb(orgScope(ctx.orgId));
  const built = db
    .selectFrom('journals')
    .select([
      'id',
      'sequence_number',
      'entry_date',
      'memo',
      'source',
      'created_at',
      'actor_type',
      'actor_id',
      'reverses_journal_id',
    ]);

  const rows = await applyKeyset(built, JOURNAL_KEYSET, limit, query.cursor).execute();
  const page = toKeysetPage(rows, JOURNAL_KEYSET, limit);

  // Which of this page's entries have since been reversed, in one read rather than
  // a per-row lookup (OB-236). The link lives on the reversing journal (D-02).
  const reversedBy = await selectReversalsFor(
    db,
    page.rows.map((row) => row.id),
  );

  return {
    items: page.rows.map((row) => toJournalSummary(row, reversedBy)),
    nextCursor: page.nextCursor,
  };
}

function toJournalSummary(row: JournalListRow, reversedBy: Map<string, Buffer>): JournalSummary {
  const reversal = reversedBy.get(row.id.toString('hex'));
  return {
    journalId: bufferToUuid(row.id),
    // A BIGINT, stringified for the reason `lineId` is: a JSON number cannot carry
    // one past 2^53 (D-13's argument, applied to an identifier).
    sequenceNumber: row.sequence_number.toString(),
    date: row.entry_date,
    memo: row.memo,
    source: row.source,
    // `timezone: 'Z'` on the pool and `DATETIME(3)` left as a `Date`
    // (`src/db/connection.ts`), so this is a lossless rendering of a real instant.
    postedAt: row.created_at.toISOString(),
    actorType: row.actor_type,
    actorId: bufferToUuid(row.actor_id),
    reversesJournalId: row.reverses_journal_id ? bufferToUuid(row.reverses_journal_id) : null,
    reversedByJournalId: reversal ? bufferToUuid(reversal) : null,
  };
}
