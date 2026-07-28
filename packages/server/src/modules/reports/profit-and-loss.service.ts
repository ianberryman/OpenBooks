import type {
  NormalBalance,
  ProfitAndLossAccountType,
  ProfitAndLossQueryParams,
  ReportBasis,
} from '@openbooks/shared-types';
import { PROFIT_AND_LOSS_ACCOUNT_TYPES, profitAndLossQuerySchema } from '@openbooks/shared-types';

import { getContext } from '../../context';
import type { RequestContext } from '../../context';
import { InternalError, parseInput, ValidationError } from '../../errors';
import { requirePermission } from '../permissions';

import type { AccountBalance, BalanceAmounts } from './amounts';
import { orgScope } from './balances.repository';
import type { AccountBalances, ReportGroup, ReportGroupKey, ReportRange } from './balances.service';
import { getAccountBalances } from './balances.service';
import type { AccountBalanceNode, AccountBalanceRow } from './tree';

/**
 * The profit and loss statement (OB-042; acceptance B2, B6, B7).
 *
 * A projection over `getAccountBalances` and nothing else — no query of its own,
 * and no second path to `journal_lines`. The core's `index.ts` states why: a
 * second aggregation is a second answer to the same question, and the trial
 * balance can only be the oracle for one of them.
 *
 * ## Which third of the decomposition this reads: `movement`
 *
 * A P&L is a *period* statement. It answers "what happened between these two
 * dates", which is precisely what `movement` holds — postings inside `[from, to]`,
 * both bounds inclusive.
 *
 * The other two arms would each be a different statement wearing this one's name.
 * `opening` is everything strictly before `from`, so a P&L built on it would
 * report every period except the one requested. `closing` is `opening + movement`,
 * i.e. inception to `to`: for revenue and expense that is the org's lifetime
 * result, which is a real figure — it is what OB-043 derives current-year earnings
 * from (D-20) — but it is not a period statement, and printing it under a
 * quarter's heading would show a young org's first quarter and its lifetime as the
 * same number. Only when `from` is omitted are they equal, and that is the
 * inception-to-date reading, stated by the range rather than by the arm.
 *
 * ## The sign convention
 *
 * The full argument is on `profitAndLossRowSchema` in shared-types, because it is
 * the wire's contract rather than this file's implementation detail. In one line:
 * amounts are signed to their section — revenue positive when earned, expense
 * positive when spent — and the flip keys off the account's `type`, never off its
 * `normalBalance`, so a contra-revenue account subtracts from revenue instead of
 * adding to it.
 *
 * ## No comparative period in M2
 *
 * A real P&L is read against something, so this is a deliberate omission rather
 * than an oversight, and the reason is not the cost. A comparative is a second
 * call to the core over a second range — no schema change, no new query, and a
 * caller can already have one by running this report twice.
 *
 * What is missing is the *definition*. "Prior period" and "year to date" are both
 * claims about the org's fiscal calendar: the period immediately before an
 * arbitrary range is not "the same number of days earlier" (February and March
 * differ, and a range that straddles two months has no prior period at all), and
 * "year to date" needs the fiscal year's start, which lives in `fiscal_periods`.
 * Deriving either here would put a calendar rule in a report, and a comparative
 * silently computed against the wrong window is worse than none — it is a
 * plausible number in the column a reader trusts least. It lands when the report
 * can ask the periods module to name the range, which is a transport-shaped
 * question (OB-045) and not this ticket's.
 *
 * ## Surface
 *
 * | Operation                        | Permission     |
 * | -------------------------------- | -------------- |
 * | `getProfitAndLoss(query, ctx)`   | `reports.read` |
 */

export interface ProfitAndLossRow {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly type: ProfitAndLossAccountType;
  readonly normalBalance: NormalBalance;
  readonly parentAccountId: string | null;
  /** Reported, not hidden — an inactive account holding a balance is the thing to see. */
  readonly isActive: boolean;
  /** Minor units as a cents-only string (D-13), signed to this row's section. */
  readonly amount: string;
  /** `amount` plus every descendant's `amount` (B7). */
  readonly subtotal: string;
}

