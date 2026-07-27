import type { AccountType } from '@openbooks/shared-types';
import { sql } from 'kysely';
import type { Expression, SqlBool } from 'kysely';

import type { RequestContext } from '../../context';
import type { TenantDatabase } from '../../db';
import {
  bufferToUuid,
  orgScope as toOrgId,
  tenantDb,
  tryUuidToBuffer,
  uuidToBuffer,
} from '../../db';
import { assertFound, InternalError } from '../../errors';

import type { AccountBalance } from './amounts';
import { amountsOf, balanceOf } from './amounts';

/**
 * The aggregation itself (OB-041; spec §2.6).
 *
 * One statement produces every number in every M2 report. It is a direct `SUM`
 * over `journal_lines` with no balance cache and no denormalized total anywhere,
 * which is the same choice `trial-balance.service.ts` makes and the same argument:
 * a cache is a second source of truth for the numbers the system exists to report,
 * and a stale one produces books that balance on screen and not in the data.
 *
 * The trial balance is this query's oracle, so its two hard-won details are
 * reproduced here deliberately rather than rediscovered:
 *
 *  - **The join runs from `accounts`, not from lines**, so an account with no
 *    postings appears with zeros instead of vanishing.
 *  - **The upper date bound lives in the `journals` JOIN condition and the
 *    aggregates test `journals.id IS NOT NULL`.** In a `WHERE` clause the bound
 *    would discard the NULL rows the LEFT JOIN produces and quietly become an
 *    inner join; and the ON clause alone is not sufficient either, because
 *    `journal_lines` is joined straight from `accounts` — a line whose journal
 *    fell outside the window survives the journals join going NULL and is still
 *    summed. That gap shipped as a bug in M1 and was caught by the `asOf` test.
 *    Both halves are needed.
 *
 * Drafts are not readable from here at all, and that is not an omission: a draft
 * has not happened (D-19), so no report reads `journal_drafts`. There is no
 * statement in this module that names those tables.
 *
 * ## Why one query and not two
 *
 * Opening and movement are two windows over the same rows, so they are two
 * conditional aggregates rather than two statements. Two statements would read the
 * ledger twice and — worse — would describe the boundary between them twice, which
 * is exactly where an off-by-one day hides. Here `< from` and `>= from` are written
 * next to each other in one pair of `CASE`s, so the boundary is a single fact. B4
 * (opening + movement = closing) then follows from `balanceOf` rather than from two
 * queries agreeing.
 *
 * ## Multi-axis filtering, and the row multiplication D-18 warned about
 *
 * `journal_line_dimensions` holds one row per line per axis, so joining it without
 * naming an axis multiplies a line by the number of axes it carries — and every
 * amount on it is then counted that many times. The two places tags are touched
 * here are both shaped so that cannot happen:
 *
 *  - **A filter is a semi-join** (`EXISTS`), never a join. A subquery cannot add
 *    rows to the result no matter how many tags a line carries, so the number of
 *    filters is unrelated to the arithmetic. `idx_jld_org_dimension_value` is the
 *    access path for it — the index D-18 predicted would have to be designed
 *    rather than inherited from the tenancy pattern.
 *  - **Grouping joins exactly one axis**, pinned by `dimension_id = ?`. The
 *    primary key `(org_id, journal_line_id, dimension_id)` makes that at most one
 *    row per line, so the join can duplicate nothing, and a `LEFT` join is what
 *    keeps untagged lines in the result with a NULL key — the unassigned bucket B6
 *    requires, and the reason it cannot be forgotten.
 */

/**
 * Resource tokens for the ids a filter can name.
 *
 * Restated here rather than imported from `contacts.repository` and
 * `dimensions.repository`. The tokens are three short strings, and the alternative
 * is an import edge asserting that reporting is built on those modules'
 * *internals* — the argument `errors/parse.ts` makes about a module reaching into
 * a sibling. What A7 requires is that every 404 for a given resource is
 * byte-identical, which holds as long as the token is spelled the same; these are
 * the spellings.
 */
const CONTACT_RESOURCE = 'contact';
const DIMENSION_RESOURCE = 'dimension';
const DIMENSION_VALUE_RESOURCE = 'dimension_value';

/** A filter with every client-supplied id resolved to bytes this org owns. */
export interface ResolvedDimensionFilter {
  readonly dimensionId: Buffer;
  readonly valueIds: readonly Buffer[];
  readonly includeUnassigned: boolean;
}

