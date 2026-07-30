import type { AuditEntryKind } from '@openbooks/shared-types';
import { sql } from 'kysely';
import type { SqlBool } from 'kysely';

import type { TenantDatabase } from '../../db';
import { bufferToUuid, systemDb, tryUuidToBuffer } from '../../db';
import { ValidationError } from '../../errors';

/**
 * The audit trail's two sources, merged (initiative P, OB-196; ROADMAP D-98).
 *
 * `journals` and `period_close_events` are read here and nowhere else joins them —
 * everything downstream of this file sees one stream, newest first.
 *
 * ## Why two queries merged, and not one `UNION`
 *
 * The wire contract's own commentary allows either. A `UNION` needs both arms to
 * agree column-for-column, and the two sources do not: a journal's identity is
 * `(source, sequence_number, reverses_journal_id, actor_type, actor_id)` and a
 * close event's is `(action, actor_user_id, period name)` — reconciling that into
 * one `SELECT` list would mean computing `action`/`summary`/`reference` inside a
 * `UNION` arm, which is no simpler than computing them here and costs the same
 * thing everywhere else in this file gets from a plain Kysely builder: type
 * checking against `generated.ts`.
 *
 * Fetching `limit + 1` from *each* source and merging in memory is sound for the
 * same reason a k-way merge always is: a source cannot contribute more than
 * `limit + 1` rows to the true merged top `limit + 1`, because if it did, those
 * rows alone would already exceed that size. So two bounded, independently sorted
 * reads are enough to answer the page correctly — no source can be fetched to
 * exhaustion, and neither can hide a row that belongs on this page.
 *
 * ## Why the cursor here is not `db/keyset.ts`'s
 *
 * That helper orders every list ascending (`applyKeyset` fixes `'asc'` on every
 * column), which is right for an append-only ledger read forward from a cursor
 * (`listJournals`, the general ledger) but wrong for a timeline read newest first.
 * Reusing it would mean widening it for one caller, which is a seam this ticket
 * does not own. This file's cursor is deliberately the same *shape* the rest of
 * the codebase uses — `(created_at, id)`, opaque, base64url of a small JSON array
 * (D-21) — so a client cannot tell the two apart; only the ordering direction and
 * the fact that two sources feed it are local to this file.
 */

/** One row of the merged timeline, already carrying its own `action`/`summary`. */
export interface AuditRow {
  readonly id: Buffer;
  readonly kind: AuditEntryKind;
  readonly occurred_at: Date;
  readonly action: string;
  readonly reference: string | null;
  readonly source: string | null;
  readonly summary: string;
  readonly actor_type: 'user' | 'automation' | 'agent';
  /**
   * `null` for an automation or agent actor. `auditActorSchema` names both id and
   * name null for a non-user actor (the wire contract), and `journals.actor_id`
   * for those is not a `users.id` at all — it names an automation or an agent, a
   * different identifier space this report does not resolve or expose.
   */
  readonly actor_id: Buffer | null;
}

export interface AuditFilter {
  /** Inclusive lower bound on `occurred_at`. `null` means no lower bound. */
  readonly from: Date | null;
  /** Inclusive upper bound on `occurred_at`. `null` means no upper bound. */
  readonly to: Date | null;
  readonly actorId: Buffer | null;
}

export interface AuditPage {
  readonly rows: readonly AuditRow[];
  readonly nextCursor: string | null;
}

interface AuditCursor {
  readonly occurredAt: Date;
  readonly id: Buffer;
}

/** Carried in the cursor so a later change to its shape decodes to a refusal. */
const CURSOR_VERSION = 1;

/** One page of the merged timeline, newest first. */
export async function selectAuditPage(
  db: TenantDatabase,
  filter: AuditFilter,
  limit: number,
  cursor: string | undefined,
): Promise<AuditPage> {
  const boundary = cursor === undefined ? undefined : decodeCursor(cursor);

  const [journalRows, closeRows] = await Promise.all([
    selectJournalRows(db, filter, boundary, limit),
    selectPeriodCloseRows(db, filter, boundary, limit),
  ]);

  // The true merged top `limit + 1` — see the file header for why fetching that
  // many from each source is enough to guarantee it.
  const merged = [...journalRows, ...closeRows].sort(compareNewestFirst).slice(0, limit + 1);
  const hasMore = merged.length > limit;
  const rows = hasMore ? merged.slice(0, limit) : merged;
  const last = rows.at(-1);

  return {
    rows,
    nextCursor:
      hasMore && last !== undefined
        ? encodeCursor({ occurredAt: last.occurred_at, id: last.id })
        : null,
  };
}

