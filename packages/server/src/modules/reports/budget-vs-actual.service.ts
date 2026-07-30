import type {
  BudgetVsActual,
  BudgetVsActualGroup,
  BudgetVsActualQueryParams,
  BudgetVsActualRow,
  BudgetVsActualSection,
  BudgetVsActualTotals,
  ProfitAndLossAccountType,
  ReportBasis,
} from '@openbooks/shared-types';
import { budgetVsActualQuerySchema, PROFIT_AND_LOSS_ACCOUNT_TYPES } from '@openbooks/shared-types';

import { getContext } from '../../context';
import type { RequestContext } from '../../context';
import { bufferToUuid, uuidToBuffer } from '../../db';
import { assertFound, InternalError, parseInput, ValidationError } from '../../errors';
import { requirePermission } from '../permissions';

import type { BalanceAmounts } from './amounts';
import { ZERO_ACCOUNT_BALANCE } from './amounts';
import { orgScope } from './balances.repository';
import type { AccountBalances, ReportGroup, ReportGroupKey } from './balances.service';
import { getAccountBalances } from './balances.service';
import type { AccountBalanceRow } from './tree';

/**
 * The budget-vs-actual report (OB-182; ROADMAP D-N1…D-N6).
 *
 * A projection over `getAccountBalances`, exactly like the P&L
 * (`profit-and-loss.service.ts`) — no query of its own against `journal_lines`,
 * so the trial balance stays the sole oracle for the actuals column. The budget
 * column is this file's only original read, against `budgets`, and it is bucketed
 * to line up with whatever grouping the actuals side already produced rather than
 * aggregated a second, independent way.
 *
 * ## Why the period is read here and not through `periods.read`
 *
 * `getPeriod` (`periods.service.ts`) requires `periods.read`, a permission this
 * report has no business demanding — a role that can run reports but not browse
 * the period list is one of the six seeded roles, and gating the report on a
 * second permission would make it fail for that role for a reason unrelated to
 * reporting. The read below goes straight at `fiscal_periods` through `orgScope`,
 * which already injects `org_id = ctx.orgId`; a period belonging to another org
 * is filtered out before the row reaches this function, so the empty-result branch
 * is the same 404 A7 requires everywhere else, via `assertFound`.
 *
 * ## Budget rows are section-signed already
 *
 * A stored budget (`budgetSchema` in shared-types) carries one signed
 * `amount_minor`, entered against a section the same way `ProfitAndLossRow.amount`
 * is — positive revenue budgeted as earned, positive expense budgeted as spent.
 * `statementAmount` therefore applies to the actual side only; the budget side is
 * summed as stored.
 */

export async function getBudgetVsActual(
  query: BudgetVsActualQueryParams,
  ctx: RequestContext = getContext('getBudgetVsActual()'),
): Promise<BudgetVsActual> {
  await requirePermission(ctx, 'reports.read');
  const request = parseInput(budgetVsActualQuerySchema, query);

  const basis = await resolveBasis(ctx, request.basis);
  if (basis === 'cash') assertCashBasisSupported(request);

  const db = orgScope(ctx);
  const periodIdBytes = uuidToBuffer(request.periodId);
  const period = assertFound(
    await db
      .selectFrom('fiscal_periods')
      .select(['id', 'name', 'start_date', 'end_date'])
      .where('id', '=', periodIdBytes)
      .executeTakeFirst(),
    'fiscal_period',
  );

  const balances = await getAccountBalances(
    {
      from: period.start_date,
      to: period.end_date,
      types: [...PROFIT_AND_LOSS_ACCOUNT_TYPES],
      ...(request.dimensions !== undefined ? { dimensions: request.dimensions } : {}),
      ...(request.groupBy !== undefined ? { groupBy: request.groupBy } : {}),
    },
    ctx,
    { basis },
  );

  const budgetRows = await db
    .selectFrom('budgets')
    .select(['account_id', 'dimension_id', 'dimension_value_id', 'amount_minor'])
    .where('period_id', '=', periodIdBytes)
    .execute();

  const budgetBuckets = bucketBudgetRows(
    budgetRows.filter((row) => passesEveryFilter(row, request.dimensions)),
    request.groupBy === undefined ? null : uuidToBuffer(request.groupBy),
  );

  // A per-slice budget can name a dimension value that has **no** ledger activity in
  // the window — a department budgeted before its first transaction (D-N1). The
  // actuals core only emits a bucket for a value with non-zero movement (plus the
  // always-present unassigned one), so such a budget would have no group to land in
  // and would silently vanish from a grouped report while the ungrouped total still
  // counts it, breaking B6. So the report's groups are the union of the actuals
  // buckets and every value a budget names on the grouped axis; the labels for the
  // budget-only values are read here so `project` can synthesise a zero-actuals group
  // for each. Read through `orgScope`, so a value is this org's by construction.
  const presentKeys = new Set(balances.groups.map(groupKeyOf));
  const budgetOnlyKeys = [...budgetBuckets.keys()].filter(
    (key) => key !== UNASSIGNED && !presentKeys.has(key),
  );
  const budgetOnlyLabels = await selectValueLabels(db, budgetOnlyKeys);

  return project(balances, budgetBuckets, budgetOnlyLabels, basis, {
    id: request.periodId,
    name: period.name,
    startDate: period.start_date,
    endDate: period.end_date,
  });
}