export interface BalanceQuerySpec {
  /** Inclusive lower bound. `null` means the ledger's beginning, so no opening. */
  readonly from: string | null;
  /** Inclusive upper bound. `null` means every posting to date. */
  readonly to: string | null;
  readonly types: readonly AccountType[] | null;
  /**
   * The accounts to report on, or `null` for the whole chart. An empty list is a
   * report on no accounts, not an absent filter.
   */
  readonly accountIds: readonly Buffer[] | null;
  readonly contactId: Buffer | null;
  readonly dimensions: readonly ResolvedDimensionFilter[];
  /** The axis to group by, or `null` for an ungrouped report. */
  readonly groupBy: Buffer | null;
}

export interface AggregatedBalanceRow {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly normalBalance: 'debit' | 'credit';
  readonly parentAccountId: string | null;
  readonly isActive: boolean;
  /** The dimension value this bucket belongs to, or `null` for unassigned. */
  readonly groupValueId: string | null;
  readonly balance: AccountBalance;
}

export function orgScope(ctx: RequestContext): TenantDatabase {
  return tenantDb(toOrgId(ctx.orgId));
}

export async function selectAccountBalances(
  db: TenantDatabase,
  spec: BalanceQuerySpec,
): Promise<readonly AggregatedBalanceRow[]> {
  const posted = sql<SqlBool>`${sql.ref('journals.id')} IS NOT NULL`;
  const entryDate = sql.ref('journals.entry_date');
  const from = spec.from;

  const openingWindow: Expression<SqlBool> | null =
    from === null ? null : sql<SqlBool>`${posted} AND ${entryDate} < ${from}`;
  const movementWindow: Expression<SqlBool> =
    from === null ? posted : sql<SqlBool>`${posted} AND ${entryDate} >= ${from}`;

  const joined = db
    .selectFrom('accounts')
    .leftJoin('journal_lines', (join) => {
      let on = join
        .onRef('journal_lines.account_id', '=', 'accounts.id')
        .onRef('journal_lines.org_id', '=', 'accounts.org_id');

      // Line-level filters belong in this ON clause and nowhere else. In a WHERE
      // they would drop every account whose lines all failed the filter, so a
      // report filtered to one department would lose the rest of the chart instead
      // of showing it at zero — and an account missing from a report is read as an
      // account with nothing in it.
      if (spec.contactId !== null) {
        on = on.on('journal_lines.contact_id', '=', spec.contactId);
      }
      for (const [index, filter] of spec.dimensions.entries()) {
        on = on.on(dimensionFilterPredicate(filter, index));
      }

      return on;
    })
    .leftJoin('journals', (join) => {
      const on = join
        .onRef('journals.id', '=', 'journal_lines.journal_id')
        .onRef('journals.org_id', '=', 'journal_lines.org_id');

      return spec.to === null ? on : on.on('journals.entry_date', '<=', spec.to);
    })
    // Joined unconditionally, with an unsatisfiable condition when there is no
    // axis. An ungrouped report is then *literally* a grouped report in which
    // every line landed in the unassigned bucket, which is the identity B6
    // asserts — held by construction rather than by two code paths agreeing.
    // MySQL folds `ON FALSE` into a constant NULL row, so the ungrouped case pays
    // nothing for it.
    .leftJoin('journal_line_dimensions', (join) =>
      join
        .onRef('journal_line_dimensions.journal_line_id', '=', 'journal_lines.id')
        .onRef('journal_line_dimensions.org_id', '=', 'journal_lines.org_id')
        .on(
          spec.groupBy === null
            ? sql<SqlBool>`FALSE`
            : sql<SqlBool>`${sql.ref('journal_line_dimensions.dimension_id')} = ${spec.groupBy}`,
        ),
    );

  // The two filters that are WHERE clauses rather than join conditions, because
  // they are the only ones that are statements about accounts. Removing an account
  // is what is wanted here; removing a line is not.
  let scoped = spec.types === null ? joined : joined.where('accounts.type', 'in', [...spec.types]);
  if (spec.accountIds !== null) {
    // An empty list is a report on no accounts. `IN ()` is a syntax error in
    // MySQL, and folding the empty case back to "no filter" would answer a
    // request for nothing with the entire chart — the failure mode this filter's
    // property exists to rule out. `FALSE` is the honest empty set, and MySQL
    // folds it before it reads a row.
    scoped =
      spec.accountIds.length === 0
        ? scoped.where(sql<SqlBool>`FALSE`)
        : scoped.where('accounts.id', 'in', [...spec.accountIds]);
  }

  const rows = await scoped
    .select([
      'accounts.id as account_id',
      'accounts.code as code',
      'accounts.name as name',
      'accounts.type as type',
      'accounts.normal_balance as normal_balance',
      'accounts.parent_account_id as parent_account_id',
      'accounts.is_active as is_active',
      'journal_line_dimensions.dimension_value_id as group_value_id',
    ])
    // Aggregates in a second `select` so the plain column selections above keep
    // their inferred types — mixing references and `sql` fragments in one array
    // collapses the row type to an index signature.
    .select([
      windowSum('debit_minor', openingWindow).as('opening_debits'),
      windowSum('credit_minor', openingWindow).as('opening_credits'),
      windowSum('debit_minor', movementWindow).as('movement_debits'),
      windowSum('credit_minor', movementWindow).as('movement_credits'),
    ])
    .groupBy([
      'accounts.id',
      'accounts.code',
      'accounts.name',
      'accounts.type',
      'accounts.normal_balance',
      'accounts.parent_account_id',
      'accounts.is_active',
      'journal_line_dimensions.dimension_value_id',
    ])
    .orderBy('accounts.code')
    .execute();

  return rows.map((row) => ({
    accountId: bufferToUuid(row.account_id),
    code: row.code,
    name: row.name,
    type: row.type,
    normalBalance: row.normal_balance,
    parentAccountId: row.parent_account_id === null ? null : bufferToUuid(row.parent_account_id),
    isActive: row.is_active === 1,
    groupValueId: row.group_value_id === null ? null : bufferToUuid(row.group_value_id),
    balance: balanceOf(
      amountsOf(toBigInt(row.opening_debits), toBigInt(row.opening_credits)),
      amountsOf(toBigInt(row.movement_debits), toBigInt(row.movement_credits)),
    ),
  }));
}

