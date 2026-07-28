import type { ReportBasis, StatementOfCashFlowsQueryParams } from '@openbooks/shared-types';
import { statementOfCashFlowsQuerySchema } from '@openbooks/shared-types';

import { getContext } from '../../context';
import type { RequestContext } from '../../context';
import { bufferToUuid } from '../../db';
import type { TenantDatabase } from '../../db';
import { parseInput } from '../../errors';
import { requirePermission } from '../permissions';

import { orgScope } from './balances.repository';
import { getAccountBalances } from './balances.service';
import { getProfitAndLoss } from './profit-and-loss.service';

/**
 * The Statement of Cash Flows, indirect method (OB-157; D-88).
 *
 * A projection over two calls to the report core, like every M2/K report before it —
 * the P&L for `netIncome`, and `getAccountBalances` again, filtered to the org's cash
 * accounts, for the movement that is the change in cash. No third aggregation and no
 * query of its own beyond finding which accounts count as cash.
 *
 * ## Why `adjustments` is a plug rather than a derivation
 *
 * `shared-types/reports/cash-flow.ts` argues this at length; the short version is
 * that a categorized operating/investing/financing split needs a fixed-asset
 * register and a per-account activity classification neither of which exists yet,
 * and a wrong split is worse than an honest one-line reconciliation. `adjustments`
 * is therefore defined as `netChangeInCash - netIncome` — the statement balances by
 * construction, and the day a real classification lands, `adjustments` is the line
 * it explains rather than replaces.
 *
 * ## Why the cash-accounts movement is always read accrual
 *
 * `netIncome` follows the request's basis (or the org default), because recognition
 * timing is exactly what `basis` chooses between. Which account a payment landed in
 * is not a recognition question — a bank transfer posted today moved cash today
 * whether or not the org recognises revenue at invoice or at payment — so the cash
 * side of the reconciliation is read through `getAccountBalances` with no `basis`
 * option, which defaults to accrual (`balances.service.ts`).
 *
 * ## Which accounts are cash
 *
 * `selectCashAccountIds` below: every account named by `bank_accounts.account_id`,
 * union every account an operator has flagged `accounts.cash_basis_role = 'cash'` —
 * the same hint OB-154's transform reads for the same question asked by a different
 * report. An org with neither produces an honest empty statement (every figure
 * `"0"`), the same dense-report choice `getAccountBalances` makes for an account with
 * no postings, rather than a special-cased refusal.
 *
 * ## Surface
 *
 * | Operation                             | Permission     |
 * | -------------------------------------- | -------------- |
 * | `getStatementOfCashFlows(query, ctx)` | `reports.read` |
 */

export interface StatementOfCashFlowsRange {
  readonly from: string | null;
  readonly to: string | null;
}

export interface StatementOfCashFlows {
  readonly range: StatementOfCashFlowsRange;
  /** Which basis produced `netIncome` (K1, D-87) — the request's, or the org's default. */
  readonly basis: ReportBasis;
  readonly netIncome: string;
  readonly openingCash: string;
  readonly closingCash: string;
  readonly netChangeInCash: string;
  /** `netChangeInCash - netIncome`. See the file comment for why this is a plug. */
  readonly adjustments: string;
  /**
   * `openingCash + netChangeInCash === closingCash` and `netIncome + adjustments ===
   * netChangeInCash`. True by construction; reported rather than asserted, following
   * the trial balance's convention for a figure that should always tie.
   */
  readonly reconciles: boolean;
}

export type StatementOfCashFlowsQuery = StatementOfCashFlowsQueryParams;

/**
 * Net income, the change in cash, and the reconciliation between them, over a date
 * range.
 *
 * `reports.read`, checked here as well as by `getProfitAndLoss` and
 * `getAccountBalances` beneath it — each report states its own authority rather than
 * inheriting one from a function it happens to call, the same reasoning
 * `profit-and-loss.service.ts` gives for its own second check.
 */
export async function getStatementOfCashFlows(
  query: StatementOfCashFlowsQuery = {},
  ctx: RequestContext = getContext('getStatementOfCashFlows()'),
): Promise<StatementOfCashFlows> {
  await requirePermission(ctx, 'reports.read');
  const request = parseInput(statementOfCashFlowsQuerySchema, query);
  const { basis, from, to } = request;

  const range = {
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  };

  const [profitAndLoss, cashAccountIds] = await Promise.all([
    getProfitAndLoss({ ...range, ...(basis === undefined ? {} : { basis }) }, ctx),
    selectCashAccountIds(orgScope(ctx)),
  ]);

  const cash = await getAccountBalances(range, ctx, { accountIds: cashAccountIds });

  const netIncome = BigInt(profitAndLoss.totals.netIncome);
  const openingCash = cash.totals.opening.balance;
  const closingCash = cash.totals.closing.balance;
  const netChangeInCash = cash.totals.movement.balance;
  const adjustments = netChangeInCash - netIncome;

  return {
    range: profitAndLoss.range,
    basis: profitAndLoss.basis,
    netIncome: netIncome.toString(),
    openingCash: openingCash.toString(),
    closingCash: closingCash.toString(),
    netChangeInCash: netChangeInCash.toString(),
    adjustments: adjustments.toString(),
    reconciles:
      openingCash + netChangeInCash === closingCash && netIncome + adjustments === netChangeInCash,
  };
}

/**
 * Every account this org treats as cash: registered in `bank_accounts`, or flagged
 * `cash_basis_role = 'cash'` directly on the account (the same hint OB-154 reads).
 *
 * Two reads and a `Set` rather than one `UNION` query, because the two sources name
 * accounts by different columns (`bank_accounts.account_id` vs `accounts.id`) and a
 * dedupe against a bank account that also carries the flag is simpler in JS than in
 * a `UNION DISTINCT` over two differently-shaped selects.
 */
async function selectCashAccountIds(db: TenantDatabase): Promise<readonly string[]> {
  const [registered, flagged] = await Promise.all([
    db.selectFrom('bank_accounts').select('account_id').execute(),
    db.selectFrom('accounts').select('id').where('cash_basis_role', '=', 'cash').execute(),
  ]);

  const ids = new Set<string>();
  for (const row of registered) ids.add(bufferToUuid(row.account_id));
  for (const row of flagged) ids.add(bufferToUuid(row.id));

  return [...ids];
}