/** The bucket key a report group carries: its dimension-value id, or unassigned. */
function groupKeyOf(group: ReportGroup): string {
  return group.key === null ? UNASSIGNED : group.key.dimensionValueId;
}

interface ValueLabel {
  readonly code: string;
  readonly name: string;
}

/**
 * `code`/`name` for the dimension values a budget names but the actuals never
 * produced a group for. A missing label would mean a `budgets` row references a
 * `dimension_values` row that does not exist, which `fk_budgets_value`'s RESTRICT
 * makes unrepresentable — so an absent one is an `InternalError`, the same stance
 * `balances.service.ts` takes for the identical join.
 */
async function selectValueLabels(
  db: ReturnType<typeof orgScope>,
  valueIds: readonly string[],
): Promise<ReadonlyMap<string, ValueLabel>> {
  if (valueIds.length === 0) return new Map();

  const rows = await db
    .selectFrom('dimension_values')
    .select(['id', 'code', 'name'])
    .where(
      'id',
      'in',
      valueIds.map((id) => uuidToBuffer(id)),
    )
    .execute();

  const labels = new Map(
    rows.map((row) => [bufferToUuid(row.id), { code: row.code, name: row.name }]),
  );
  if (labels.size !== valueIds.length) {
    throw new InternalError(
      'A budget names a dimension value with no row in dimension_values, which fk_budgets_value’s ' +
        'RESTRICT is supposed to make unrepresentable.',
    );
  }
  return labels;
}

/**
 * The basis this run uses: the request's override, or the org's default —
 * word-for-word `profit-and-loss.service.ts`'s helper, copied rather than
 * imported so this file has no compile-time coupling to the P&L's internals.
 */
async function resolveBasis(
  ctx: RequestContext,
  requestBasis: ReportBasis | undefined,
): Promise<ReportBasis> {
  if (requestBasis !== undefined) return requestBasis;
  const row = await orgScope(ctx)
    .selectFrom('org_accounting_settings')
    .select('default_reporting_basis')
    .executeTakeFirst();
  return row?.default_reporting_basis ?? 'accrual';
}

/**
 * The P&L's cash-basis guard, narrowed to the two filters this query actually
 * carries — there is no `contactId` here, so checking for one would be dead code
 * rather than a faithful copy.
 */
function assertCashBasisSupported(
  query: Pick<BudgetVsActualQueryParams, 'dimensions' | 'groupBy'>,
): void {
  if (
    (query.dimensions !== undefined && query.dimensions.length > 0) ||
    query.groupBy !== undefined
  ) {
    throw new ValidationError(
      'Cash-basis reporting does not yet support dimension slicing; run it without those ' +
        'filters, or use accrual basis.',
    );
  }
}

interface BudgetRow {
  readonly account_id: Buffer;
  readonly dimension_id: Buffer | null;
  readonly dimension_value_id: Buffer | null;
  readonly amount_minor: bigint;
}

/**
 * A budget row carries at most one axis, so a filter naming a different axis
 * cannot match it on values — the row is either on the filtered axis (and must
 * carry one of `valueIds`) or off it (and passes only if the filter accepts the
 * unassigned case). This mirrors how a journal line with no tag on a filtered
 * axis is treated by `dimensionFilterPredicate` in `balances.repository.ts`.
 */
function passesEveryFilter(
  row: BudgetRow,
  filters: BudgetVsActualQueryParams['dimensions'],
): boolean {
  if (filters === undefined || filters.length === 0) return true;

  return filters.every((filter) => {
    const dimensionIdBytes = uuidToBuffer(filter.dimensionId);
    const onAxis = row.dimension_id !== null && row.dimension_id.equals(dimensionIdBytes);

    if (onAxis) {
      const valueHexes = new Set(
        (filter.valueIds ?? []).map((id) => uuidToBuffer(id).toString('hex')),
      );
      return (
        row.dimension_value_id !== null && valueHexes.has(row.dimension_value_id.toString('hex'))
      );
    }

    return filter.includeUnassigned ?? false;
  });
}

