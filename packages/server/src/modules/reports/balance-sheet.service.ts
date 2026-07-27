import type { CalendarDate } from '@openbooks/plugin-api';
import type {
  BalanceSheetAccountType,
  BalanceSheetQueryParams,
  NormalBalance,
} from '@openbooks/shared-types';
import { balanceSheetQuerySchema } from '@openbooks/shared-types';

import { getContext } from '../../context';
import type { RequestContext } from '../../context';
import { orgScope } from '../../db';
import { InternalError, parseInput } from '../../errors';
import { fiscalYearSpan, MONTHS_PER_YEAR, selectFiscalYearStartMonth } from '../periods';
import { requirePermission } from '../permissions';

import type { AccountBalance, BalanceAmounts } from './amounts';
import type { AccountBalances, ReportGroup, ReportGroupKey } from './balances.service';
import { getAccountBalances } from './balances.service';
import type { AccountBalanceNode, AccountBalanceRow } from './tree';

/**
 * The balance sheet (OB-043; acceptance B2, B3, B6, B7; ROADMAP D-20).
 *
 * A projection over `getAccountBalances`, like the P&L next door — one aggregation
 * stands behind all three M2 reports, and the core's `index.ts` says why. What is
 * particular to this report is that **the numbers it prints do not all come from
 * accounts**: two of the equity lines are derived, and the derivation is the whole
 * of D-20.
 *
 * ## Why the sheet would not balance on its own
 *
 * There is no year-end closing journal in M2. Revenue and expense balances
 * therefore have nowhere to land, and assets minus liabilities minus equity
 * *accounts* comes out short by exactly the income nobody has closed. D-20 chose to
 * derive that figure rather than build a close: the sheet then balances on an org's
 * first day, with no ritual to perform.
 *
 * ## Why the derivation is split at the fiscal-year boundary
 *
 * D-20 describes the difference as "the year's net income", which is the whole of
 * it only for an org in its first fiscal year. In its second, last year's profit is
 * still sitting in the revenue and expense accounts, and a sheet carrying only the
 * current year's earnings is out of balance by precisely that amount — so B3 would
 * hold for new orgs and fail for everyone else.
 *
 * So the unclosed income is split at the start of the fiscal year containing
 * `asOf`, and that costs nothing extra: OB-041 was built so one call answers both
 * halves. With `from` at the fiscal-year start, the revenue and expense rows carry
 * their prior years in `opening` and this year in `movement`, while every
 * balance-sheet account carries its position in `closing`. One query, three arms,
 * no second range.
 *
 * ## The rule that becomes wrong later — read this before building the close
 *
 * D-20 states it and it is recorded here, at the code it will invalidate: **once a
 * closing journal exists (M7, or whenever a hard close is built), this derivation
 * must exclude every fiscal year that has already been closed.** A closing journal
 * moves a year's revenue and expense into an equity account — ordinarily retained
 * earnings, which is an *ordinary account* and is already counted in the equity
 * section below. If `priorYearEarnings` keeps deriving that same year out of the
 * revenue and expense balances, the closed year's income is counted twice: once in
 * the account the close wrote to, and once in the derived line.
 *
 * `currentYearEarnings` is not at risk, because it is already scoped to a single
 * fiscal year. `priorYearEarnings` is the line that has to learn about closes: its
 * window becomes "since the last closed fiscal year end" instead of "everything
 * before this fiscal year", which is a change to the `from` bound handed to the
 * core and to nothing else in this file. Current-year earnings must never become an
 * account (D-20): deriving something that also exists as an account is how it gets
 * double-counted, and this comment is the record of which line is which.
 *
 * ## Which third of the decomposition each figure reads
 *
 * | Figure                    | Arm         | Window                        |
 * | ------------------------- | ----------- | ----------------------------- |
 * | asset/liability/equity    | `closing`   | inception to `asOf`           |
 * | `priorYearEarnings`       | `opening`   | inception to the year's start |
 * | `currentYearEarnings`     | `movement`  | the year's start to `asOf`    |
 *
 * ## The sign convention
 *
 * Argued in full on `balanceSheetRowSchema` in shared-types, because it is the
 * wire's contract rather than this file's detail. In one line: every amount is
 * positive on the side its section belongs to, and the flip keys off the account's
 * `type` and never off its `normalBalance` — so accumulated depreciation reduces
 * assets instead of inflating them.
 *
 * ## Surface
 *
 * | Operation                     | Permission     |
 * | ----------------------------- | -------------- |
 * | `getBalanceSheet(query, ctx)` | `reports.read` |
 */

