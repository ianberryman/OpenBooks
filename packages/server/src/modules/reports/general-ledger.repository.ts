import type { AccountType } from '@openbooks/shared-types';
import { sql } from 'kysely';
import type { Expression, SqlBool } from 'kysely';

import type { KeysetOrdering, TenantDatabase } from '../../db';
import {
  applyKeyset,
  bufferToUuid,
  calendarDateKey,
  counterKey,
  toKeysetPage,
  tryUuidToBuffer,
} from '../../db';
import { assertFound, InternalError } from '../../errors';

import type { ResolvedDimensionFilter } from './balances.repository';

/**
 * The general ledger's two reads (OB-044; D-14, D-21).
 *
 * The report core aggregates. This lists — one account's journal lines, in
 * `(entry_date, sequence_number, journal_lines.id)` order — and it exists as a
 * second file rather than as more of `balances.repository.ts` because the two are
 * different queries answering different questions. Every number a general ledger
 * *totals* still comes from the core; nothing here re-derives an opening or a
 * closing balance.
 *
 * ## Why the ordering has three columns and not the two D-21 names
 *
 * D-21 orders the ledger by `(entry_date, sequence_number)`, and for the journal
 * list that is total: a journal has one of each. A general ledger's rows are
 * *lines*, and one journal may post to the same account twice — an allocation that
 * debits Rent from two departments in one entry does exactly that. Under two
 * columns those lines compare equal, so the keyset predicate would either skip the
 * rest of a journal or repeat it at a page boundary. `journal_lines.id` is the
 * third column: `AUTO_INCREMENT`, written once, and never updated by anyone (the
 * app user holds no `UPDATE` on the table at all), which is the immutability
 * `keyset.ts` requires of an ordering column. `counterKey`'s own comment names it
 * as the column this ticket would need.
 *
 * ## Why the date bounds are a `WHERE` here and a join condition in the core
 *
 * The core joins out of `accounts` so that an account with no postings still
 * appears at zero, and a bound in its `WHERE` would silently turn that into an
 * inner join. This query starts at `journal_lines` and is a list of lines: an
 * account with nothing in the range has an empty list, which is the right answer
 * and needs no row to carry it. Nothing here is at risk from the bug the core's
 * commentary describes, and a join-condition bound would be the confusing form.
 *
 * ## Why the dimension filter is written out again
 *
 * `dimensionFilterPredicate` in `balances.repository.ts` is private to that file,
 * and OB-044 does not get to widen the core's surface while OB-042 and OB-043 are
 * being written against it. So the semi-join is restated here — with the same
 * shape and for the same reason, because a join on `journal_line_dimensions`
 * multiplies a line by its tag count and this query would then list the same line
 * twice. What keeps the two copies honest is not discipline: the general ledger's
 * movement is asserted equal to the core's movement under the same filters, over
 * generated ledgers, so a divergence between these predicates fails a property.
 */

const ACCOUNT_RESOURCE = 'account';

export interface GeneralLedgerAccount {
  readonly id: Buffer;
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly normalBalance: 'debit' | 'credit';
}

export interface GeneralLedgerSpec {
  readonly accountId: Buffer;
  /** Inclusive lower bound. `null` means the ledger's beginning. */
  readonly from: string | null;
  /** Inclusive upper bound. `null` means every posting to date. */
  readonly to: string | null;
  readonly contactId: Buffer | null;
  readonly dimensions: readonly ResolvedDimensionFilter[];
}

export interface GeneralLedgerLineRow {
  readonly line_id: bigint;
  readonly journal_id: Buffer;
  readonly sequence_number: bigint;
  readonly entry_date: string;
  readonly line_number: number;
  readonly journal_memo: string | null;
  readonly line_memo: string | null;
  readonly debit_minor: bigint;
  readonly credit_minor: bigint;
  readonly contact_id: Buffer | null;
  readonly contact_name: string | null;
}

/**
 * The ordering, and therefore the cursor. Three immutable columns; see the note at
 * the top of this file for why the third is not optional.
 */
