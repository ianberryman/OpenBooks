import type {
  Aging,
  AgingAmounts,
  AgingRow,
  BudgetVsActual,
  BudgetVsActualSection,
  GeneralLedger,
  StatementOfCashFlows,
} from '@openbooks/shared-types';

import type { TrialBalance, TrialBalanceRow } from '../../ledger';
import type { BalanceSheet } from '../balance-sheet.service';
import type { ProfitAndLoss } from '../profit-and-loss.service';

import type { TabularColumn, TabularReport } from './tabular';
import { moneyCell } from './tabular';

/**
 * One flatten function per exportable report (OB-220 part 2). Each reduces its
 * report's own shape — sections, groups, a hierarchy, a keyset-paged list — down
 * to `TabularReport`, which is the one shape `csv.ts` and `xlsx.ts` know about.
 * Every field name below is read from the report's own service/wire type, not
 * guessed — see the type imports.
 */

type TabularRow = (string | number | null)[];

function rangeSubtitle(from: string | null, to: string | null): string {
  if (from === null && to === null) return 'All dates';
  if (from === null) return `Through ${to ?? ''}`;
  if (to === null) return `From ${from} onward`;
  return `${from} to ${to}`;
}

/* ---------------------------------------------------------------------------
 * Trial balance.
 * ------------------------------------------------------------------------- */

export function trialBalanceToTabular(report: TrialBalance): TabularReport {
  const columns: TabularColumn[] = [
    { key: 'code', label: 'Account code' },
    { key: 'name', label: 'Account name' },
    { key: 'debit', label: 'Debit', align: 'right' },
    { key: 'credit', label: 'Credit', align: 'right' },
  ];

  const rows: TabularRow[] = report.rows.map((row: TrialBalanceRow) => [
    row.code,
    row.name,
    moneyCell(row.debits),
    moneyCell(row.credits),
  ]);
  rows.push(['', 'Total', moneyCell(report.totalDebits), moneyCell(report.totalCredits)]);

  return {
    title: 'Trial Balance',
    ...(report.asOf === null ? {} : { subtitle: `As of ${report.asOf}` }),
    columns,
    rows,
  };
}

/* ---------------------------------------------------------------------------
 * Profit and loss / balance sheet share one section-flattening helper: both
 * sections carry `rows: { code, name, amount }[]` and a `total`, only the row's
 * other fields (type, normalBalance, subtotal…) differ, and this adapter uses
 * none of those.
 * ------------------------------------------------------------------------- */

interface AmountSectionLike {
  readonly rows: readonly {
    readonly code: string;
    readonly name: string;
    readonly amount: string;
  }[];
  readonly total: string;
}

function pushAmountSection(rows: TabularRow[], label: string, section: AmountSectionLike): void {
  rows.push([label, null]);
  for (const row of section.rows) {
    rows.push([`${row.code} ${row.name}`, moneyCell(row.amount)]);
  }
  rows.push([`${label} total`, moneyCell(section.total)]);
}

export function profitAndLossToTabular(report: ProfitAndLoss): TabularReport {
  const columns: TabularColumn[] = [
    { key: 'account', label: 'Account' },
    { key: 'amount', label: 'Amount', align: 'right' },
  ];

  const rows: TabularRow[] = [];
  for (const group of report.groups) {
    pushAmountSection(rows, 'Revenue', group.revenue);
    pushAmountSection(rows, 'Expenses', group.expenses);
    rows.push(['Net income', moneyCell(group.netIncome)]);
  }

  return {
    title: 'Profit and Loss',
    subtitle: rangeSubtitle(report.range.from, report.range.to),
    columns,
    rows,
  };
}

export function balanceSheetToTabular(report: BalanceSheet): TabularReport {
  const columns: TabularColumn[] = [
    { key: 'account', label: 'Account' },
    { key: 'amount', label: 'Amount', align: 'right' },
  ];

  const rows: TabularRow[] = [];
  for (const group of report.groups) {
    pushAmountSection(rows, 'Assets', group.assets);
    pushAmountSection(rows, 'Liabilities', group.liabilities);
    pushAmountSection(rows, 'Equity', group.equity);
    rows.push(['Prior year earnings', moneyCell(group.totals.priorYearEarnings)]);
    rows.push(['Current year earnings', moneyCell(group.totals.currentYearEarnings)]);
    rows.push(['Total liabilities and equity', moneyCell(group.totals.liabilitiesAndEquity)]);
  }

  return {
    title: 'Balance Sheet',
    subtitle: `As of ${report.asOf}`,
    columns,
    rows,
  };
}

/* ---------------------------------------------------------------------------
 * General ledger. `export.service.ts` follows `nextCursor` and hands this
 * adapter the whole ledger (every page's `entries` concatenated) under one
 * header, so this function itself does no paging.
 * ------------------------------------------------------------------------- */

