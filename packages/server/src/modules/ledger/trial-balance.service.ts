import { sql } from 'kysely';

import { getContext } from '../../context';
import type { RequestContext } from '../../context';
import { bufferToUuid, orgScope, tenantDb } from '../../db';
import { requirePermission } from '../permissions';

/**
 * The trial balance (acceptance A2).
 *
 * A direct aggregation over `journal_lines`, with no cached balances and no
 * denormalized totals anywhere in the schema. That is a choice, not a deferral
 * (spec §2.6, "the kernel is the least clever code in the system"): a balance cache
 * is a second source of truth for the number the whole system exists to report, and
 * a stale one produces books that balance on screen and not in the data. When this
 * becomes too slow the answer is a view the database maintains, not a counter the
 * application updates.
 *
 * Built with the typed query builder rather than raw SQL, deliberately. Raw SQL here
 * would have to be handed an executor, and the only executor that reaches these
 * tables without org scoping is the one spec §4 says must not exist. Going through
 * `tenantDb` means `accounts.org_id = ?` is applied before this code sees the
 * builder, and the joined tables inherit it by joining on `accounts.org_id`.
 *
 * The aggregation is a plain `SUM` of two columns with no sign handling, which is the
 * payoff for storing debits and credits as separate non-negative columns instead of
 * one signed amount (see `0002_ledger`).
 */

export interface TrialBalanceRow {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  readonly normalBalance: 'debit' | 'credit';
  /** Minor units as a cents-only string (D-13). */
  readonly debits: string;
  readonly credits: string;
  /** `debits - credits`. Negative means the account is net credit. */
  readonly balance: string;
}

export interface TrialBalance {
  readonly asOf: string | null;
  readonly rows: readonly TrialBalanceRow[];
  readonly totalDebits: string;
  readonly totalCredits: string;
  /** Must be `"0"`. Reported rather than asserted — see below. */
  readonly difference: string;
}

export interface TrialBalanceQuery {
  /** Inclusive upper bound on `entry_date`. Omitted means every posting to date. */
  readonly asOf?: string;
}

export async function getTrialBalance(
  query: TrialBalanceQuery = {},
  ctx: RequestContext = getContext('getTrialBalance()'),
): Promise<TrialBalance> {
  await requirePermission(ctx, 'reports.read');

  const orgId = orgScope(ctx.orgId);
  const asOf = query.asOf ?? null;

  const rows = await tenantDb(orgId)
    .selectFrom('accounts')
    // LEFT JOIN from accounts, not from lines: an account with no postings still
    // appears with zeros. A trial balance that silently omits empty accounts hides a
    // chart-of-accounts mistake exactly when someone is looking for one.
    .leftJoin('journal_lines', (join) =>
      join
        .onRef('journal_lines.account_id', '=', 'accounts.id')
        .onRef('journal_lines.org_id', '=', 'accounts.org_id'),
    )
    // The date bound lives in the JOIN condition, not in WHERE. In WHERE it would
    // discard the NULL rows a LEFT JOIN produces, quietly turning this into an inner
    // join and dropping every account with no postings in the window.
    .leftJoin('journals', (join) => {
      const base = join
        .onRef('journals.id', '=', 'journal_lines.journal_id')
        .onRef('journals.org_id', '=', 'journal_lines.org_id');
      return asOf === null ? base : base.on('journals.entry_date', '<=', asOf);
    })
    .select([
      'accounts.id as account_id',
      'accounts.code as code',
      'accounts.name as name',
      'accounts.type as type',
      'accounts.normal_balance as normal_balance',
    ])
    // Aggregates in a second `select` so the column selections above keep their
    // inferred types; mixing plain references and `sql` fragments in one array
    // collapses the row type to an index signature.
    //
    // The sums are gated on the journals join having *matched*, not merely on it
    // being present. Putting the date bound in the JOIN's ON clause is necessary but
    // not sufficient, and the gap is subtle enough that it shipped as a bug and was
    // caught by the asOf test: `journal_lines` is joined directly from `accounts`, so
    // a line whose journal fell outside the window is still in the result and still
    // summed — the journals join going NULL does not remove it. Checking
    // `journals.id IS NOT NULL` inside the aggregate is what actually excludes it.
    .select([inWindowSum('debit_minor').as('debits'), inWindowSum('credit_minor').as('credits')])
    .groupBy([
      'accounts.id',
      'accounts.code',
      'accounts.name',
      'accounts.type',
      'accounts.normal_balance',
    ])
    .orderBy('accounts.code')
    .execute();

  const mapped: TrialBalanceRow[] = rows.map((row) => {
    // MySQL's SUM over a BIGINT column yields DECIMAL, which the driver returns as a
    // string (decimalNumbers is false) rather than as the bigint a plain BIGINT
    // column would give. Normalizing through BigInt keeps the arithmetic exact
    // either way, and matters because a Number() here would reintroduce the
    // precision loss the whole money design exists to avoid.
    const debits = toBigInt(row.debits);
    const credits = toBigInt(row.credits);

    return {
      accountId: bufferToUuid(row.account_id),
      code: row.code,
      name: row.name,
      type: row.type,
      normalBalance: row.normal_balance,
      debits: debits.toString(),
      credits: credits.toString(),
      balance: (debits - credits).toString(),
    };
  });

  const totalDebits = mapped.reduce((total, row) => total + BigInt(row.debits), 0n);
  const totalCredits = mapped.reduce((total, row) => total + BigInt(row.credits), 0n);

  return {
    asOf,
    rows: mapped,
    totalDebits: totalDebits.toString(),
    totalCredits: totalCredits.toString(),
    // Reported, not asserted. This service says what the ledger contains; a non-zero
    // difference is a fact an operator needs to see, not an exception to swallow.
    // Spec §11's property tests and the production integrity job are what turn it
    // into an alert.
    difference: (totalDebits - totalCredits).toString(),
  };
}

/** SUM columns arrive as a DECIMAL string; plain BIGINT columns as a bigint. */
function toBigInt(value: string | number | bigint): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}

/**
 * `SUM` of one amount column, counting only lines whose journal matched the join —
 * i.e. whose `entry_date` fell inside the `asOf` window.
 *
 * Written as a `sql` fragment because it is a conditional aggregate over a column
 * reference, which Kysely's expression builder expresses far less legibly than the
 * SQL does. No values are interpolated: the column name comes from a closed literal
 * union and the rest is fixed text, so there is nothing here to parameterize.
 */
function inWindowSum(column: 'debit_minor' | 'credit_minor') {
  return sql<string>`COALESCE(SUM(CASE WHEN ${sql.ref('journals.id')} IS NOT NULL THEN ${sql.ref(
    `journal_lines.${column}`,
  )} ELSE 0 END), 0)`;
}