function compareNewestFirst(left: AuditRow, right: AuditRow): number {
  const byTime = right.occurred_at.getTime() - left.occurred_at.getTime();
  return byTime !== 0 ? byTime : Buffer.compare(right.id, left.id);
}

interface JournalAuditColumns {
  readonly id: Buffer;
  readonly created_at: Date;
  readonly sequence_number: bigint;
  readonly source: string;
  readonly reverses_journal_id: Buffer | null;
  readonly actor_type: 'user' | 'automation' | 'agent';
  readonly actor_id: Buffer;
}

async function selectJournalRows(
  db: TenantDatabase,
  filter: AuditFilter,
  boundary: AuditCursor | undefined,
  limit: number,
): Promise<readonly AuditRow[]> {
  let query = db
    .selectFrom('journals')
    .select([
      'id',
      'created_at',
      'sequence_number',
      'source',
      'reverses_journal_id',
      'actor_type',
      'actor_id',
    ]);

  if (filter.from !== null) query = query.where('created_at', '>=', filter.from);
  if (filter.to !== null) query = query.where('created_at', '<=', filter.to);
  if (filter.actorId !== null) query = query.where('actor_id', '=', filter.actorId);
  if (boundary !== undefined) query = query.where(newerThan('journals', boundary));

  const rows = await query
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(limit + 1)
    .execute();

  return rows.map(toJournalAuditRow);
}

function toJournalAuditRow(row: JournalAuditColumns): AuditRow {
  const sequence = row.sequence_number.toString();

  return {
    id: row.id,
    kind: 'journal',
    occurred_at: row.created_at,
    action: row.reverses_journal_id === null ? 'posted' : 'reversed',
    reference: sequence,
    source: row.source,
    summary: journalSummary(row.source, sequence),
    actor_type: row.actor_type,
    actor_id: row.actor_type === 'user' ? row.actor_id : null,
  };
}

/**
 * `source` is what flags an adjusting or reclassifying entry (D-98) — the whole
 * reason this report exists rather than pointing an accountant at `listJournals`.
 */
function journalSummary(source: string, sequence: string): string {
  switch (source) {
    case 'adjusting':
      return `Adjusting entry #${sequence}`;
    case 'reclassifying':
      return `Reclassifying entry #${sequence}`;
    case 'reversal':
      return `Reversal of journal #${sequence}`;
    default:
      return `Journal #${sequence}`;
  }
}

interface PeriodCloseAuditColumns {
  readonly id: Buffer;
  readonly created_at: Date;
  readonly action: 'close' | 'reopen';
  readonly actor_user_id: Buffer | null;
  readonly period_name: string;
}

async function selectPeriodCloseRows(
  db: TenantDatabase,
  filter: AuditFilter,
  boundary: AuditCursor | undefined,
  limit: number,
): Promise<readonly AuditRow[]> {
  // Inner join, not left: `fk_pce_period` guarantees every close event names a
  // period this org still owns (D-97's history is append-only, so the period
  // that produced it cannot have gone missing underneath it).
  let query = db
    .selectFrom('period_close_events')
    .innerJoin('fiscal_periods', (join) =>
      join
        .onRef('fiscal_periods.id', '=', 'period_close_events.period_id')
        .onRef('fiscal_periods.org_id', '=', 'period_close_events.org_id'),
    )
    .select([
      'period_close_events.id as id',
      'period_close_events.created_at as created_at',
      'period_close_events.action as action',
      'period_close_events.actor_user_id as actor_user_id',
      'fiscal_periods.name as period_name',
    ]);

  if (filter.from !== null) {
    query = query.where('period_close_events.created_at', '>=', filter.from);
  }
  if (filter.to !== null) {
    query = query.where('period_close_events.created_at', '<=', filter.to);
  }
  if (filter.actorId !== null) {
    query = query.where('period_close_events.actor_user_id', '=', filter.actorId);
  }
  if (boundary !== undefined) query = query.where(newerThan('period_close_events', boundary));

  const rows = await query
    .orderBy('period_close_events.created_at', 'desc')
    .orderBy('period_close_events.id', 'desc')
    .limit(limit + 1)
    .execute();

  return rows.map(toPeriodCloseAuditRow);
}

