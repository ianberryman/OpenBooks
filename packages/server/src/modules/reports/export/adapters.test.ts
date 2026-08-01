import type {
  Aging,
  AgingAmounts,
  BudgetVsActual,
  GeneralLedger,
  GeneralLedgerEntry,
} from '@openbooks/shared-types';
import { describe, expect, it } from 'vitest';

import type { TrialBalance } from '../../ledger';
import type { BalanceSheet } from '../balance-sheet.service';
import type { StatementOfCashFlows } from '../cash-flow.service';
import type { ProfitAndLoss } from '../profit-and-loss.service';

import {
  agingToTabular,
  balanceSheetToTabular,
  budgetVsActualToTabular,
  cashFlowToTabular,
  generalLedgerToTabular,
  profitAndLossToTabular,
  trialBalanceToTabular,
} from './adapters';

/**
 * Each `*ToTabular` adapter's flatten (OB-220 part 2), against a hand-built,
 * minimal report object of that report's own shape — pure and colocated, like
 * `csv.test.ts`/`xlsx.test.ts` next door.
 */

const ZERO_AMOUNTS: AgingAmounts = {
  current: '0',
  days1To30: '0',
  days31To60: '0',
  days61To90: '0',
  days90Plus: '0',
  total: '0',
};

describe('trialBalanceToTabular', () => {
  const report: TrialBalance = {
    asOf: '2026-06-30',
    rows: [
      {
        accountId: 'acc-1',
        code: '1000',
        name: 'Cash',
        type: 'asset',
        normalBalance: 'debit',
        debits: '150000',
        credits: '0',
        balance: '150000',
      },
    ],
    totalDebits: '150000',
    totalCredits: '150000',
    difference: '0',
  };

  it('flattens to code / name / debit / credit columns, money as decimal strings', () => {
    const tabular = trialBalanceToTabular(report);

    expect(tabular.columns.map((column) => column.label)).toEqual([
      'Account code',
      'Account name',
      'Debit',
      'Credit',
    ]);
    expect(tabular.rows[0]).toEqual(['1000', 'Cash', '1500.00', '0.00']);
    expect(tabular.subtitle).toBe('As of 2026-06-30');
  });

  it('appends a total row', () => {
    const tabular = trialBalanceToTabular(report);
    expect(tabular.rows.at(-1)).toEqual(['', 'Total', '1500.00', '1500.00']);
  });

  it('omits the subtitle when `asOf` is null', () => {
    const tabular = trialBalanceToTabular({ ...report, asOf: null });
    expect(tabular.subtitle).toBeUndefined();
  });
});

describe('profitAndLossToTabular', () => {
  const report: ProfitAndLoss = {
    range: { from: '2026-01-01', to: '2026-03-31' },
    basis: 'accrual',
    groupBy: null,
    groups: [
      {
        key: null,
        revenue: {
          rows: [
            {
              accountId: 'acc-rev',
              code: '4000',
              name: 'Sales',
              type: 'revenue',
              normalBalance: 'credit',
              parentAccountId: null,
              isActive: true,
              amount: '200000',
              subtotal: '200000',
            },
          ],
          total: '200000',
        },
        expenses: {
          rows: [
            {
              accountId: 'acc-exp',
              code: '5000',
              name: 'Rent',
              type: 'expense',
              normalBalance: 'debit',
              parentAccountId: null,
              isActive: true,
              amount: '50000',
              subtotal: '50000',
            },
          ],
          total: '50000',
        },
        netIncome: '150000',
      },
    ],
    totals: { revenue: '200000', expenses: '50000', netIncome: '150000' },
    review: [],
  };

  it('flattens sections with headings, rows, section totals, and a net income line', () => {
    const tabular = profitAndLossToTabular(report);

    expect(tabular.columns.map((column) => column.label)).toEqual(['Account', 'Amount']);
    expect(tabular.rows).toEqual([
      ['Revenue', null],
      ['4000 Sales', '2000.00'],
      ['Revenue total', '2000.00'],
      ['Expenses', null],
      ['5000 Rent', '500.00'],
      ['Expenses total', '500.00'],
      ['Net income', '1500.00'],
    ]);
    expect(tabular.subtitle).toBe('2026-01-01 to 2026-03-31');
  });
});

