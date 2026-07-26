import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { getTrialBalance, type TrialBalance, type TrialBalanceRow } from '../../src/modules/ledger';
import { ledgerPlanArb } from './arbitraries';
import { createScene, postPlan, useLedgerDatabase, withContext, type JournalPlan } from './support';

/**
 * Spec §11 invariant 3: the accounting equation.
 *
 * ## Deriving the form, rather than quoting one
 *
 * `journal_lines` holds two non-negative columns (`0002_ledger`), so the only signed
 * quantity the ledger produces is a **debit-positive** balance — `debits - credits`,
 * which is exactly what `TrialBalanceRow.balance` carries. Write `D(t)` for the sum of
 * that balance over every account whose `accounts.type` is `t`. Because every journal
 * balances, summing over all five values of the enum gives
 *
 *     D(asset) + D(liability) + D(equity) + D(revenue) + D(expense) = 0
 *
 * That is true, and on its own it is worth nothing: it is the org-wide
 * debits-equal-credits invariant with the accounts sorted into piles first. The
 * equation only becomes a statement about the *classification* once each type is
 * expressed in the sign its side of the books is conventionally read in —
 * debit-positive for assets and expenses, credit-positive for liabilities, equity, and
 * revenue:
 *
 *     A = D(asset)      L = -D(liability)     E = -D(equity)
 *     R = -D(revenue)   X = D(expense)
 *
 * Substituting into the sum gives `A - L - E - R + X = 0`, that is
 *
 *     Assets = Liabilities + Equity + Revenue - Expenses
 *
 * This is the *expanded* equation, and it is the right one for M1. The familiar
 * `A = L + E` holds only after the closing entry folds revenue and expenses into
 * equity, and M1 has no period-close posting (D-08 ships plain open/closed) — so
 * asserting `A = L + E` against this ledger would fail on the first sale for a reason
 * that is not a defect.
 *
 * ## The sign follows `type`, never `normal_balance`
 *
 * This is the part that is easy to get wrong, and the reason the generator produces
 * contra accounts. `0002_ledger` stores `normal_balance` separately from `type`
 * precisely because they come apart: accumulated depreciation is an `asset` with a
 * credit normal balance, a sales discount is `revenue` with a debit one.
 *
 * A contra account belongs to its type's side of the equation and contributes
 * *negatively* to it — accumulated depreciation reduces assets, it does not become a
 * liability. So the classification above reads `type` and nothing else, and
 * `normal_balance` plays no part in the equation at all. Computing each account's
 * balance in its own natural direction first and then summing by type is the plausible
 * wrong answer: it flips the sign of every contra account, which would put
 * accumulated depreciation on the wrong side of `=` while remaining perfectly correct
 * for a chart with no contra accounts in it. Hence `contraSensitivity` below, which
 * pins the difference with numbers a reader can check by hand.
 */
const harness = useLedgerDatabase();

/** See `balance.test.ts` for the run-count reasoning; the shape and cost match. */
const RUNS = 75;

interface Classified {
  readonly assets: bigint;
  readonly liabilities: bigint;
  readonly equity: bigint;
  readonly revenue: bigint;
  readonly expenses: bigint;
}

/** `D(t)`: the org's net debit-positive balance across accounts of one type. */
function netDebitBalance(trialBalance: TrialBalance, type: TrialBalanceRow['type']): bigint {
  return trialBalance.rows
    .filter((row) => row.type === type)
    .reduce((running, row) => running + BigInt(row.balance), 0n);
}

function classify(trialBalance: TrialBalance): Classified {
  return {
    assets: netDebitBalance(trialBalance, 'asset'),
    liabilities: -netDebitBalance(trialBalance, 'liability'),
    equity: -netDebitBalance(trialBalance, 'equity'),
    revenue: -netDebitBalance(trialBalance, 'revenue'),
    expenses: netDebitBalance(trialBalance, 'expense'),
  };
}

function rightHandSide(totals: Classified): bigint {
  return totals.liabilities + totals.equity + totals.revenue - totals.expenses;
}

describe('assets = liabilities + equity + revenue - expenses (spec §11)', () => {
  it('holds for any chart of accounts and any set of balanced journals', async () => {
    await fc.assert(
      fc.asyncProperty(ledgerPlanArb, async (plan) => {
        const scene = await createScene(harness, plan.accounts);
        await postPlan(scene, plan.journals);

        const trialBalance = await withContext(scene.ctx, () => getTrialBalance());
        const totals = classify(trialBalance);

        expect(totals.assets).toBe(rightHandSide(totals));

        // The generated chart may legitimately be degenerate for a single run — a
        // ledger of nothing but asset-to-asset transfers satisfies the equation as
        // 0 = 0. So this pins what can be pinned every run: that the report saw the
        // postings at all. Non-degenerate classifications arrive across runs, because
        // account types are drawn uniformly from the five-value enum, and
        // `contraSensitivity` below covers the one case that must not be left to
        // chance.
        expect(BigInt(trialBalance.totalDebits)).toBeGreaterThan(0n);
        expect(trialBalance.difference).toBe('0');
      }),
      { numRuns: RUNS },
    );
  });

  /**
   * The deterministic anchor. A property can only assert that two derived sums agree;
   * it cannot tell a reader whether the derivation is the *right* one. This posts an
   * ordinary month of books containing one contra-asset and states every term, so the
   * sign convention above is checkable by hand rather than by argument.
   */
  it('puts a contra-asset on the asset side, reducing it (the anchor for the sign convention)', async () => {
    const scene = await createScene(harness, [
      { type: 'asset', normalBalance: 'debit' }, // 1000 cash
      { type: 'asset', normalBalance: 'credit' }, // 1001 accumulated depreciation
      { type: 'liability', normalBalance: 'credit' }, // 1002 bank loan
      { type: 'equity', normalBalance: 'credit' }, // 1003 owner's capital
      { type: 'revenue', normalBalance: 'credit' }, // 1004 sales
      { type: 'expense', normalBalance: 'debit' }, // 1005 rent
    ]);

    const cash = 0;
    const accumulatedDepreciation = 1;
    const loan = 2;
    const capital = 3;
    const sales = 4;
    const rent = 5;

    const entry = (debit: number, credit: number, amount: bigint): JournalPlan => ({
      date: '2026-03-31',
      lines: [
        { accountIndex: debit, side: 'debit', amount },
        { accountIndex: credit, side: 'credit', amount },
      ],
    });

    await postPlan(scene, [
      entry(cash, sales, 50_000n), // a sale, settled in cash
      entry(rent, cash, 12_000n), // rent paid
      entry(cash, loan, 100_000n), // loan drawn down
      entry(cash, capital, 25_000n), // owner puts money in
      entry(rent, accumulatedDepreciation, 3_000n), // depreciation charge
    ]);

    const totals = classify(await withContext(scene.ctx, () => getTrialBalance()));

    // Cash is 50,000 + 100,000 + 25,000 - 12,000 = 163,000 debit, and accumulated
    // depreciation is 3,000 credit. Assets are therefore 160,000: the contra account
    // *subtracts*. Reading its 3,000 in its own natural (credit) direction and adding
    // it to the pile would give 166,000 and break the equation by 6,000 — which is
    // what this line exists to rule out.
    expect(totals.assets).toBe(160_000n);
    expect(totals.liabilities).toBe(100_000n);
    expect(totals.equity).toBe(25_000n);
    expect(totals.revenue).toBe(50_000n);
    expect(totals.expenses).toBe(15_000n); // 12,000 rent + 3,000 depreciation
    expect(rightHandSide(totals)).toBe(160_000n);
  });
});