/** The unassigned bucket's key — an empty string is never a real UUID. */
const UNASSIGNED = '';

/**
 * Sums the passing budget rows into `bucket -> account -> amount`, bucketed the
 * same way `getAccountBalances`' own `assemble()` buckets journal lines: on the
 * grouped axis if the row is tagged on it, unassigned otherwise — which puts an
 * account-total row (`dimension_id` null) and a row tagged on some other axis in
 * the same bucket as an untagged journal line would land in.
 *
 * Bucket keys are UUID strings (`bufferToUuid`), not hex, because they are looked
 * up against `ReportGroupKey.dimensionValueId` in `project()` below, which is
 * already in that form.
 */
function bucketBudgetRows(
  rows: readonly BudgetRow[],
  axis: Buffer | null,
): ReadonlyMap<string, ReadonlyMap<string, bigint>> {
  const buckets = new Map<string, Map<string, bigint>>();

  for (const row of rows) {
    const onAxis = axis !== null && row.dimension_id !== null && row.dimension_id.equals(axis);
    const key =
      onAxis && row.dimension_value_id !== null ? bufferToUuid(row.dimension_value_id) : UNASSIGNED;

    const bucket = buckets.get(key) ?? new Map<string, bigint>();
    buckets.set(key, bucket);

    const accountId = bufferToUuid(row.account_id);
    bucket.set(accountId, (bucket.get(accountId) ?? 0n) + row.amount_minor);
  }

  return buckets;
}

/** One group's two sections plus its key, still in `bigint` so totals can sum across groups. */
interface Sections {
  readonly key: ReportGroupKey | null;
  readonly revenue: Section;
  readonly expenses: Section;
}

interface Section {
  // Not `readonly X[]`: this is assembled into `BudgetVsActualSection.rows`, whose
  // z.infer type is a plain (mutable) array — the wire schema carries no
  // `.readonly()`, so a readonly array here would not satisfy it.
  readonly rows: BudgetVsActualRow[];
  readonly budget: bigint;
  readonly actual: bigint;
  readonly variance: bigint;
}

interface Triplet {
  readonly budget: bigint;
  readonly actual: bigint;
  readonly variance: bigint;
}

interface PeriodInfo {
  readonly id: string;
  readonly name: string;
  readonly startDate: string;
  readonly endDate: string;
}

function project(
  balances: AccountBalances,
  budgetBuckets: ReadonlyMap<string, ReadonlyMap<string, bigint>>,
  budgetOnlyLabels: ReadonlyMap<string, ValueLabel>,
  basis: ReportBasis,
  period: PeriodInfo,
): BudgetVsActual {
  // Every actuals group shares the same dense chart (a row per P&L account, at zero
  // where the ledger had nothing), so its roster is the roster a synthesised
  // budget-only group needs — with every actual zeroed.
  const roster = balances.groups[0]?.rows ?? [];
  const budgetOnlyGroups = [...budgetOnlyLabels].map(([valueId, label]) =>
    syntheticGroup({ dimensionValueId: valueId, code: label.code, name: label.name }, roster),
  );

  const sections = [...balances.groups, ...budgetOnlyGroups]
    .map((group) => sectionsOf(group, budgetBuckets))
    .sort(compareSections);

  let revenue: Triplet = { budget: 0n, actual: 0n, variance: 0n };
  let expenses: Triplet = { budget: 0n, actual: 0n, variance: 0n };
  for (const group of sections) {
    revenue = addTriplet(revenue, group.revenue);
    expenses = addTriplet(expenses, group.expenses);
  }

  return {
    period,
    basis,
    groupBy: balances.groupBy,
    groups: sections.map(toGroup),
    totals: toTotals(revenue, expenses),
  };
}

/**
 * A group for a dimension value that a budget names but the ledger never touched:
 * the same dense account roster every real group carries, with every balance zeroed
 * so the actual side is zero and the variance is the budget alone. `tree` is empty
 * because `sectionsOf` reads `rows` only — the forest B7 needs is a P&L concern this
 * report does not compute.
 */
function syntheticGroup(key: ReportGroupKey, roster: readonly AccountBalanceRow[]): ReportGroup {
  return {
    key,
    rows: roster.map((row) => ({ ...row, balance: ZERO_ACCOUNT_BALANCE })),
    tree: [],
    totals: ZERO_ACCOUNT_BALANCE,
  };
}

