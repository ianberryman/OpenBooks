import { PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX } from '@openbooks/shared-types';
import { sql } from 'kysely';
import type { Expression, SqlBool } from 'kysely';

import { ValidationError } from '../errors';

import { bufferToUuid, tryUuidToBuffer } from './uuid';

/**
 * Keyset pagination over a `tenantDb` query (ROADMAP D-21).
 *
 * ## Why this is a predicate on the caller's builder and not a query of its own
 *
 * The obvious shape for a pagination helper is one that runs the query. It cannot
 * be that here: tenant tables are reachable only through `TenantDatabase`, which
 * injects `org_id = ?` before the caller sees the builder, and the raw handle has
 * no public name (spec §4, D-01). A helper that built its own statement would need
 * an executor, and the only executor that reaches these tables unscoped is the one
 * that must not exist. So this takes the already-scoped builder and adds to it,
 * which means the org predicate is applied whether or not this file is correct.
 *
 * ## Why keyset and not offset
 *
 * `OFFSET` assumes the rows behind you do not move. In an append-only ledger they
 * do — a back-dated entry posted while a user pages lands *before* the position
 * they have reached — and the window shifts, so a row is skipped or returned
 * twice with nothing in the response indicating it happened (D-21). A keyset
 * predicate over a total ordering has no such failure: it names the last row seen
 * rather than a count of rows behind it, so an insertion anywhere is either ahead
 * of that row or behind it, and neither disturbs the page boundary.
 *
 * "Total" is load-bearing. `entry_date` alone is not total, which is one of the
 * reasons `journals.sequence_number` exists (D-14): the second column is what
 * separates two entries on the same day, and without it the predicate would either
 * skip the rest of a day or repeat it. `created_at` is not total either — two rows
 * can share a millisecond — so `id` breaks the tie everywhere else.
 *
 * ## Why the ordering columns must be immutable
 *
 * The predicate assumes a row's key does not change. A key column that a caller
 * can edit reintroduces exactly the failure keyset was chosen to remove: renaming
 * an account's `code` moves the row behind a cursor that has already passed it,
 * and it is silently dropped from the results. Every ordering built here
 * therefore uses columns that are written once —
 * `(entry_date, sequence_number)`, `(created_at, id)`, and `(code, id)`.
 *
 * The last of those is the one worth noticing, because it did not start out
 * immutable. OB-031 ordered the chart of accounts by `(created_at, id)`
 * *because* `code` was editable, and D-27 then made the code immutable rather
 * than leave a chart of accounts sorted by when someone typed each row. The
 * requirement is a property of the column, not a property this file can check:
 * nothing here fails if a mutable column is passed, which is why the requirement
 * is stated at every ordering rather than only here.
 */

/**
 * One column of an ordering, together with the two conversions that keep the
 * cursor and the predicate in agreement.
 *
 * `decode` returns `unknown` on purpose: the value's only destination is a bound
 * parameter, so its type buys nothing here and making the interface generic in it
 * would force an existential at every ordering that mixes column types — which is
 * every ordering in this codebase.
 */
export interface KeysetColumn<Row> {
  /** Qualified reference, e.g. `journals.entry_date`. Qualified so a joined query is unambiguous. */
  readonly column: string;
  /** The row's value for this column, as a cursor segment. */
  readonly encode: (row: Row) => string;
  /** A cursor segment back to a bindable value. Throws `ValidationError` on anything else. */
  readonly decode: (segment: string) => unknown;
}

/**
 * An ordering, most significant column first, with at least one column.
 *
 * The non-empty tuple type is not decoration: an empty ordering would produce
 * `() > ()`, which is a syntax error at the database rather than a compile error
 * here.
 */
export type KeysetOrdering<Row> = readonly [KeysetColumn<Row>, ...KeysetColumn<Row>[]];

export interface KeysetPage<Row> {
  readonly rows: readonly Row[];
  readonly nextCursor: string | null;
}

/**
 * The cursor's own version, carried inside it.
 *
 * It costs three bytes and it is what lets a later ticket change an ordering
 * without a client's stored cursor silently landing on the wrong column. A cursor
 * from a different version decodes to a refusal, which is the answer a client can
 * act on — start again from the first page.
 */
const CURSOR_VERSION = 1;

/**
 * The page size a caller gets, or a `ValidationError` if they asked for one this
 * API will not serve.
 *
 * Refused rather than clamped, and the reason is in `pagination.ts`: a client that
 * asked for 1,000 and received 200 with no `nextCursor` cannot tell a truncated
 * answer from a complete one.
 *
 * This is the authority, not the Zod schema that restates the same bounds. The
 * HTTP route is not the only caller — an MCP tool (M5) and the workflow engine
 * (M6) reach the same services with no schema in front of them (spec §12) — so the
 * check has to live below every transport.
 */