export interface BalanceSheetRow {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly type: BalanceSheetAccountType;
  readonly normalBalance: NormalBalance;
  readonly parentAccountId: string | null;
  /** Reported, not hidden — an inactive account holding a balance is the thing to see. */
  readonly isActive: boolean;
  /** Minor units as a cents-only string (D-13), signed to this row's section. */
  readonly amount: string;
  /** `amount` plus every descendant's `amount` (B7). */
  readonly subtotal: string;
}

export interface BalanceSheetSection {
  /** Every account of the section's type, in code order, including zero rows. */
  readonly rows: readonly BalanceSheetRow[];
  /** The sum of every row's `amount`. Not of the `subtotal`s, which nest. */
  readonly total: string;
}

export interface BalanceSheetTotals {
  readonly assets: string;
  readonly liabilities: string;
  /** Equity **accounts** only; the two derived lines are separate (D-20). */
  readonly equity: string;
  /** Derived, never an account: unclosed income of earlier fiscal years (D-20). */
  readonly priorYearEarnings: string;
  /** Derived, never an account: this fiscal year to `asOf` (D-20). Positive is a profit. */
  readonly currentYearEarnings: string;
  /** `liabilities + equity + priorYearEarnings + currentYearEarnings`. */
  readonly liabilitiesAndEquity: string;
  /** `assets - liabilitiesAndEquity`. `"0"` for the report as a whole (B3). */
  readonly difference: string;
}

export interface BalanceSheetGroup {
  /** `null` is the unassigned bucket, or the sole group of an unsliced report. */
  readonly key: ReportGroupKey | null;
  readonly assets: BalanceSheetSection;
  readonly liabilities: BalanceSheetSection;
  readonly equity: BalanceSheetSection;
  readonly totals: BalanceSheetTotals;
}

/** The fiscal year the earnings derivation was scoped to, resolved from `asOf`. */
export interface BalanceSheetFiscalYear {
  /** The calendar year the fiscal year *starts* in (`fiscalYearSpan`'s convention). */
  readonly year: number;
  readonly startMonth: number;
  readonly startDate: CalendarDate;
  /** Inclusive, and after `asOf` whenever the sheet is drawn mid-year. */
  readonly endDate: CalendarDate;
}

export interface BalanceSheet {
  readonly asOf: CalendarDate;
  readonly fiscalYear: BalanceSheetFiscalYear;
  /** D-22: accrual only in M2. Stated so the numbers cannot be read as cash basis. */
  readonly basis: 'accrual';
  readonly groupBy: string | null;
  readonly groups: readonly BalanceSheetGroup[];
  /** Every group summed. Equal to the same sheet run without `groupBy` (B6). */
  readonly totals: BalanceSheetTotals;
}

export type BalanceSheetQuery = BalanceSheetQueryParams;

/**
 * Assets, liabilities and equity as at a date, with the derived earnings lines.
 *
 * `reports.read`, checked here as well as in the core. A role's permissions are
 * memoized per context (`permissions.service.ts`), so the second check is a `Set`
 * lookup rather than a second query, and it means this service states its own
 * authority instead of inheriting one from a function it happens to call.
 *
 * No `types` filter reaches the core, and that is not an omission: the derived
 * lines are computed from the revenue and expense accounts such a filter would
 * remove, so this report reads the whole chart and decides what to print.
 */
export async function getBalanceSheet(
  query: BalanceSheetQuery,
  ctx: RequestContext = getContext('getBalanceSheet()'),
): Promise<BalanceSheet> {
  await requirePermission(ctx, 'reports.read');
  const request = parseInput(balanceSheetQuerySchema, query);

  const fiscalYear = await resolveFiscalYear(ctx, request.asOf);
  const balances = await getAccountBalances(
    {
      ...withoutAsOf(request),
      from: fiscalYear.startDate,
      to: request.asOf,
    },
    ctx,
  );

  return project(request.asOf, fiscalYear, balances);
}

/**
 * The core takes `from`/`to`; this report takes `asOf`. Dropping the field rather
 * than spreading over it, because `exactOptionalPropertyTypes` makes an explicit
 * `asOf: undefined` a different thing from an absent key, and
 * `accountBalancesQuerySchema` is a `strictObject` that refuses the field either
 * way.
 */
function withoutAsOf(request: BalanceSheetQueryParams): Omit<BalanceSheetQueryParams, 'asOf'> {
  const { asOf: _asOf, ...slice } = request;
  return slice;
}