export interface ProfitAndLossSection {
  /** Every account of the section's type, in code order, including zero rows. */
  readonly rows: readonly ProfitAndLossRow[];
  /** The sum of every row's `amount`. Not of the `subtotal`s, which nest. */
  readonly total: string;
}

export interface ProfitAndLossTotals {
  readonly revenue: string;
  readonly expenses: string;
  readonly netIncome: string;
}

export interface ProfitAndLossGroup {
  /** `null` is the unassigned bucket, or the sole group of an unsliced report. */
  readonly key: ReportGroupKey | null;
  readonly revenue: ProfitAndLossSection;
  readonly expenses: ProfitAndLossSection;
  /** `revenue.total - expenses.total`. Positive is a profit. */
  readonly netIncome: string;
}

export interface ProfitAndLoss {
  readonly range: ReportRange;
  /** Which basis produced these numbers (K1, D-87) — the request's, or the org default. */
  readonly basis: ReportBasis;
  readonly groupBy: string | null;
  readonly groups: readonly ProfitAndLossGroup[];
  /** Every group summed. Equal to the same statement run without `groupBy` (B6). */
  readonly totals: ProfitAndLossTotals;
}

export type ProfitAndLossQuery = ProfitAndLossQueryParams;

/**
 * Revenue and expense over a date range, with hierarchy subtotals and net income.
 *
 * `reports.read`, checked here as well as in the core. The core memoizes a role's
 * permissions per context (`permissions.service.ts`), so the second check is a
 * `Set` lookup rather than a second query, and it means this service states its
 * own authority instead of inheriting one from a function it happens to call.
 */
export async function getProfitAndLoss(
  query: ProfitAndLossQuery = {},
  ctx: RequestContext = getContext('getProfitAndLoss()'),
): Promise<ProfitAndLoss> {
  await requirePermission(ctx, 'reports.read');
  const request = parseInput(profitAndLossQuerySchema, query);

  const { basis: requestBasis, ...balanceQuery } = request;
  const basis = await resolveBasis(ctx, requestBasis);
  if (basis === 'cash') assertCashBasisSupported(balanceQuery);

  const balances = await getAccountBalances(
    { ...balanceQuery, types: [...PROFIT_AND_LOSS_ACCOUNT_TYPES] },
    ctx,
    { basis },
  );

  return project(balances, basis);
}

/**
 * The basis this run uses: the request's override, or the org's `default_reporting_basis`
 * (D-87). The settings row is lazily created (`0005`), so an org that never set a
 * default reads `accrual` — the ledger's own basis, and what every M2 report was.
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
 * Cash basis re-recognises through the subledger and does not yet carry a contact or
 * dimension through that path (`cash-basis/service.ts`). Rather than silently drop the
 * filter — a report of the wrong scope wearing the right heading — a sliced cash-basis
 * request is refused until the transform threads them. The whole-org cash P&L is the
 * majority case (D-88); slicing lands with a later increment.
 */
function assertCashBasisSupported(query: Omit<ProfitAndLossQuery, 'basis'>): void {
  if (
    query.contactId !== undefined ||
    (query.dimensions !== undefined && query.dimensions.length > 0) ||
    query.groupBy !== undefined
  ) {
    throw new ValidationError(
      'Cash-basis reporting does not yet support contact or dimension slicing; run it without ' +
        'those filters, or use accrual basis.',
    );
  }
}

/** One group's two sections, still in `bigint` so the report's totals can sum them. */
interface Sections {
  readonly key: ReportGroupKey | null;
  readonly revenue: Section;
  readonly expenses: Section;
}

interface Section {
  readonly rows: readonly ProfitAndLossRow[];
  readonly total: bigint;
}