export interface DimensionValueLabel {
  readonly code: string;
  readonly name: string;
}

/**
 * Names for the buckets a grouped report produced, read after the aggregation
 * rather than joined into it.
 *
 * Joining `dimension_values` would put two more columns in the `GROUP BY` — a
 * wider grouping key on the largest query in the system, to fetch two strings that
 * are identical for every row of a bucket.
 *
 * Archived values are read like any other. An axis value that lines still carry
 * belongs in every report covering the period they were posted in, and one
 * appearing without a name would be worse than useless.
 */
export async function selectDimensionValueLabels(
  db: TenantDatabase,
  valueIds: readonly string[],
): Promise<ReadonlyMap<string, DimensionValueLabel>> {
  if (valueIds.length === 0) return new Map();

  const rows = await db
    .selectFrom('dimension_values')
    .select(['id', 'code', 'name'])
    // `uuidToBuffer` rather than the forgiving `tryUuidToBuffer`: these ids were
    // produced by `bufferToUuid` from this same query's rows a moment ago, so a
    // malformed one is a fault in this process rather than client input.
    .where(
      'id',
      'in',
      valueIds.map((id) => uuidToBuffer(id)),
    )
    .execute();

  return new Map(rows.map((row) => [bufferToUuid(row.id), { code: row.code, name: row.name }]));
}

/**
 * A dimension id this org owns, as bytes.
 *
 * Resolved rather than passed through, and the reason is that the alternative is
 * silent: an id belonging to another org — or one with a typo in it — would filter
 * to nothing and produce a report of zeros, which is a number someone might act
 * on. Through `assertFound`, a malformed id, a nonexistent one and another org's
 * are one indistinguishable 404 (A7).
 *
 * Archived axes resolve. A report of a past period is sliced by the axis that was
 * in use then, and refusing that would make archiving equivalent to deleting the
 * history it exists to preserve.
 */
export async function resolveDimension(db: TenantDatabase, dimensionId: string): Promise<Buffer> {
  const id = assertFound(tryUuidToBuffer(dimensionId), DIMENSION_RESOURCE);
  const row = await db
    .selectFrom('dimensions')
    .select('id')
    .where('id', '=', id)
    .executeTakeFirst();

  return assertFound(row, DIMENSION_RESOURCE).id;
}

/**
 * The values named by a filter, checked to belong to the axis it names.
 *
 * The membership check is the point: a value that exists but sits on another axis
 * matches no tag on the axis being filtered, so accepting it would again mean a
 * report of zeros. `(org_id, dimension_id, id)` is the key `fk_jld_value`
 * references, so "belongs to this axis" is one predicate rather than a second read.
 */