/**
 * The fiscal year containing `asOf`, for this org.
 *
 * The start month is a per-org setting (D-17: "the fiscal year frequently does not
 * start in January — April, July, and October are all common"), so it is *resolved*
 * rather than assumed. A sheet drawn as at 2026-05-31 for an org whose year starts
 * in April measures current-year earnings over two months; for an org starting in
 * January, over five. Assuming January would produce a plausible number for every
 * org and a correct one for some of them, which is the failure mode that gets past
 * an example test.
 *
 * The comparison is on the month number alone, and the arithmetic is on the date
 * *string*: `calendar.ts` explains why no `Date` appears anywhere on this path —
 * `new Date('2026-04-01')` is midnight UTC, so `getMonth()` west of Greenwich
 * answers March and a sheet drawn on the first day of a fiscal year would measure
 * the previous one.
 */
async function resolveFiscalYear(
  ctx: RequestContext,
  asOf: CalendarDate,
): Promise<BalanceSheetFiscalYear> {
  const startMonth = await fiscalYearStartMonth(ctx);

  const year = Number(asOf.slice(0, 4));
  const month = Number(asOf.slice(5, 7));
  const span = fiscalYearSpan(month >= startMonth ? year : year - 1, startMonth);

  return {
    year: span.fiscalYear,
    startMonth: span.startMonth,
    startDate: span.startDate,
    endDate: span.endDate,
  };
}

async function fiscalYearStartMonth(ctx: RequestContext): Promise<number> {
  const startMonth = await selectFiscalYearStartMonth(orgScope(ctx.orgId));

  if (startMonth === undefined) {
    throw new InternalError(
      'No org row for the org id in request context. The context was opened for an org that ' +
        'does not exist, or the org was deleted mid-request.',
    );
  }

  // `chk_orgs_fiscal_year_start_month` restricts this to 1-12, so the branch is
  // unreachable through a migrated database. It is here because the generated type
  // is `number`: without it a drifted schema would silently move the earnings
  // boundary, and a boundary in the wrong month is far harder to notice than a
  // failed call — every account still ties to the trial balance, and only the split
  // between the two derived lines is wrong.
  if (!Number.isInteger(startMonth) || startMonth < 1 || startMonth > MONTHS_PER_YEAR) {
    throw new InternalError(
      `orgs.fiscal_year_start_month is ${startMonth}, which is not a month. ` +
        'chk_orgs_fiscal_year_start_month should have made this unreachable.',
    );
  }

  return startMonth;
}

/** One group's three sections and two derived lines, still in `bigint` (D-13). */
interface Bucket {
  readonly key: ReportGroupKey | null;
  readonly assets: Section;
  readonly liabilities: Section;
  readonly equity: Section;
  readonly priorYearEarnings: bigint;
  readonly currentYearEarnings: bigint;
}

interface Section {
  readonly rows: readonly BalanceSheetRow[];
  readonly total: bigint;
}

function project(
  asOf: CalendarDate,
  fiscalYear: BalanceSheetFiscalYear,
  balances: AccountBalances,
): BalanceSheet {
  const buckets = balances.groups.map(bucketOf);

  return {
    asOf,
    fiscalYear,
    basis: 'accrual',
    groupBy: balances.groupBy,
    groups: buckets.map(toGroup),
    // Summed from the buckets rather than recomputed from `balances.totals`, so the
    // report's foot is the arithmetic its own groups print. B6 is then a statement
    // about numbers a reader can add up, not about two derivations agreeing.
    totals: totalsOf(buckets),
  };
}

function bucketOf(group: ReportGroup): Bucket {
  const subtotals = subtotalsByAccount(group.tree);
  const assets = sectionOf('asset', group.rows, subtotals);
  const liabilities = sectionOf('liability', group.rows, subtotals);
  const equity = sectionOf('equity', group.rows, subtotals);

  let priorYearEarnings = 0n;
  let currentYearEarnings = 0n;
  let earningsRows = 0;

  for (const row of group.rows) {
    if (row.type !== 'revenue' && row.type !== 'expense') continue;
    earningsRows += 1;

    // The two arms of the same account, taken apart at the fiscal-year start. Not
    // `closing` for either: `closing` on a revenue account is the org's lifetime
    // result, and using it for the current year would count every earlier year
    // twice once `priorYearEarnings` is added in.
    priorYearEarnings += earnings(row.balance.opening);
    currentYearEarnings += earnings(row.balance.movement);
  }

  // Every row lands in a section or in the derivation. The core returns the whole
  // chart here — no `types` filter — so a row of a sixth type would be silently
  // dropped from a report that is supposed to balance, and B3 would fail somewhere
  // far from the cause. Same class of fault as `tree.ts`'s unreachable account.
  if (
    assets.rows.length + liabilities.rows.length + equity.rows.length + earningsRows !==
    group.rows.length
  ) {
    throw new InternalError(
      'The report core returned an account whose type is neither a balance-sheet section nor ' +
        'part of the current-year earnings derivation, so the sheet cannot be made to balance.',
    );
  }

  return { key: group.key, assets, liabilities, equity, priorYearEarnings, currentYearEarnings };
}