export function generalLedgerToTabular(report: GeneralLedger): TabularReport {
  const columns: TabularColumn[] = [
    { key: 'date', label: 'Date' },
    { key: 'journal', label: 'Journal' },
    { key: 'description', label: 'Description' },
    { key: 'debit', label: 'Debit', align: 'right' },
    { key: 'credit', label: 'Credit', align: 'right' },
    { key: 'balance', label: 'Balance', align: 'right' },
  ];

  const rows: TabularRow[] = [
    ['', '', 'Opening balance', null, null, moneyCell(report.opening.balance)],
  ];
  for (const entry of report.entries) {
    rows.push([
      entry.date,
      entry.sequenceNumber,
      entry.lineMemo ?? entry.journalMemo ?? '',
      moneyCell(entry.debit),
      moneyCell(entry.credit),
      moneyCell(entry.runningBalance),
    ]);
  }
  rows.push(['', '', 'Closing balance', null, null, moneyCell(report.closing.balance)]);

  return {
    title: `General Ledger - ${report.code} ${report.name}`,
    subtitle: rangeSubtitle(report.from, report.to),
    columns,
    rows,
  };
}

/* ---------------------------------------------------------------------------
 * Aging.
 * ------------------------------------------------------------------------- */

function amountsRow(label: string, amounts: AgingAmounts): TabularRow {
  return [
    label,
    moneyCell(amounts.current),
    moneyCell(amounts.days1To30),
    moneyCell(amounts.days31To60),
    moneyCell(amounts.days61To90),
    moneyCell(amounts.days90Plus),
    moneyCell(amounts.total),
  ];
}

export function agingToTabular(report: Aging): TabularReport {
  const columns: TabularColumn[] = [
    { key: 'contact', label: 'Customer' },
    { key: 'current', label: 'Current', align: 'right' },
    { key: 'days1To30', label: '1-30', align: 'right' },
    { key: 'days31To60', label: '31-60', align: 'right' },
    { key: 'days61To90', label: '61-90', align: 'right' },
    { key: 'days90Plus', label: '90+', align: 'right' },
    { key: 'total', label: 'Total', align: 'right' },
  ];

  const rows: TabularRow[] = report.rows.map((row: AgingRow) =>
    amountsRow(row.contactName, row.amounts),
  );
  rows.push(amountsRow('Total', report.totals));

  return {
    title: report.ledger === 'receivable' ? 'Accounts Receivable Aging' : 'Accounts Payable Aging',
    subtitle: `As of ${report.asOf}`,
    columns,
    rows,
  };
}

/* ---------------------------------------------------------------------------
 * Statement of cash flows. Five named lines, no hierarchy — see
 * `cash-flow.service.ts` for why there is no categorized operating/investing/
 * financing split for this adapter to flatten.
 * ------------------------------------------------------------------------- */

export function cashFlowToTabular(report: StatementOfCashFlows): TabularReport {
  const columns: TabularColumn[] = [
    { key: 'line', label: 'Line' },
    { key: 'amount', label: 'Amount', align: 'right' },
  ];

  const rows: TabularRow[] = [
    ['Net income', moneyCell(report.netIncome)],
    ['Adjustments to reconcile net income to net cash', moneyCell(report.adjustments)],
    ['Net change in cash', moneyCell(report.netChangeInCash)],
    ['Opening cash', moneyCell(report.openingCash)],
    ['Closing cash', moneyCell(report.closingCash)],
  ];

  return {
    title: 'Statement of Cash Flows',
    subtitle: rangeSubtitle(report.range.from, report.range.to),
    columns,
    rows,
  };
}

/* ---------------------------------------------------------------------------
 * Budget vs actual. Shaped like the P&L (`budgetVsActualSectionSchema` mirrors
 * `profitAndLossSectionSchema`), but each line carries three amounts rather than
 * one, so it gets its own section-pusher rather than reusing `pushAmountSection`.
 * ------------------------------------------------------------------------- */

function pushVarianceSection(
  rows: TabularRow[],
  label: string,
  section: BudgetVsActualSection,
): void {
  rows.push([label, null, null, null]);
  for (const row of section.rows) {
    rows.push([
      `${row.code} ${row.name}`,
      moneyCell(row.budget),
      moneyCell(row.actual),
      moneyCell(row.variance),
    ]);
  }
  rows.push([
    `${label} total`,
    moneyCell(section.budget),
    moneyCell(section.actual),
    moneyCell(section.variance),
  ]);
}

export function budgetVsActualToTabular(report: BudgetVsActual): TabularReport {
  const columns: TabularColumn[] = [
    { key: 'account', label: 'Account' },
    { key: 'budget', label: 'Budget', align: 'right' },
    { key: 'actual', label: 'Actual', align: 'right' },
    { key: 'variance', label: 'Variance', align: 'right' },
  ];

  const rows: TabularRow[] = [];
  for (const group of report.groups) {
    pushVarianceSection(rows, 'Revenue', group.revenue);
    pushVarianceSection(rows, 'Expenses', group.expenses);
    rows.push([
      'Net income',
      moneyCell(group.netIncome.budget),
      moneyCell(group.netIncome.actual),
      moneyCell(group.netIncome.variance),
    ]);
  }

  return {
    title: 'Budget vs Actual',
    subtitle: `${report.period.name} (${report.period.startDate} to ${report.period.endDate})`,
    columns,
    rows,
  };
}
