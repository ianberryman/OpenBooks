import { sql } from 'kysely';
import type { SqlBool } from 'kysely';

import type { TenantDatabase } from '../../../db';
import { bufferToUuid } from '../../../db';
import { balanceOf, ZERO_AMOUNTS } from '../amounts';
import type { AggregatedBalanceRow, BalanceQuerySpec } from '../balances.repository';

import { recognizeCashBasis } from './recognition';
import { gatherRecognizableDocuments } from './repository';

/**
 * The cash-basis transform (OB-154; D-87) — a drop-in for `selectAccountBalances`.
 *
 * It emits `AggregatedBalanceRow[]` in the exact shape the accrual core does, so
 * `getProfitAndLoss` (and, later, the Statement of Cash Flows) project over it
 * unchanged and `basis` is a dispatch rather than a second report. The rows are dense
 * — every account matching the spec appears, at zero if it recognised nothing — the
 * same denseness the accrual core gets from its `LEFT JOIN` from `accounts`.
 *
 * ## Scope of this first increment
 *
 * Recognition is **path A only** (document settlement, `repository.ts`) and covers the
 * P&L accounts a cash-basis P&L reads. It deliberately does not yet do: direct cash
 * journals (path B), the review flags (D-99 — `review` is returned empty and is the
 * seam they land on), dimension grouping, or a cash-basis balance sheet (which needs
 * D-20's current-year-earnings reconciliation). `groupValueId` is therefore always
 * `null`. Those are the following increments; the interface is shaped for them now so
 * adding them does not move this seam.
 */

/** A ledger fact the transform could not recognise deterministically (D-99). */
export interface ReviewFlag {
  readonly kind: string;
  readonly detail: string;
}

export interface CashBasisResult {
  readonly rows: readonly AggregatedBalanceRow[];
  /** Empty in this increment; the seam the D-99 review list surfaces through. */
  readonly review: readonly ReviewFlag[];
}

export async function selectCashBasisBalances(
  db: TenantDatabase,
  spec: BalanceQuerySpec,
): Promise<CashBasisResult> {
  const documents = await gatherRecognizableDocuments(db);
  const recognized = recognizeCashBasis(
    { documents, directCashLegs: [] },
    { from: spec.from, to: spec.to },
  );

  let query = db
    .selectFrom('accounts')
    .select([
      'accounts.id as id',
      'accounts.code as code',
      'accounts.name as name',
      'accounts.type as type',
      'accounts.normal_balance as normal_balance',
      'accounts.parent_account_id as parent_account_id',
      'accounts.is_active as is_active',
    ])
    .orderBy('accounts.code');

  if (spec.types !== null) query = query.where('accounts.type', 'in', [...spec.types]);
  if (spec.accountIds !== null) {
    // An empty list is a report on no accounts, the same honest empty set the accrual
    // core writes rather than folding to "no filter" and answering with the whole chart.
    query =
      spec.accountIds.length === 0
        ? query.where(sql<SqlBool>`FALSE`)
        : query.where('accounts.id', 'in', [...spec.accountIds]);
  }

  const accounts = await query.execute();

  const rows: AggregatedBalanceRow[] = accounts.map((account) => {
    const recognised = recognized.get(bufferToUuid(account.id));
    return {
      accountId: bufferToUuid(account.id),
      code: account.code,
      name: account.name,
      type: account.type,
      normalBalance: account.normal_balance,
      parentAccountId:
        account.parent_account_id === null ? null : bufferToUuid(account.parent_account_id),
      isActive: account.is_active === 1,
      groupValueId: null,
      balance: balanceOf(recognised?.opening ?? ZERO_AMOUNTS, recognised?.movement ?? ZERO_AMOUNTS),
    };
  });

  return { rows, review: [] };
}
