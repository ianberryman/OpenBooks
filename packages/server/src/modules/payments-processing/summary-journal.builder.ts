import type {
  JournalLineInput,
  PayoutBreakdown,
  PayoutReportingCategory,
} from '@openbooks/plugin-api';
import type { Money } from '@openbooks/shared-types/money';
import {
  equals,
  fromMinorString,
  isNegative,
  isZero,
  sum,
  toMinorUnits,
} from '@openbooks/shared-types/money';

/**
 * Turns one payout's grossed-up breakdown into a balanced draft journal (OB-237,
 * D-237-1: "one summary journal per payout, not one per underlying charge" — a
 * payout can roll up hundreds of balance transactions, and posting each as its
 * own line would make the journal unreadable without changing what it proves).
 * D-237-4 is the shape this consumes: `PayoutBreakdown.netMinor` is the clearing
 * plug, and each `PayoutCategoryAmount` is a non-negative magnitude whose side
 * this file — not the adapter — assigns.
 *
 * This mirrors `refundJournalLines` / `feeJournalLines` in `posting.service.ts`
 * one level up: a small pure function that returns `JournalLineInput[]` for a
 * caller to hand to `postJournal`, never a writer itself. It differs from those
 * two in one way worth flagging — it can *fail* to build a journal (an unmapped
 * category, an inconsistent net) rather than always producing one, because a
 * payout's breakdown arrives from Stripe's own aggregation and is not something
 * this codebase controls the shape of the way a charge or refund event is.
 * Failure is a return value, not a throw (`{ ok: false, reason }`), so the
 * caller — the payout sync — can record `reason` on the payout row and mark it
 * `'skipped'` rather than crash a poll loop over one bad payout among many.
 *
 * ## Why the clearing line is a debit, and a plug
 *
 * A charge already debited the connection's clearing account when it cleared AR
 * (D-82, `recordProcessorCharge`); a payout empties that account into the real
 * bank. Debiting clearing here for `netMinor` is that emptying, and it is
 * deliberately the *net* — not `sum(categories)` recomputed — because `netMinor`
 * is what Stripe actually transferred and is the number the later bank deposit
 * has to net against. When the deposit's own journal lands (`Dr Bank / Cr
 * Clearing`, posted by the *existing* M4 pipeline when the statement line
 * clears — D-82's `recordProcessorPayout` comment is explicit that this file
 * posts no such journal), clearing nets to zero for the payout: this journal's
 * debit here is exactly what that later credit reverses. `netMinor` is trusted
 * as the plug rather than derived from the categories, which is why the
 * balance check below is a *consistency check on the adapter's own numbers*,
 * not a computation this function performs.
 */

/**
 * Where each `PayoutReportingCategory` posts. `clearingAccountId` and
 * `feeAccountId` are carried separately from `byCategory` because they are the
 * two accounts `processor_connections` already nominates (D-103's "nominate,
 * don't invent", the same constraint `recordProcessorChargeback` cites) — a
 * payout sync has them on hand without a lookup. `byCategory` covers the
 * categories that have no such standing account: revenue, sales tax payable,
 * contra-revenue, dispute loss, adjustment — each an org-level chart-of-accounts
 * choice, not a per-connection one. A `'fee'` entry in `byCategory` is honored
 * over `feeAccountId` so an org that wants payout fees to land somewhere other
 * than the per-charge fee account can say so without this function changing.
 */
export interface PayoutSummaryAccounts {
  readonly clearingAccountId: string;
  readonly feeAccountId: string;
  /** category -> ledger accountId, for the mapped categories (charge/refund/tax/dispute/adjustment; a 'fee' entry here overrides feeAccountId). */
  readonly byCategory: ReadonlyMap<PayoutReportingCategory, string>;
}

export type BuildPayoutSummaryResult =
  | { readonly ok: true; readonly lines: readonly JournalLineInput[] }
  | { readonly ok: false; readonly reason: string };

/**
 * The fixed posting order below — clearing, then charge/refund/fee/tax/dispute/
 * adjustment — is what makes the output deterministic for a given breakdown.
 * `PayoutBreakdown.categories` carries no ordering guarantee of its own (Stripe's
 * aggregation order is not a contract), so without a fixed order here the same
 * breakdown could build two different-looking journals across two calls.
 */
const CATEGORY_POSTING_ORDER: readonly PayoutReportingCategory[] = [
  'charge',
  'refund',
  'fee',
  'tax',
  'dispute',
  'adjustment',
];

const CREDIT_CATEGORIES: ReadonlySet<PayoutReportingCategory> = new Set<PayoutReportingCategory>([
  'charge',
  'tax',
]);

export function buildPayoutSummaryJournal(
  breakdown: PayoutBreakdown,
  accounts: PayoutSummaryAccounts,
): BuildPayoutSummaryResult {
  const amountByCategory = new Map(
    breakdown.categories.map((category) => [category.reportingCategory, category] as const),
  );

  const lines: JournalLineInput[] = [];
  const debitAmounts: Money[] = [];
  const creditAmounts: Money[] = [];

  const netAmount = fromMinorString(breakdown.netMinor);
  if (!isZero(netAmount)) {
    lines.push({
      accountId: accounts.clearingAccountId,
      side: 'debit',
      amount: toMinorUnits(netAmount),
      memo: `payout ${breakdown.payoutId} · net`,
    });
    debitAmounts.push(netAmount);
  }

  for (const category of CATEGORY_POSTING_ORDER) {
    const entry = amountByCategory.get(category);
    if (entry === undefined) continue;

    const amount = fromMinorString(entry.amountMinor);
    if (isNegative(amount)) {
      return { ok: false, reason: `negative_amount:${category}` };
    }
    if (isZero(amount)) continue;

    const accountId =
      category === 'fee'
        ? (accounts.byCategory.get('fee') ?? accounts.feeAccountId)
        : accounts.byCategory.get(category);
    if (accountId === undefined) {
      return { ok: false, reason: `unmapped_category:${category}` };
    }

    const side = CREDIT_CATEGORIES.has(category) ? 'credit' : 'debit';
    lines.push({
      accountId,
      side,
      amount: toMinorUnits(amount),
      memo: `payout ${breakdown.payoutId} · ${category}`,
    });
    (side === 'credit' ? creditAmounts : debitAmounts).push(amount);
  }

  if (lines.length < 2) {
    return { ok: false, reason: 'no_lines' };
  }

  if (!equals(sum(debitAmounts), sum(creditAmounts))) {
    return { ok: false, reason: 'unbalanced' };
  }

  return { ok: true, lines };
}
