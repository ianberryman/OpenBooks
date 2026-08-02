import type {
  PayoutBreakdown,
  PayoutCategoryAmount,
  PayoutReportingCategory,
} from '@openbooks/plugin-api';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { PayoutSummaryAccounts } from '../../src/modules/payments-processing/summary-journal.builder';
import { buildPayoutSummaryJournal } from '../../src/modules/payments-processing/summary-journal.builder';

/**
 * Pure-function coverage for OB-237's summary-journal builder — no database, no
 * testcontainers (the function posts nothing; `postJournal` is the caller's job,
 * not this file's). The example test below reproduces the `fake` payout
 * breakdown (`providers/payment/fake.ts`'s own fixed numbers) so a change to
 * either drifts the other visibly. The property test is the "clearing plug is
 * consistent with the categories" invariant `unbalanced` exists to catch,
 * generated rather than enumerated (the `idempotency.property.test.ts` /
 * `report.property.test.ts` discipline this repo already uses).
 */

const CLEARING = 'acct_clearing';
const FEE = 'acct_fee';
const REVENUE = 'acct_revenue';
const REFUND = 'acct_refund_contra';
const TAX = 'acct_sales_tax_payable';
const DISPUTE = 'acct_dispute_loss';
const ADJUSTMENT = 'acct_adjustment';

const FULLY_MAPPED_ACCOUNTS: PayoutSummaryAccounts = {
  clearingAccountId: CLEARING,
  feeAccountId: FEE,
  byCategory: new Map<PayoutReportingCategory, string>([
    ['charge', REVENUE],
    ['refund', REFUND],
    ['tax', TAX],
    ['dispute', DISPUTE],
    ['adjustment', ADJUSTMENT],
  ]),
};

function breakdown(
  payoutId: string,
  netMinor: string,
  categories: readonly PayoutCategoryAmount[],
): PayoutBreakdown {
  return {
    payoutId,
    netMinor,
    currency: 'usd',
    occurredAt: '2024-01-01T00:00:00.000Z',
    categories,
  };
}

function category(
  reportingCategory: PayoutReportingCategory,
  amountMinor: string,
): PayoutCategoryAmount {
  return { reportingCategory, amountMinor, count: 1 };
}

