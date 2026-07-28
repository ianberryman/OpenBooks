import { sql } from 'kysely';
import type { SqlBool } from 'kysely';

import type { TenantDatabase } from '../../../db';
import { bufferToUuid } from '../../../db';
import { balanceOf, ZERO_AMOUNTS } from '../amounts';
import type { AggregatedBalanceRow, BalanceQuerySpec } from '../balances.repository';

import { recognizeCashBasis } from './recognition';
import type { DirectCashResult } from './repository';
import { gatherDirectCash, gatherRecognizableDocuments } from './repository';

/**
 * The cash-basis transform (OB-154; D-87) — a drop-in for `selectAccountBalances`.
 *
 * It emits `AggregatedBalanceRow[]` in the exact shape the accrual core does, so
 * `getProfitAndLoss` (and, later, the Statement of Cash Flows) project over it
 * unchanged and `basis` is a dispatch rather than a second report. The rows are dense
 * — every account matching the spec appears, at zero if it recognised nothing — the
 * same denseness the accrual core gets from its `LEFT JOIN` from `accounts`.
 *
 * ## Scope
 *
 * Recognition is path A (document settlement) and path B (direct cash journals), and
 * covers the P&L accounts a cash-basis P&L reads; `review` carries the K3/K4 edges the
 * transform flags rather than guesses. Still deferred, the interface shaped for them:
 * dimension grouping (`groupValueId` is always `null`) and a cash-basis balance sheet
 * (which needs D-20's current-year-earnings reconciliation).
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
  const [documents, directCash] = await Promise.all([
    gatherRecognizableDocuments(db),
    gatherDirectCash(db),
  ]);
  const recognized = recognizeCashBasis(
    { documents, directCashLegs: directCash.legs },
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

  return { rows, review: reviewFlagsOf(directCash) };
}

/**
 * The edges D-87 flags rather than guesses (K3/K4), turned from the repository's counts
 * into the wire's `review` list. Each is a whole class of judgment the report will not
 * make silently: an unapplied receipt that might or might not be income, a cash journal
 * mixing cash with an accrual account whose cash content is not a clean fraction. A
 * count of zero produces no flag, so a clean ledger reports an empty list rather than a
 * row of noughts.
 */
function reviewFlagsOf(directCash: DirectCashResult): readonly ReviewFlag[] {
  const flags: ReviewFlag[] = [];
  if (directCash.unallocatedReceiptCount > 0) {
    flags.push({
      kind: 'unallocated_receipt',
      detail:
        `${String(directCash.unallocatedReceiptCount)} received payment(s) settle no invoice. ` +
        'Whether cash held against nothing on the subledger is income is a judgment; it is not ' +
        'recognised here.',
    });
  }
  if (directCash.mixedCashJournalCount > 0) {
    flags.push({
      kind: 'mixed_cash_journal',
      detail:
        `${String(directCash.mixedCashJournalCount)} cash journal(s) also touch an accrual ` +
        'account, so how much of their revenue or expense the cash backs is ambiguous. They are ' +
        'flagged rather than split.',
    });
  }
  return flags;
}