describe('balanceSheetToTabular', () => {
  const report: BalanceSheet = {
    asOf: '2026-06-30',
    fiscalYear: { year: 2026, startMonth: 1, startDate: '2026-01-01', endDate: '2026-12-31' },
    basis: 'accrual',
    groupBy: null,
    groups: [
      {
        key: null,
        assets: {
          rows: [
            {
              accountId: 'acc-cash',
              code: '1000',
              name: 'Cash',
              type: 'asset',
              normalBalance: 'debit',
              parentAccountId: null,
              isActive: true,
              amount: '100000',
              subtotal: '100000',
            },
          ],
          total: '100000',
        },
        liabilities: { rows: [], total: '0' },
        equity: { rows: [], total: '0' },
        totals: {
          assets: '100000',
          liabilities: '0',
          equity: '0',
          priorYearEarnings: '0',
          currentYearEarnings: '100000',
          liabilitiesAndEquity: '100000',
          difference: '0',
        },
      },
    ],
    totals: {
      assets: '100000',
      liabilities: '0',
      equity: '0',
      priorYearEarnings: '0',
      currentYearEarnings: '100000',
      liabilitiesAndEquity: '100000',
      difference: '0',
    },
  };

  it('flattens the three sections plus the two derived earnings lines', () => {
    const tabular = balanceSheetToTabular(report);

    expect(tabular.rows).toEqual([
      ['Assets', null],
      ['1000 Cash', '1000.00'],
      ['Assets total', '1000.00'],
      ['Liabilities', null],
      ['Liabilities total', '0.00'],
      ['Equity', null],
      ['Equity total', '0.00'],
      ['Prior year earnings', '0.00'],
      ['Current year earnings', '1000.00'],
      ['Total liabilities and equity', '1000.00'],
    ]);
    expect(tabular.subtitle).toBe('As of 2026-06-30');
  });
});

describe('generalLedgerToTabular', () => {
  const entry: GeneralLedgerEntry = {
    lineId: '1',
    journalId: 'journal-1',
    sequenceNumber: '42',
    lineNumber: 1,
    date: '2026-02-01',
    journalMemo: 'Rent payment',
    lineMemo: null,
    contact: null,
    debit: '0',
    credit: '50000',
    runningBalance: '50000',
    counterparty: { accounts: [], accountCount: 1 },
    tags: [],
  };

  const report: GeneralLedger = {
    accountId: 'acc-1',
    code: '1000',
    name: 'Cash',
    type: 'asset',
    normalBalance: 'debit',
    from: '2026-01-01',
    to: '2026-02-28',
    opening: { debits: '0', credits: '0', balance: '0' },
    movement: { debits: '0', credits: '50000', balance: '-50000' },
    closing: { debits: '0', credits: '50000', balance: '-50000' },
    entries: [entry],
    nextCursor: null,
  };

  it('flattens the opening line, entries and the closing line', () => {
    const tabular = generalLedgerToTabular(report);

    expect(tabular.columns.map((column) => column.label)).toEqual([
      'Date',
      'Journal',
      'Description',
      'Debit',
      'Credit',
      'Balance',
    ]);
    expect(tabular.rows).toEqual([
      ['', '', 'Opening balance', null, null, '0.00'],
      ['2026-02-01', '42', 'Rent payment', '0.00', '500.00', '500.00'],
      ['', '', 'Closing balance', null, null, '-500.00'],
    ]);
    expect(tabular.title).toBe('General Ledger - 1000 Cash');
  });

  it('falls back to the journal memo when the line has none, and to empty when neither does', () => {
    const withJournalMemo = generalLedgerToTabular({
      ...report,
      entries: [{ ...entry, lineMemo: 'Line-level note' }],
    });
    expect(withJournalMemo.rows[1]?.[2]).toBe('Line-level note');

    const withNeither = generalLedgerToTabular({
      ...report,
      entries: [{ ...entry, journalMemo: null }],
    });
    expect(withNeither.rows[1]?.[2]).toBe('');
  });
});