const GENERAL_LEDGER_KEYSET: KeysetOrdering<GeneralLedgerLineRow> = [
  calendarDateKey('journals.entry_date', (row) => row.entry_date),
  counterKey('journals.sequence_number', (row) => row.sequence_number),
  counterKey('journal_lines.id', (row) => row.line_id),
];

/**
 * The account the ledger is about, refused as a 404 if this org does not own it.
 *
 * Resolved here rather than taken from the core's rows, for the reason A7 states:
 * a malformed id, another org's id, and one that never existed must be the same
 * answer, and picking a row out of a report by id would instead produce an empty
 * ledger — a page of zeros, which is a number someone might act on.
 */
export async function resolveLedgerAccount(
  db: TenantDatabase,
  accountId: string,
): Promise<GeneralLedgerAccount> {
  const id = assertFound(tryUuidToBuffer(accountId), ACCOUNT_RESOURCE);
  const row = assertFound(
    await db
      .selectFrom('accounts')
      .select(['id', 'code', 'name', 'type', 'normal_balance'])
      .where('id', '=', id)
      .executeTakeFirst(),
    ACCOUNT_RESOURCE,
  );

  return {
    id: row.id,
    // Re-derived from the stored bytes rather than echoed from the request, so
    // that the id this report is keyed on has one spelling. `z.uuid()` accepts an
    // upper-case UUID and `bufferToUuid` emits a lower-case one, and comparing the
    // two forms is how a row goes missing from a report that contains it.
    accountId: bufferToUuid(row.id),
    code: row.code,
    name: row.name,
    type: row.type,
    normalBalance: row.normal_balance,
  };
}

export interface GeneralLedgerLinePage {
  readonly rows: readonly GeneralLedgerLineRow[];
  readonly nextCursor: string | null;
}

/** One page of the account's lines inside the range, oldest first. */
export async function selectGeneralLedgerLines(
  db: TenantDatabase,
  spec: GeneralLedgerSpec,
  limit: number,
  cursor: string | undefined,
): Promise<GeneralLedgerLinePage> {
  const built = movementScope(db, spec)
    // `contacts` is joined rather than read in a second pass, unlike the tags and
    // the counterparties below. A line names at most one contact, so the join can
    // duplicate nothing — the property that makes the other two second queries.
    .leftJoin('contacts', (join) =>
      join
        .onRef('contacts.id', '=', 'journal_lines.contact_id')
        .onRef('contacts.org_id', '=', 'journal_lines.org_id'),
    )
    .select([
      'journal_lines.id as line_id',
      'journal_lines.journal_id as journal_id',
      'journals.sequence_number as sequence_number',
      'journals.entry_date as entry_date',
      'journal_lines.line_number as line_number',
      'journals.memo as journal_memo',
      'journal_lines.memo as line_memo',
      'journal_lines.debit_minor as debit_minor',
      'journal_lines.credit_minor as credit_minor',
      'journal_lines.contact_id as contact_id',
      'contacts.display_name as contact_name',
    ]);

  const rows = await applyKeyset(built, GENERAL_LEDGER_KEYSET, limit, cursor).execute();
  const page = toKeysetPage<GeneralLedgerLineRow>(rows, GENERAL_LEDGER_KEYSET, limit);

  return { rows: page.rows, nextCursor: page.nextCursor };
}

export interface MovementTotals {
  readonly debits: bigint;
  readonly credits: bigint;
}

/**
 * The movement this page inherits: every in-range line for the account that sorts
 * strictly before `boundary`.
 *
 * This is the whole of how a running balance survives paging, and it is a query
 * rather than a number carried in the cursor deliberately. See
 * `general-ledger.service.ts` for the argument; what matters here is that the
 * boundary is taken from *the first row of the page just fetched*, not from the
 * cursor the caller sent. The two agree — the page's first row is by construction
 * the least row above the cursor at the moment the page was read — and taking it
 * from the row means this file never decodes a cursor, so there is exactly one
 * cursor format in the system and `keyset.ts` owns it.
 */
