import type { AccountBalancesQueryParams } from '@openbooks/shared-types';
import { accountBalancesQuerySchema } from '@openbooks/shared-types';

import { getContext } from '../../context';
import type { RequestContext } from '../../context';
import type { TenantDatabase } from '../../db';
import { uuidToBuffer } from '../../db';
import { InternalError, parseInput } from '../../errors';
import { requirePermission } from '../permissions';

import type { AccountBalance } from './amounts';
import {
  addAccountBalance,
  isZeroBalance,
  sumAccountBalances,
  ZERO_ACCOUNT_BALANCE,
} from './amounts';
import type {
  AggregatedBalanceRow,
  BalanceQuerySpec,
  DimensionValueLabel,
  ResolvedDimensionFilter,
} from './balances.repository';
import {
  orgScope,
  resolveContact,
  resolveDimension,
  resolveDimensionValues,
  selectAccountBalances,
  selectDimensionValueLabels,
} from './balances.repository';
import type { AccountBalanceNode, AccountBalanceRow } from './tree';
import { buildAccountTree } from './tree';

/**
 * The report core (OB-041). Read `index.ts` for the shape the three M2 reports
 * project from it and for how each of them uses the range.
 *
 * Two things are decided here rather than in the repository, because both are
 * about what a report *is* rather than about what the database returns.
 *
 * ## Every group holds every account
 *
 * The aggregation is sparse: an account whose postings are all tagged `SALES`
 * produces a row in the `SALES` bucket and in no other. The report is dense — each
 * group carries a row for every account in the chart, at zero where the ledger had
 * nothing — and it costs accounts × groups rows in memory to make it so.
 *
 * That is bought deliberately, for two reasons that are both about the invariants
 * this ticket exists to hold. B6 ("every report unsliced equals its slices plus
 * unassigned") is a per-account statement, and stating it over groups with
 * different account sets means the comparison itself has to invent the missing
 * zeros — which is the arithmetic under test. And B7 needs each group's forest to
 * be a forest: a parent absent from a group because nothing was tagged against it,
 * while its children are present, would leave a subtotal with nowhere to live.
 * Sparse groups would have to synthesize both, in every consumer.
 *
 * ## Which groups exist
 *
 * A bucket per dimension value the window actually contains, plus the unassigned
 * bucket **always**. The unassigned bucket is not conditional on there being
 * untagged lines: D-18 is explicit that a slice view which omits untagged lines
 * shows a smaller business than exists, and a consumer that has to check whether
 * the bucket is present is a consumer that will forget. An empty bucket is a
 * column of zeros; a missing one is a wrong total.
 *
 * Values with no activity in the window are dropped, and only those. They arise
 * because tags are joined to lines rather than to journals, so a line excluded by
 * the date bound still carries its tag into the grouping — leaving a bucket whose
 * every amount is zero. Dropping it changes no sum.
 */

export interface ReportRange {
  /** Inclusive. `null` when the report starts at the ledger's beginning. */
  readonly from: string | null;
  /** Inclusive. `null` when every posting to date is in. */
  readonly to: string | null;
}

export interface ReportGroupKey {
  readonly dimensionValueId: string;
  readonly code: string;
  readonly name: string;
}

export interface ReportGroup {
  /** `null` is the unassigned bucket — lines carrying no value on the grouped axis. */
  readonly key: ReportGroupKey | null;
  /** One row per account in the chart, ordered by code. */
  readonly rows: readonly AccountBalanceRow[];
  /** The same rows as a forest, each node carrying its subtree's subtotal (B7). */
  readonly tree: readonly AccountBalanceNode[];
  /** The sum of `rows`. Equal to the sum of `tree`'s roots' subtotals. */
  readonly totals: AccountBalance;
}

export interface AccountBalances {
  readonly range: ReportRange;
  /** The axis grouped by, echoed back, or `null` for an ungrouped report. */
  readonly groupBy: string | null;
  /**
   * Buckets in value-code order, unassigned last. An ungrouped report has exactly
   * one group, and its key is `null`.
   */
  readonly groups: readonly ReportGroup[];
  /** The sum of every group. Equal to the same query's totals ungrouped (B6). */
  readonly totals: AccountBalance;
}

export type AccountBalancesQuery = AccountBalancesQueryParams;