describe('agingToTabular', () => {
  const report: Aging = {
    asOf: '2026-06-30',
    ledger: 'receivable',
    rows: [
      {
        contactId: 'contact-1',
        contactName: 'Acme Co',
        amounts: { ...ZERO_AMOUNTS, current: '10000', total: '10000' },
        documents: null,
      },
    ],
    totals: { ...ZERO_AMOUNTS, current: '10000', total: '10000' },
  };

  it('flattens one row per contact plus a totals row, seven columns', () => {
    const tabular = agingToTabular(report);

    expect(tabular.columns.map((column) => column.label)).toEqual([
      'Customer',
      'Current',
      '1-30',
      '31-60',
      '61-90',
      '90+',
      'Total',
    ]);
    expect(tabular.rows).toEqual([
      ['Acme Co', '100.00', '0.00', '0.00', '0.00', '0.00', '100.00'],
      ['Total', '100.00', '0.00', '0.00', '0.00', '0.00', '100.00'],
    ]);
    expect(tabular.title).toBe('Accounts Receivable Aging');
  });

  it('titles a payable ledger differently', () => {
    const tabular = agingToTabular({ ...report, ledger: 'payable' });
    expect(tabular.title).toBe('Accounts Payable Aging');
  });
});

describe('cashFlowToTabular', () => {
  const report: StatementOfCashFlows = {
    range: { from: '2026-01-01', to: '2026-03-31' },
    basis: 'accrual',
    netIncome: '150000',
    openingCash: '500000',
    closingCash: '620000',
    netChangeInCash: '120000',
    adjustments: '-30000',
    reconciles: true,
  };

  it('flattens the five named lines', () => {
    const tabular = cashFlowToTabular(report);
    expect(tabular.rows).toEqual([
      ['Net income', '1500.00'],
      ['Adjustments to reconcile net income to net cash', '-300.00'],
      ['Net change in cash', '1200.00'],
      ['Opening cash', '5000.00'],
      ['Closing cash', '6200.00'],
    ]);
  });
});

describe('budgetVsActualToTabular', () => {
  const report: BudgetVsActual = {
    period: { id: 'period-1', name: 'Q1 2026', startDate: '2026-01-01', endDate: '2026-03-31' },
    basis: 'accrual',
    groupBy: null,
    groups: [
      {
        key: null,
        revenue: {
          rows: [
            {
              accountId: 'acc-rev',
              code: '4000',
              name: 'Sales',
              type: 'revenue',
              budget: '250000',
              actual: '200000',
              variance: '-50000',
              variancePercent: -20,
            },
          ],
          budget: '250000',
          actual: '200000',
          variance: '-50000',
        },
        expenses: {
          rows: [],
          budget: '0',
          actual: '0',
          variance: '0',
        },
        netIncome: { budget: '250000', actual: '200000', variance: '-50000' },
      },
    ],
    totals: {
      revenue: { budget: '250000', actual: '200000', variance: '-50000' },
      expenses: { budget: '0', actual: '0', variance: '0' },
      netIncome: { budget: '250000', actual: '200000', variance: '-50000' },
    },
  };

  it('flattens sections with three amounts per row, matching the P&L shape', () => {
    const tabular = budgetVsActualToTabular(report);

    expect(tabular.columns.map((column) => column.label)).toEqual([
      'Account',
      'Budget',
      'Actual',
      'Variance',
    ]);
    expect(tabular.rows).toEqual([
      ['Revenue', null, null, null],
      ['4000 Sales', '2500.00', '2000.00', '-500.00'],
      ['Revenue total', '2500.00', '2000.00', '-500.00'],
      ['Expenses', null, null, null],
      ['Expenses total', '0.00', '0.00', '0.00'],
      ['Net income', '2500.00', '2000.00', '-500.00'],
    ]);
    expect(tabular.subtitle).toBe('Q1 2026 (2026-01-01 to 2026-03-31)');
  });
});