/**
 * Value-code order, unassigned last — `balances.service.ts`'s `compareGroups`
 * applied to the merged set, so a synthesised budget-only group sorts into the same
 * place the actuals core would have put it had the value had activity.
 */
function compareSections(left: Sections, right: Sections): number {
  if (left.key === null) return right.key === null ? 0 : 1;
  if (right.key === null) return -1;
  if (left.key.code === right.key.code) return 0;
  return left.key.code < right.key.code ? -1 : 1;
}

function sectionsOf(
  group: ReportGroup,
  budgetBuckets: ReadonlyMap<string, ReadonlyMap<string, bigint>>,
): Sections {
  const bucketKey = group.key === null ? UNASSIGNED : group.key.dimensionValueId;
  const budgetBucket = budgetBuckets.get(bucketKey) ?? new Map<string, bigint>();

  const revenue = sectionOf('revenue', group.rows, budgetBucket);
  const expenses = sectionOf('expense', group.rows, budgetBucket);

  // Every row lands in exactly one section, or the statement silently omits an
  // account the core counted. The `types` filter on the actuals query makes a
  // third type unrepresentable, so this is the same class of fault the P&L
  // raises for the identical shape of state no write path can produce.
  if (revenue.rows.length + expenses.rows.length !== group.rows.length) {
    throw new InternalError(
      'The report core returned an account that is neither revenue nor expense for a budget ' +
        'vs actual report, despite the actuals query asking for those two types only.',
    );
  }

  return { key: group.key, revenue, expenses };
}

function sectionOf(
  type: ProfitAndLossAccountType,
  rows: readonly AccountBalanceRow[],
  budgetBucket: ReadonlyMap<string, bigint>,
): Section {
  const projected: BudgetVsActualRow[] = [];
  let budgetTotal = 0n;
  let actualTotal = 0n;
  let varianceTotal = 0n;

  for (const row of rows) {
    if (row.type !== type) continue;

    const actual = statementAmount(type, row.balance.movement);
    const budget = budgetBucket.get(row.accountId) ?? 0n;
    const variance = budget - actual;

    budgetTotal += budget;
    actualTotal += actual;
    varianceTotal += variance;

    projected.push({
      accountId: row.accountId,
      code: row.code,
      name: row.name,
      type,
      budget: budget.toString(),
      actual: actual.toString(),
      variance: variance.toString(),
      variancePercent: budget === 0n ? null : (Number(variance) / Number(budget)) * 100,
    });
  }

  return { rows: projected, budget: budgetTotal, actual: actualTotal, variance: varianceTotal };
}

/**
 * The period's figure for one account, signed to its section — identical to the
 * P&L's `statementAmount`. Applies to actuals only; a stored budget is already
 * signed to its section (see the file header), so the budget side skips this.
 */
function statementAmount(type: ProfitAndLossAccountType, amounts: BalanceAmounts): bigint {
  return type === 'revenue' ? -amounts.balance : amounts.balance;
}

function addTriplet(left: Triplet, right: Section): Triplet {
  return {
    budget: left.budget + right.budget,
    actual: left.actual + right.actual,
    variance: left.variance + right.variance,
  };
}

function toGroup(sections: Sections): BudgetVsActualGroup {
  return {
    key: sections.key,
    revenue: wireSection(sections.revenue),
    expenses: wireSection(sections.expenses),
    netIncome: wireTriplet({
      budget: sections.revenue.budget - sections.expenses.budget,
      actual: sections.revenue.actual - sections.expenses.actual,
      variance: sections.revenue.variance - sections.expenses.variance,
    }),
  };
}

function wireSection(section: Section): BudgetVsActualSection {
  return {
    rows: section.rows,
    budget: section.budget.toString(),
    actual: section.actual.toString(),
    variance: section.variance.toString(),
  };
}

function wireTriplet(triplet: Triplet): { budget: string; actual: string; variance: string } {
  return {
    budget: triplet.budget.toString(),
    actual: triplet.actual.toString(),
    variance: triplet.variance.toString(),
  };
}

function toTotals(revenue: Triplet, expenses: Triplet): BudgetVsActualTotals {
  return {
    revenue: wireTriplet(revenue),
    expenses: wireTriplet(expenses),
    netIncome: wireTriplet({
      budget: revenue.budget - expenses.budget,
      actual: revenue.actual - expenses.actual,
      variance: revenue.variance - expenses.variance,
    }),
  };
}