export async function selectMovementBefore(
  db: TenantDatabase,
  spec: GeneralLedgerSpec,
  boundary: GeneralLedgerLineRow,
): Promise<MovementTotals> {
  const row = await movementScope(db, spec)
    .where(
      // The same row-value comparison `keyset.ts` builds, in the opposite
      // direction, over the same three columns. `<` and not `<=`: the boundary row
      // is the first row of the page, and its own amount is added by the running
      // accumulation rather than by this sum.
      sql<SqlBool>`(${sql.ref('journals.entry_date')}, ${sql.ref(
        'journals.sequence_number',
      )}, ${sql.ref('journal_lines.id')}) < (${boundary.entry_date}, ${
        boundary.sequence_number
      }, ${boundary.line_id})`,
    )
    .select([
      sql<string>`COALESCE(SUM(${sql.ref('journal_lines.debit_minor')}), 0)`.as('debits'),
      sql<string>`COALESCE(SUM(${sql.ref('journal_lines.credit_minor')}), 0)`.as('credits'),
    ])
    .executeTakeFirst();

  if (row === undefined) {
    // An aggregate with no GROUP BY returns exactly one row, always. Reaching here
    // means the driver returned something this code cannot reason about, which is
    // a fault in this process rather than an empty result.
    throw new InternalError('A bare aggregate over journal lines returned no row.');
  }

  return { debits: BigInt(row.debits), credits: BigInt(row.credits) };
}

export interface CounterpartyLineRow {
  readonly journal_id: Buffer;
  readonly is_debit: boolean;
  readonly account_id: Buffer;
  readonly code: string;
  readonly name: string;
}

/**
 * Every line of the page's journals, so the service can name the other side.
 *
 * Deliberately **unfiltered** by the report's contact and dimension filters. What
 * is on the other side of an entry is a fact about the entry, and a ledger sliced
 * to one department whose rows showed no counterparty would be describing the
 * slice rather than the books.
 */
export async function selectCounterpartyLines(
  db: TenantDatabase,
  journalIds: readonly Buffer[],
): Promise<readonly CounterpartyLineRow[]> {
  if (journalIds.length === 0) return [];

  const rows = await db
    .selectFrom('journal_lines')
    .innerJoin('accounts', (join) =>
      join
        .onRef('accounts.id', '=', 'journal_lines.account_id')
        .onRef('accounts.org_id', '=', 'journal_lines.org_id'),
    )
    .where('journal_lines.journal_id', 'in', [...journalIds])
    .select([
      'journal_lines.journal_id as journal_id',
      'journal_lines.debit_minor as debit_minor',
      'accounts.id as account_id',
      'accounts.code as code',
      'accounts.name as name',
    ])
    .execute();

  return rows.map((row) => ({
    journal_id: row.journal_id,
    // `chk_journal_lines_one_sided` makes exactly one of the two columns positive,
    // so this is the side and not an approximation of it.
    is_debit: row.debit_minor > 0n,
    account_id: row.account_id,
    code: row.code,
    name: row.name,
  }));
}

export interface LineTagRow {
  readonly journal_line_id: bigint;
  readonly dimension_id: Buffer;
  readonly dimension_code: string;
  readonly dimension_value_id: Buffer;
  readonly code: string;
  readonly name: string;
}

/**
 * The tags on the page's lines, read after the page rather than joined into it.
 *
 * A join would multiply a line by the number of axes it carries — the row
 * multiplication D-18 warned about — and this query's rows *are* the report, so
 * the duplication would be visible rather than merely wrong in a sum.
 *
 * Archived axes and archived values are read like any other, for the reason
 * `selectDimensionValueLabels` gives: a tag a posted line carries belongs in every
 * report covering the period it was posted in.
 */