export function resolvePageLimit(limit: number | undefined): number {
  if (limit === undefined) return PAGE_SIZE_DEFAULT;

  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_SIZE_MAX) {
    throw new ValidationError('Page size is out of range.', [
      {
        path: 'limit',
        message: `Must be a whole number between 1 and ${String(PAGE_SIZE_MAX)}.`,
      },
    ]);
  }

  return limit;
}

/**
 * Adds the keyset predicate, the ordering, and the page bound to a scoped query.
 *
 * Fetches `limit + 1` rows. The extra row is the whole of the "is there more"
 * signal, and it is why this function and `toKeysetPage` are a pair that must be
 * called with the same `limit`: counting the collection instead would be a second
 * query whose answer is stale before it returns, and guessing from a full page
 * would advertise a next page that turns out to be empty.
 */
export function applyKeyset<Row, Builder>(
  builder: Builder,
  ordering: KeysetOrdering<Row>,
  limit: number,
  cursor: string | undefined,
): Builder {
  let query = cursor === undefined ? builder : keysetWhere(builder, ordering, cursor);

  for (const column of ordering) {
    query = (query as Pageable<Builder>).orderBy(sql.ref(column.column), 'asc');
  }

  return (query as Pageable<Builder>).limit(limit + 1);
}

/**
 * Trims the probe row and mints the cursor for the next page.
 *
 * The cursor is built from the last row *of the returned page*, so the next page
 * begins strictly after it. That is what makes the two boundary cases identical
 * rather than special: a page ending in the middle of a run of rows sharing an
 * `entry_date` resumes at the next entry number within that same date, and a page
 * ending exactly on a date boundary resumes at the next date. Neither needs a
 * branch, because the comparison is over the whole tuple.
 */
export function toKeysetPage<Row>(
  rows: readonly Row[],
  ordering: KeysetOrdering<Row>,
  limit: number,
): KeysetPage<Row> {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);

  if (!hasMore || last === undefined) return { rows: page, nextCursor: null };

  return { rows: page, nextCursor: encodeCursor(ordering.map((column) => column.encode(last))) };
}

/**
 * A `DATE` column: a calendar date with no time and no timezone, which the driver
 * keeps as a string for the reason `connection.ts` gives — building a `Date` from
 * `'2026-07-15'` applies a timezone to a value that has none, and that is how an
 * entry lands in the wrong fiscal period.
 */
export function calendarDateKey<Row>(column: string, of: (row: Row) => string): KeysetColumn<Row> {
  const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;
  return {
    column,
    encode: of,
    decode: (segment) => {
      if (!CALENDAR_DATE.test(segment)) throw malformedCursor();
      return segment;
    },
  };
}

/**
 * A `DATETIME(3)` column, carried as an ISO instant.
 *
 * Milliseconds round-trip exactly, which they have to: the column holds three
 * fractional digits, and a cursor that lost them would compare equal to the row it
 * names and return that row a second time. mysql2 formats a bound `Date` with its
 * milliseconds, and the pool runs at `timezone: 'Z'`, so the value that goes back
 * is the value that came out.
 */
export function instantKey<Row>(column: string, of: (row: Row) => Date): KeysetColumn<Row> {
  return {
    column,
    encode: (row) => of(row).toISOString(),
    decode: (segment) => {
      const value = new Date(segment);
      if (Number.isNaN(value.getTime())) throw malformedCursor();
      return value;
    },
  };
}

/**
 * A short `VARCHAR` key — `accounts.code`, immutable since D-27.
 *
 * Both the `ORDER BY` and the `>` in the keyset predicate run under the column's
 * own collation, because a bound parameter is coercible and the column is not, so
 * MySQL resolves the comparison to the column's `utf8mb4_0900_ai_ci`. That is
 * what keeps the two in agreement: an ordering that sorted case-insensitively
 * while the predicate compared bytes would skip or repeat rows at exactly the
 * page boundaries where two codes differ only in case.
 *
 * `maxLength` bounds the cursor segment rather than the column. A segment longer
 * than the column can hold did not come from a row of this table, so it is a
 * malformed cursor and not a query that returns nothing.
 */
export function textKey<Row>(
  column: string,
  of: (row: Row) => string,
  maxLength: number,
): KeysetColumn<Row> {
  return {
    column,
    encode: of,
    decode: (segment) => {
      if (segment.length === 0 || segment.length > maxLength) throw malformedCursor();
      return segment;
    },
  };
}