/**
 * Narrowings the core accepts from its own callers and from nobody else.
 *
 * A third parameter rather than a field on the query, and the reason is that
 * "internal" has to be a property of the signature rather than of a convention.
 * The query is parsed from a strict zod schema published in `shared-types`, which
 * is exactly the schema a route hands a client-supplied object to. There were
 * three honest ways to add a narrowing to it and this is the only one where a
 * client cannot reach the field at all:
 *
 *  - **A field on the wire schema.** Every report would then advertise "give me
 *    these account ids", which no client needs — the P&L and the balance sheet
 *    take the whole chart, and the general ledger names its one account through
 *    `accountId` already — and A10 would freeze it into `openapi.json` where
 *    removing it later is a breaking change.
 *  - **A field stripped off the query before the parse.** Cheap, and it puts a
 *    JSON-spellable key on the object a handler passes through; the only thing
 *    keeping it off the wire is every wire schema staying strict, which is
 *    discipline rather than the build.
 *  - **A separate parameter.** Nothing a request body can carry ever lands here,
 *    because a body is one value and this is a different argument.
 *
 * The cost is paid in the signature: the core is no longer uniformly
 * `(query, ctx)`, and a caller that wants an option has to pass `ctx` explicitly
 * to reach past its default. Both are visible at every call site, which is the
 * right place for the cost of an internal back door to sit.
 */
export interface AccountBalancesOptions {
  /**
   * Report on these accounts only. Ids as they appear on the wire; they are this
   * process's own, so a malformed one throws rather than 404s.
   */
  readonly accountIds?: readonly string[];
}

/**
 * Account balances over a date range, optionally filtered and optionally grouped
 * by a dimension axis.
 *
 * `reports.read` and nothing else. Filtering by a contact or a dimension resolves
 * ids in those modules' tables, which is a read the report performs on the
 * caller's behalf rather than a capability the caller needs separately — requiring
 * `dimensions.read` as well would make a report's permission depend on which
 * filters were sent, and a role that could run a report but not slice it is not a
 * distinction any of the six seeded roles draws.
 */
export async function getAccountBalances(
  query: AccountBalancesQuery = {},
  ctx: RequestContext = getContext('getAccountBalances()'),
  options: AccountBalancesOptions = {},
): Promise<AccountBalances> {
  await requirePermission(ctx, 'reports.read');
  const request = parseInput(accountBalancesQuerySchema, query);

  const db = orgScope(ctx);
  const spec = await resolveSpec(db, request, options);
  const rows = await selectAccountBalances(db, spec);

  return assemble(rows, {
    range: { from: spec.from, to: spec.to },
    groupBy: request.groupBy ?? null,
    labels: await labelsFor(db, rows),
  });
}

/**
 * Turns the parsed query into bytes, refusing anything this org does not own.
 *
 * Sequential rather than concurrent: the resolutions are point reads on primary
 * keys, and the first refusal should be the one reported. Running them together
 * would make which 404 a caller sees depend on which query finished first.
 */
async function resolveSpec(
  db: TenantDatabase,
  request: AccountBalancesQuery,
  options: AccountBalancesOptions,
): Promise<BalanceQuerySpec> {
  const dimensions: ResolvedDimensionFilter[] = [];
  for (const filter of request.dimensions ?? []) {
    const dimensionId = await resolveDimension(db, filter.dimensionId);
    dimensions.push({
      dimensionId,
      valueIds: await resolveDimensionValues(db, dimensionId, filter.valueIds ?? []),
      includeUnassigned: filter.includeUnassigned ?? false,
    });
  }

  return {
    from: request.from ?? null,
    to: request.to ?? null,
    types: request.types ?? null,
    // Not resolved against `accounts`, unlike every id above it. The others are
    // client input, where an id this org does not own has to become a 404 rather
    // than a report of zeros; these are internal, so `uuidToBuffer` throwing on a
    // malformed one is the right answer — the same argument
    // `selectDimensionValueLabels` makes about ids this process produced itself.
    // An id for an account that does not exist simply reports on no account,
    // which is what asking for it means.
    accountIds:
      options.accountIds === undefined ? null : options.accountIds.map((id) => uuidToBuffer(id)),
    contactId: request.contactId === undefined ? null : await resolveContact(db, request.contactId),
    dimensions,
    groupBy: request.groupBy === undefined ? null : await resolveDimension(db, request.groupBy),
  };
}

async function labelsFor(
  db: TenantDatabase,
  rows: readonly AggregatedBalanceRow[],
): Promise<ReadonlyMap<string, DimensionValueLabel>> {
  const valueIds = new Set<string>();
  for (const row of rows) {
    if (row.groupValueId !== null) valueIds.add(row.groupValueId);
  }

  return selectDimensionValueLabels(db, [...valueIds]);
}