describe('buildPayoutSummaryJournal', () => {
  it('builds the fake adapters fixed breakdown into 4 balanced lines', () => {
    // `providers/payment/fake.ts`'s `fetchPayoutBreakdown` fixture: charge
    // 10000 credited to revenue; fee 300 and refund 500 debited; clearing
    // debited the net 9200 (= 10000 − 300 − 500).
    const po = breakdown('po_fake_1', '9200', [
      category('charge', '10000'),
      category('fee', '300'),
      category('refund', '500'),
    ]);

    const result = buildPayoutSummaryJournal(po, FULLY_MAPPED_ACCOUNTS);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok:true');

    expect(result.lines).toEqual([
      {
        accountId: CLEARING,
        side: 'debit',
        amount: 9_200n,
        memo: 'payout po_fake_1 · net',
      },
      {
        accountId: REVENUE,
        side: 'credit',
        amount: 10_000n,
        memo: 'payout po_fake_1 · charge',
      },
      {
        accountId: REFUND,
        side: 'debit',
        amount: 500n,
        memo: 'payout po_fake_1 · refund',
      },
      {
        accountId: FEE,
        side: 'debit',
        amount: 300n,
        memo: 'payout po_fake_1 · fee',
      },
    ]);

    const debits = result.lines.filter((line) => line.side === 'debit');
    const credits = result.lines.filter((line) => line.side === 'credit');
    const debitTotal = debits.reduce((total, line) => total + line.amount, 0n);
    const creditTotal = credits.reduce((total, line) => total + line.amount, 0n);
    expect(debitTotal).toBe(creditTotal);
    expect(debitTotal).toBe(10_000n);
  });

  it('an all-zero breakdown produces no lines', () => {
    const po = breakdown('po_zero', '0', [
      category('charge', '0'),
      category('fee', '0'),
      category('refund', '0'),
    ]);

    expect(buildPayoutSummaryJournal(po, FULLY_MAPPED_ACCOUNTS)).toEqual({
      ok: false,
      reason: 'no_lines',
    });
  });

  it('a non-zero category with no mapped account is unmapped_category, not a thrown error', () => {
    const accountsMissingDispute: PayoutSummaryAccounts = {
      clearingAccountId: CLEARING,
      feeAccountId: FEE,
      byCategory: new Map<PayoutReportingCategory, string>([['charge', REVENUE]]),
    };
    const po = breakdown('po_dispute', '9500', [
      category('charge', '10000'),
      category('dispute', '500'),
    ]);

    const result = buildPayoutSummaryJournal(po, accountsMissingDispute);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.reason.startsWith('unmapped_category:dispute')).toBe(true);
  });

  it('an inconsistent net (not the implied plug) is unbalanced', () => {
    // The categories imply a plug of 10000 − 300 − 500 = 9200; reporting 9300
    // as the net makes the journal 100 minor units off.
    const po = breakdown('po_inconsistent', '9300', [
      category('charge', '10000'),
      category('fee', '300'),
      category('refund', '500'),
    ]);

    expect(buildPayoutSummaryJournal(po, FULLY_MAPPED_ACCOUNTS)).toEqual({
      ok: false,
      reason: 'unbalanced',
    });
  });

  it('a negative category magnitude is rejected rather than posted', () => {
    const po = breakdown('po_negative', '9700', [
      category('charge', '10000'),
      category('fee', '-300'),
    ]);

    const result = buildPayoutSummaryJournal(po, FULLY_MAPPED_ACCOUNTS);
    expect(result).toEqual({ ok: false, reason: 'negative_amount:fee' });
  });

  describe('property: a consistent breakdown always balances', () => {
    const minorAmountArb = fc.integer({ min: 0, max: 1_000_000 }).map((n) => BigInt(n));

    const consistentPlanArb = fc
      .record({
        chargeGross: minorAmountArb,
        tax: minorAmountArb,
        fee: minorAmountArb,
        refund: minorAmountArb,
        dispute: minorAmountArb,
        adjustment: minorAmountArb,
      })
      .filter((plan) => {
        const net =
          plan.chargeGross + plan.tax - plan.fee - plan.refund - plan.dispute - plan.adjustment;
        return net >= 0n;
      });

    it('ok:true and debits equal credits, for any consistent generated breakdown', () => {
      let sawMultipleCategories = false;

      fc.assert(
        fc.property(consistentPlanArb, (plan) => {
          const netMinor = (
            plan.chargeGross +
            plan.tax -
            plan.fee -
            plan.refund -
            plan.dispute -
            plan.adjustment
          ).toString();

          const categories: PayoutCategoryAmount[] = [];
          if (plan.chargeGross > 0n)
            categories.push(category('charge', plan.chargeGross.toString()));
          if (plan.tax > 0n) categories.push(category('tax', plan.tax.toString()));
          if (plan.fee > 0n) categories.push(category('fee', plan.fee.toString()));
          if (plan.refund > 0n) categories.push(category('refund', plan.refund.toString()));
          if (plan.dispute > 0n) categories.push(category('dispute', plan.dispute.toString()));
          if (plan.adjustment > 0n)
            categories.push(category('adjustment', plan.adjustment.toString()));

          const po = breakdown('po_property', netMinor, categories);
          const result = buildPayoutSummaryJournal(po, FULLY_MAPPED_ACCOUNTS);

          // A net of 0 with no non-zero categories builds no lines at all
          // (`no_lines`) — a legitimate outcome the property has to allow for
          // rather than assert `ok:true` unconditionally.
          if (netMinor === '0' && categories.length === 0) {
            expect(result).toEqual({ ok: false, reason: 'no_lines' });
            return;
          }

          expect(result.ok).toBe(true);
          if (!result.ok) throw new Error('expected ok:true');

          if (categories.length > 1) sawMultipleCategories = true;

          const debitTotal = result.lines
            .filter((line) => line.side === 'debit')
            .reduce((total, line) => total + line.amount, 0n);
          const creditTotal = result.lines
            .filter((line) => line.side === 'credit')
            .reduce((total, line) => total + line.amount, 0n);
          expect(debitTotal).toBe(creditTotal);
        }),
        { numRuns: 200 },
      );

      expect(sawMultipleCategories).toBe(true);
    });
  });
});