function project(balances: AccountBalances, basis: ReportBasis): ProfitAndLoss {
  const sections = balances.groups.map(sectionsOf);

  let revenue = 0n;
  let expenses = 0n;
  for (const group of sections) {
    revenue += group.revenue.total;
    expenses += group.expenses.total;
  }

  return {
    range: balances.range,
    basis,
    groupBy: balances.groupBy,
    groups: sections.map(toGroup),
    totals: {
      revenue: revenue.toString(),
      expenses: expenses.toString(),
      netIncome: (revenue - expenses).toString(),
    },
  };
}

function sectionsOf(group: ReportGroup): Sections {
  const subtotals = subtotalsByAccount(group.tree);
  const revenue = sectionOf('revenue', group.rows, subtotals);
  const expenses = sectionOf('expense', group.rows, subtotals);

  // Every row lands in exactly one section, or the statement silently omits an
  // account that the core counted. The `types` filter above makes another type
  // unrepresentable, so this is the same class of fault `tree.ts` raises for an
  // unreachable account: a state no write path can produce, reported as ours.
  if (revenue.rows.length + expenses.rows.length !== group.rows.length) {
    throw new InternalError(
      'The report core returned an account that is neither revenue nor expense for a profit ' +
        'and loss, despite the statement asking for those two types only.',
    );
  }

  return { key: group.key, revenue, expenses };
}

function sectionOf(
  type: ProfitAndLossAccountType,
  rows: readonly AccountBalanceRow[],
  subtotals: ReadonlyMap<string, AccountBalance>,
): Section {
  const projected: ProfitAndLossRow[] = [];
  let total = 0n;

  for (const row of rows) {
    if (row.type !== type) continue;

    const subtree = subtotals.get(row.accountId);
    if (subtree === undefined) {
      throw new InternalError(
        'An account in the report core’s rows has no node in its forest, so its subtree ' +
          'subtotal cannot be computed.',
      );
    }

    const amount = statementAmount(type, row.balance.movement);
    total += amount;

    projected.push({
      accountId: row.accountId,
      code: row.code,
      name: row.name,
      type,
      normalBalance: row.normalBalance,
      parentAccountId: row.parentAccountId,
      isActive: row.isActive,
      amount: amount.toString(),
      subtotal: statementAmount(type, subtree.movement).toString(),
    });
  }

  return { rows: projected, total };
}

/**
 * The period's figure for one account, signed to its section.
 *
 * Negating the core's `debits - credits` for revenue rather than recomputing
 * `credits - debits`, so there is one subtraction in the system and this is a sign
 * applied to it. `type` and not `normalBalance` — see `profitAndLossRowSchema`.
 */
function statementAmount(type: ProfitAndLossAccountType, amounts: BalanceAmounts): bigint {
  return type === 'revenue' ? -amounts.balance : amounts.balance;
}

/**
 * Subtree subtotals by account, read out of the forest the core already built.
 *
 * Signing happens after the rollup rather than before it, which is only sound
 * because a subtree never spans two account types — a parent's type must equal its
 * children's (`accounts/hierarchy.ts`) — so one sign applies to the whole subtree.
 * Without that rule the sum would have to be signed row by row before rolling up.
 */
function subtotalsByAccount(
  tree: readonly AccountBalanceNode[],
): ReadonlyMap<string, AccountBalance> {
  const subtotals = new Map<string, AccountBalance>();

  const visit = (nodes: readonly AccountBalanceNode[]): void => {
    for (const node of nodes) {
      subtotals.set(node.row.accountId, node.subtotal);
      visit(node.children);
    }
  };
  visit(tree);

  return subtotals;
}

function toGroup(sections: Sections): ProfitAndLossGroup {
  return {
    key: sections.key,
    revenue: wireSection(sections.revenue),
    expenses: wireSection(sections.expenses),
    netIncome: (sections.revenue.total - sections.expenses.total).toString(),
  };
}

function wireSection(section: Section): ProfitAndLossSection {
  return { rows: section.rows, total: section.total.toString() };
}