/** A `BIGINT` counter — `journals.sequence_number`, and `journal_lines.id` later. */
export function counterKey<Row>(column: string, of: (row: Row) => bigint): KeysetColumn<Row> {
  const DIGITS = /^(?:0|[1-9][0-9]*)$/;
  return {
    column,
    encode: (row) => of(row).toString(),
    decode: (segment) => {
      if (!DIGITS.test(segment)) throw malformedCursor();
      return BigInt(segment);
    },
  };
}

/**
 * A `BINARY(16)` id, carried as its UUID text.
 *
 * Through `tryUuidToBuffer` rather than a local hex decode, because the byte order
 * is the thing that is silent when it is wrong (`uuid.ts`) and a second copy is
 * how it gets wrong.
 */
export function uuidKey<Row>(column: string, of: (row: Row) => Buffer): KeysetColumn<Row> {
  return {
    column,
    encode: (row) => bufferToUuid(of(row)),
    decode: (segment) => tryUuidToBuffer(segment) ?? malformedCursorValue(),
  };
}

/**
 * The one capability set this helper needs from a query builder.
 *
 * The assertion is the same one `withOrgScope` in `tenant.ts` makes, for the same
 * reason and with the same limits: `TenantDatabase.selectFrom` is generic over
 * `TenantTableName`, so its methods resolve to a *union* of overload sets that
 * TypeScript declines to call, even though every member accepts these arguments
 * and returns its own type. Narrowing to this interface states exactly that and no
 * more — it is a claim about Kysely's overload resolution, not about the schema.
 */
interface Pageable<Self> {
  where(expression: Expression<SqlBool>): Self;
  orderBy(expression: Expression<unknown>, direction: 'asc'): Self;
  limit(limit: number): Self;
}

/**
 * `(a, b) > (?, ?)` — a row-value comparison rather than the expanded
 * `a > ? OR (a = ? AND b > ?)`.
 *
 * The two are equivalent for non-nullable columns, which every ordering column
 * here is, and the row-value form is the one MySQL 8 can drive from a composite
 * index as a single range scan (8.0.19 and later). It is also the form that cannot
 * be got subtly wrong: the expanded version with `>=` in the first disjunct
 * returns the cursor row itself, which is a duplicate on every page boundary and
 * looks like a rounding-off-by-one rather than the different bug it is.
 */
function keysetWhere<Row, Builder>(
  builder: Builder,
  ordering: KeysetOrdering<Row>,
  cursor: string,
): Builder {
  const segments = decodeCursor(cursor, ordering.length);
  const values = ordering.map((column, index) => {
    const segment = segments[index];
    if (segment === undefined) throw malformedCursor();
    return column.decode(segment);
  });

  const references = ordering.map((column) => sql.ref(column.column));
  const predicate = sql<SqlBool>`(${sql.join(references)}) > (${sql.join(values)})`;

  return (builder as Pageable<Builder>).where(predicate);
}

/**
 * Base64url of a JSON array, opaque to the client by construction rather than by
 * request — see `pagination.ts` for why a readable cursor makes the ordering
 * columns part of the public contract.
 *
 * Not signed. A forged cursor names a position in the caller's own org's list, and
 * `tenantDb` scopes the query regardless of what it says, so there is nothing here
 * for a signature to protect.
 */
function encodeCursor(segments: readonly string[]): string {
  return Buffer.from(JSON.stringify([CURSOR_VERSION, ...segments]), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string, arity: number): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw malformedCursor();
  }

  if (!Array.isArray(parsed) || parsed.length !== arity + 1) throw malformedCursor();
  const [version, ...segments] = parsed as readonly unknown[];
  if (version !== CURSOR_VERSION) throw malformedCursor();
  if (!segments.every((segment): segment is string => typeof segment === 'string')) {
    throw malformedCursor();
  }

  return segments;
}

/**
 * One error for every way a cursor can be wrong, and deliberately no detail about
 * which.
 *
 * The remedy is the same in every case — the cursor did not come from this list's
 * previous page, so start again — and describing the difference would describe the
 * encoding, which is the thing being kept private. Refusing rather than falling
 * back to the first page is the important half: a silent restart turns a client's
 * paging loop into an infinite one.
 */
function malformedCursor(): ValidationError {
  return new ValidationError('Cursor is not valid.', [
    {
      path: 'cursor',
      message:
        'Send the `nextCursor` from this list’s previous page verbatim, or omit it to start at ' +
        'the beginning. A cursor is opaque and is not valid across a change to the list’s ' +
        'ordering.',
    },
  ]);
}

/** `throw` as an expression, for the `??` above. */
function malformedCursorValue(): never {
  throw malformedCursor();
}