export async function resolveDimensionValues(
  db: TenantDatabase,
  dimensionId: Buffer,
  valueIds: readonly string[],
): Promise<readonly Buffer[]> {
  if (valueIds.length === 0) return [];

  const ids = valueIds.map((valueId) =>
    assertFound(tryUuidToBuffer(valueId), DIMENSION_VALUE_RESOURCE),
  );

  const rows = await db
    .selectFrom('dimension_values')
    .select('id')
    .where('dimension_id', '=', dimensionId)
    .where('id', 'in', ids)
    .execute();

  const found = new Set(rows.map((row) => row.id.toString('hex')));
  for (const id of ids) {
    assertFound(found.has(id.toString('hex')) ? id : undefined, DIMENSION_VALUE_RESOURCE);
  }

  return ids;
}

export async function resolveContact(db: TenantDatabase, contactId: string): Promise<Buffer> {
  const id = assertFound(tryUuidToBuffer(contactId), CONTACT_RESOURCE);
  const row = await db.selectFrom('contacts').select('id').where('id', '=', id).executeTakeFirst();

  return assertFound(row, CONTACT_RESOURCE).id;
}

/**
 * `SUM` of one amount column over one date window.
 *
 * A `sql` fragment because it is a conditional aggregate over a column reference,
 * which Kysely's expression builder expresses far less legibly than SQL does. The
 * column name comes from a closed literal union and the window is an expression
 * built above, so the only interpolated values are bound parameters.
 *
 * A `null` window is the opening half of a report with no lower bound: there is no
 * "before the range" to sum, so this is the constant zero rather than a predicate
 * that can never be true. The two are equal, and the constant is what tells a
 * reader that an unbounded report has no opening balance by definition.
 */
function windowSum(column: 'debit_minor' | 'credit_minor', window: Expression<SqlBool> | null) {
  if (window === null) return sql<string>`0`;

  return sql<string>`COALESCE(SUM(CASE WHEN ${window} THEN ${sql.ref(
    `journal_lines.${column}`,
  )} ELSE 0 END), 0)`;
}

/**
 * "This line carries one of these values on this axis" — as a semi-join.
 *
 * `EXISTS` rather than a join, for the reason at the top of this file: a join on
 * `journal_line_dimensions` multiplies a line by its tag count, and a filtered
 * report would then overstate exactly the lines somebody tagged most carefully. A
 * subquery cannot change the outer row count whatever it finds.
 *
 * The `NOT EXISTS` branch is the untagged half, and it is what makes the
 * unassigned bucket clickable: a grouped report always shows a total for lines
 * nobody tagged (D-18), and drilling into that total asks for exactly the lines
 * this branch describes. Without it the bucket would be a number with nothing
 * behind it.
 *
 * Org scoping comes from `journal_lines.org_id`, which `tenantDb` has already
 * pinned through the join chain from `accounts` — the same way every other join in
 * this query inherits it.
 *
 * Exported because the general ledger applies the same filter to a different
 * query. It was restated there while OB-042, OB-043 and OB-044 were being written
 * against this file at once, and the two copies were byte-identical apart from the
 * alias prefix — a divergence waiting to happen with a property standing over it
 * rather than a second implementation worth keeping. The predicate correlates only
 * to `journal_lines`, so it is equally at home in this query's `ON` clause and in
 * the general ledger's `WHERE`; nothing about it depends on the shape around it.
 */
export function dimensionFilterPredicate(
  filter: ResolvedDimensionFilter,
  index: number,
): Expression<SqlBool> {
  // A distinct alias per filter, so several of these can appear in one ON clause
  // without shadowing the outer table they correlate to.
  const name = `jld_filter_${String(index)}`;
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
    // `reportDimensionFilterSchema` refuses a filter naming neither values nor the
    // unassigned bucket, so reaching here means a caller built a spec by hand and
    // skipped the parse — a wiring fault in this process, not the caller's input.
    throw new InternalError(
      'A dimension filter named no values and did not include the unassigned bucket, so there ' +
        'is no predicate to apply. Report queries must be parsed before they reach the ' +
        'repository.',
    );
  }

  return second === undefined ? first : sql<SqlBool>`(${first} OR ${second})`;
}

/** `SUM` arrives as a DECIMAL string; the constant-zero column as a number. */
function toBigInt(value: string | number | bigint): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}