export async function selectLineTags(
  db: TenantDatabase,
  lineIds: readonly bigint[],
): Promise<readonly LineTagRow[]> {
  if (lineIds.length === 0) return [];

  return await db
    .selectFrom('journal_line_dimensions')
    .innerJoin('dimensions', (join) =>
      join
        .onRef('dimensions.id', '=', 'journal_line_dimensions.dimension_id')
        .onRef('dimensions.org_id', '=', 'journal_line_dimensions.org_id'),
    )
    .innerJoin('dimension_values', (join) =>
      join
        .onRef('dimension_values.id', '=', 'journal_line_dimensions.dimension_value_id')
        .onRef('dimension_values.org_id', '=', 'journal_line_dimensions.org_id'),
    )
    .where('journal_line_dimensions.journal_line_id', 'in', [...lineIds])
    .select([
      'journal_line_dimensions.journal_line_id as journal_line_id',
      'dimensions.id as dimension_id',
      'dimensions.code as dimension_code',
      'dimension_values.id as dimension_value_id',
      'dimension_values.code as code',
      'dimension_values.name as name',
    ])
    .execute();
}

/**
 * The account's lines inside the range, under the report's filters — the row set
 * both the page and the prefix sum are windows on.
 *
 * One builder for both, so the two cannot disagree about what "in the range" or
 * "matching the filter" means. A running balance computed over a slightly
 * different row set than the rows it is printed against is the failure this shares
 * a function to make unrepresentable.
 */
function movementScope(db: TenantDatabase, spec: GeneralLedgerSpec) {
  let query = db
    .selectFrom('journal_lines')
    .innerJoin('journals', (join) =>
      join
        .onRef('journals.id', '=', 'journal_lines.journal_id')
        .onRef('journals.org_id', '=', 'journal_lines.org_id'),
    )
    .where('journal_lines.account_id', '=', spec.accountId);

  if (spec.from !== null) query = query.where('journals.entry_date', '>=', spec.from);
  if (spec.to !== null) query = query.where('journals.entry_date', '<=', spec.to);
  if (spec.contactId !== null) {
    query = query.where('journal_lines.contact_id', '=', spec.contactId);
  }

  for (const [index, filter] of spec.dimensions.entries()) {
    query = query.where(dimensionFilterPredicate(filter, index));
  }

  return query;
}

/**
 * "This line carries one of these values on this axis" — as a semi-join.
 *
 * The restatement of `balances.repository.ts`'s predicate that the note at the top
 * of this file explains. `EXISTS` rather than a join for the same reason, and the
 * `NOT EXISTS` branch is the drill-through from a grouped report's unassigned
 * bucket (D-18), which is the case this report exists to answer.
 */
function dimensionFilterPredicate(
  filter: ResolvedDimensionFilter,
  index: number,
): Expression<SqlBool> {
  const name = `gl_jld_${String(index)}`;
  const alias = sql.table(name);
  const correlation = sql`
    ${sql.ref(`${name}.org_id`)} = ${sql.ref('journal_lines.org_id')}
    AND ${sql.ref(`${name}.journal_line_id`)} = ${sql.ref('journal_lines.id')}
    AND ${sql.ref(`${name}.dimension_id`)} = ${filter.dimensionId}
  `;

  const branches: Expression<SqlBool>[] = [];

  if (filter.valueIds.length > 0) {
    branches.push(sql<SqlBool>`EXISTS (
      SELECT 1 FROM journal_line_dimensions AS ${alias}
      WHERE ${correlation}
        AND ${sql.ref(`${name}.dimension_value_id`)} IN (${sql.join([...filter.valueIds])})
    )`);
  }

  if (filter.includeUnassigned) {
    branches.push(sql<SqlBool>`NOT EXISTS (
      SELECT 1 FROM journal_line_dimensions AS ${alias}
      WHERE ${correlation}
    )`);
  }

  const [first, second] = branches;
  if (first === undefined) {
    throw new InternalError(
      'A dimension filter named no values and did not include the unassigned bucket, so there ' +
        'is no predicate to apply. Report queries must be parsed before they reach the ' +
        'repository.',
    );
  }

  return second === undefined ? first : sql<SqlBool>`(${first} OR ${second})`;
}