function toPeriodCloseAuditRow(row: PeriodCloseAuditColumns): AuditRow {
  const closed = row.action === 'close';

  return {
    id: row.id,
    kind: 'period-close',
    occurred_at: row.created_at,
    action: closed ? 'closed' : 'reopened',
    reference: row.period_name,
    source: null,
    summary: `${closed ? 'Closed' : 'Reopened'} ${row.period_name}`,
    // A close is normally a human sign-off, but `period_close_events.actor_user_id`
    // is nullable (D-97): an automation or API-key session that holds `periods.close`
    // records a null closer, mirroring `fiscal_periods.closed_by_user_id`. A null
    // here is therefore a non-user actor — surfaced as `automation` (the only
    // non-user close path), with id/name null like every other non-user actor.
    actor_type: row.actor_user_id === null ? 'automation' : 'user',
    actor_id: row.actor_user_id,
  };
}

/**
 * `(table.created_at, table.id) < (?, ?)` — strictly older than the cursor row,
 * the direction "further down a newest-first page" means. The row-value form is
 * `db/keyset.ts`'s own reason: it is what MySQL 8 can drive from the
 * `(org_id, created_at)` index as a single range scan, and the expanded
 * `OR`-of-`AND`s form is the one that is subtly wrong at a page boundary.
 */
function newerThan(table: 'journals' | 'period_close_events', boundary: AuditCursor) {
  return sql<SqlBool>`(${sql.ref(`${table}.created_at`)}, ${sql.ref(`${table}.id`)}) < (${
    boundary.occurredAt
  }, ${boundary.id})`;
}

function encodeCursor(value: AuditCursor): string {
  const payload = [CURSOR_VERSION, value.occurredAt.toISOString(), bufferToUuid(value.id)];
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): AuditCursor {
  const payload = tryParseCursor(cursor);
  if (!Array.isArray(payload) || payload.length !== 3) throw malformedCursor();

  // `Array.isArray` narrows an `unknown` to `any[]`, so re-type the elements as
  // `unknown` before reading them — every one is checked below.
  const parts = payload as readonly unknown[];
  const [version, occurredAtSegment, idSegment] = parts;
  if (version !== CURSOR_VERSION) throw malformedCursor();
  if (typeof occurredAtSegment !== 'string' || typeof idSegment !== 'string') {
    throw malformedCursor();
  }

  const occurredAt = new Date(occurredAtSegment);
  const id = tryUuidToBuffer(idSegment);
  if (Number.isNaN(occurredAt.getTime()) || id === undefined) throw malformedCursor();

  return { occurredAt, id };
}

function tryParseCursor(cursor: string): unknown {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}

function malformedCursor(): ValidationError {
  return new ValidationError('Cursor is not valid.', [
    {
      path: 'cursor',
      message:
        'Send the `nextCursor` from this report’s previous page verbatim, or omit it to start ' +
        'at the beginning.',
    },
  ]);
}

/**
 * Display names for the page's user actors, keyed by hex id — `users` is not
 * tenant-scoped (a user exists across orgs), so this reaches it through
 * `systemDb()` rather than the org-scoped handle every other query in this file
 * uses, matching `selectUser` in `members.repository.ts`.
 *
 * A miss (a removed user, or an id this report cannot otherwise produce) is left
 * out of the map rather than defaulted here — `audit.service.ts` turns that into
 * `name: null`, the same answer `auditActorSchema` gives a non-user actor.
 */
export async function selectActorNames(
  userIds: readonly Buffer[],
): Promise<ReadonlyMap<string, string>> {
  if (userIds.length === 0) return new Map();

  const rows = await systemDb()
    .selectFrom('users')
    .select(['id', 'display_name'])
    .where('id', 'in', [...userIds])
    .execute();

  const names = new Map<string, string>();
  for (const row of rows) names.set(row.id.toString('hex'), row.display_name);
  return names;
}