/** The unassigned bucket's key in the working maps. A UUID is never empty. */
const UNASSIGNED = '';

interface Assembly {
  readonly range: ReportRange;
  readonly groupBy: string | null;
  readonly labels: ReadonlyMap<string, DimensionValueLabel>;
}

function assemble(rows: readonly AggregatedBalanceRow[], into: Assembly): AccountBalances {
  // The chart, in the order the query returned it, which is account code order.
  // Taken from the rows rather than from a second read: the aggregation is a LEFT
  // JOIN out of `accounts`, so every account it was asked about produces at least
  // one row, in exactly one bucket at minimum.
  const chart = new Map<string, AggregatedBalanceRow>();
  const buckets = new Map<string, Map<string, AccountBalance>>([[UNASSIGNED, new Map()]]);

  for (const row of rows) {
    if (!chart.has(row.accountId)) chart.set(row.accountId, row);

    const key = row.groupValueId ?? UNASSIGNED;
    const bucket = buckets.get(key) ?? new Map<string, AccountBalance>();
    buckets.set(key, bucket);

    // A `set` and not an accumulate: `(account, bucket)` is the aggregation's
    // grouping key, so the database has already summed everything behind it.
    bucket.set(row.accountId, row.balance);
  }

  const groups = [...buckets]
    .filter(([key, bucket]) => key === UNASSIGNED || !bucketIsEmpty(bucket))
    .map(([key, bucket]) => toGroup(groupKey(key, into.labels), bucket, chart))
    .sort(compareGroups);

  return {
    range: into.range,
    groupBy: into.groupBy,
    groups,
    totals: sumAccountBalances(groups.map((group) => group.totals)),
  };
}

function bucketIsEmpty(bucket: ReadonlyMap<string, AccountBalance>): boolean {
  for (const balance of bucket.values()) {
    if (!isZeroBalance(balance)) return false;
  }
  return true;
}

function toGroup(
  key: ReportGroupKey | null,
  bucket: ReadonlyMap<string, AccountBalance>,
  chart: ReadonlyMap<string, AggregatedBalanceRow>,
): ReportGroup {
  const rows: AccountBalanceRow[] = [];
  let totals = ZERO_ACCOUNT_BALANCE;

  for (const [accountId, account] of chart) {
    const balance = bucket.get(accountId) ?? ZERO_ACCOUNT_BALANCE;
    totals = addAccountBalance(totals, balance);
    rows.push({
      accountId,
      code: account.code,
      name: account.name,
      type: account.type,
      normalBalance: account.normalBalance,
      parentAccountId: account.parentAccountId,
      isActive: account.isActive,
      balance,
    });
  }

  return { key, rows, tree: buildAccountTree(rows), totals };
}

/**
 * A bucket's key, or `null` for the unassigned one.
 *
 * A missing label is an `InternalError` rather than a fallback. `fk_jld_value` is
 * `ON DELETE RESTRICT`, so a value id that appears in `journal_line_dimensions`
 * has a `dimension_values` row by construction — and the row was read a moment
 * after the tag was. Degrading to an unnamed bucket would instead produce a second
 * group keyed `null`, and "slices plus unassigned" would then be counting one of
 * the slices as the unassigned bucket.
 */
function groupKey(
  key: string,
  labels: ReadonlyMap<string, DimensionValueLabel>,
): ReportGroupKey | null {
  if (key === UNASSIGNED) return null;

  const label = labels.get(key);
  if (label === undefined) {
    throw new InternalError(
      'A journal line carries a dimension value with no row in dimension_values, which ' +
        'fk_jld_value’s RESTRICT is supposed to make unrepresentable.',
    );
  }

  return { dimensionValueId: key, code: label.code, name: label.name };
}

/**
 * Value code order, unassigned last.
 *
 * Last rather than first because a report is read down its columns and the
 * untagged remainder is the one a reader checks after the ones they recognise —
 * and because a bucket that is often empty at the top of every report trains
 * people to ignore the position it occupies.
 */
function compareGroups(left: ReportGroup, right: ReportGroup): number {
  if (left.key === null) return right.key === null ? 0 : 1;
  if (right.key === null) return -1;
  if (left.key.code === right.key.code) return 0;
  return left.key.code < right.key.code ? -1 : 1;
}