function sectionOf(
  type: BalanceSheetAccountType,
  rows: readonly AccountBalanceRow[],
  subtotals: ReadonlyMap<string, AccountBalance>,
): Section {
  const projected: BalanceSheetRow[] = [];
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

    const amount = sheetAmount(type, row.balance.closing);
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
      subtotal: sheetAmount(type, subtree.closing).toString(),
    });
  }

  return { rows: projected, total };
}

/**
 * One account's position, signed to its section.
 *
 * Negating the core's `debits - credits` for the credit-side sections rather than
 * recomputing `credits - debits`, so there is one subtraction in the system and
 * this is a sign applied to it. `type` and not `normalBalance` — see
 * `balanceSheetRowSchema`.
 */
function sheetAmount(type: BalanceSheetAccountType, amounts: BalanceAmounts): bigint {
  return type === 'asset' ? amounts.balance : -amounts.balance;
}

/**
 * Unclosed income over one window, as an equity figure.
 *
 * One expression for revenue and expense together, because `revenue - expenses` is
 * `-(revenueBalance + expenseBalance)` once both are `debits - credits`: revenue
 * earned is a net credit and an expense is a net debit, so negating their sum both
 * subtracts the expenses and puts the result on the credit side that equity prints
 * on. Writing it as two signed sections and subtracting would be the same number
 * reached by two more steps, each of which can carry a sign error.
 *
 * The consequence worth stating: a profit is positive here, and it *adds* to
 * liabilities-and-equity, which is what makes B3 an addition rather than a
 * subtraction on the page.
 */
function earnings(amounts: BalanceAmounts): bigint {
  return -amounts.balance;
}

/**
 * Subtree subtotals by account, read out of the forest the core already built.
 *
 * Signing happens after the rollup rather than before it, which is only sound
 * because a subtree never spans two account types — a parent's type must equal its
 * children's (`accounts/hierarchy.ts`) — so one sign applies to the whole subtree.
 * That same rule is why a section's rows form complete trees despite being filtered
 * out of a forest built over the whole chart: filtering by type removes whole trees
 * rather than severing any.
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

function toGroup(bucket: Bucket): BalanceSheetGroup {
  return {
    key: bucket.key,
    assets: wireSection(bucket.assets),
    liabilities: wireSection(bucket.liabilities),
    equity: wireSection(bucket.equity),
    totals: totalsOf([bucket]),
  };
}

function totalsOf(buckets: readonly Bucket[]): BalanceSheetTotals {
  let assets = 0n;
  let liabilities = 0n;
  let equity = 0n;
  let priorYearEarnings = 0n;
  let currentYearEarnings = 0n;

  for (const bucket of buckets) {
    assets += bucket.assets.total;
    liabilities += bucket.liabilities.total;
    equity += bucket.equity.total;
    priorYearEarnings += bucket.priorYearEarnings;
    currentYearEarnings += bucket.currentYearEarnings;
  }

  const liabilitiesAndEquity = liabilities + equity + priorYearEarnings + currentYearEarnings;

  return {
    assets: assets.toString(),
    liabilities: liabilities.toString(),
    equity: equity.toString(),
    priorYearEarnings: priorYearEarnings.toString(),
    currentYearEarnings: currentYearEarnings.toString(),
    liabilitiesAndEquity: liabilitiesAndEquity.toString(),
    // Reported, not asserted, following the trial balance: this report says what the
    // ledger contains. A slice may be legitimately non-zero (D-18 — tags are per
    // line), and a whole sheet that is not is a fact an operator needs to see rather
    // than an exception thrown from inside a read.
    difference: (assets - liabilitiesAndEquity).toString(),
  };
}

function wireSection(section: Section): BalanceSheetSection {
  return { rows: section.rows, total: section.total.toString() };
}
