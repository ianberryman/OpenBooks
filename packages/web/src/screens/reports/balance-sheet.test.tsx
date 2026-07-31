import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { components } from '../../api';
import { BalanceSheetReport } from './balance-sheet';

/**
 * The two derived equity lines (D-20, as corrected by OB-043; acceptance B3).
 *
 * `assets = liabilities + equity + priorYearEarnings + currentYearEarnings`. Neither
 * derived line is an account, and the failure this file guards is a reader taking one for
 * an account: they would go looking for it in the chart, or — worse — assume it duplicates
 * the org's own retained-earnings account, which is an ordinary equity account already
 * counted once inside `equity`.
 *
 * So the assertions are about *where* the two lines are rendered as much as whether they
 * are: outside the equity accounts table, labelled derived, with the fiscal year they were
 * measured over named. That last part matters because forcing the wrong year boundary moves
 * money between the two lines without changing their sum — the sheet still foots, and the
 * window on screen is the only thing that can show it.
 */

type BalanceSheet = components['schemas']['BalanceSheet'];
type BalanceSheetRow = components['schemas']['BalanceSheetRow'];

function row(
  accountId: string,
  code: string,
  name: string,
  type: BalanceSheetRow['type'],
  amount: string,
): BalanceSheetRow {
  return {
    accountId,
    code,
    name,
    type,
    normalBalance: type === 'asset' ? 'debit' : 'credit',
    parentAccountId: null,
    isActive: true,
    amount,
    subtotal: amount,
  };
}

const TOTALS: components['schemas']['BalanceSheetTotals'] = {
  assets: '500000',
  liabilities: '120000',
  equity: '100000',
  priorYearEarnings: '180000',
  currentYearEarnings: '100000',
  liabilitiesAndEquity: '500000',
  difference: '0',
};

const SHEET: BalanceSheet = {
  asOf: '2026-06-30',
  fiscalYear: {
    year: 2026,
    startMonth: 1,
    startDate: '2026-01-01',
    endDate: '2026-12-31',
  },
  basis: 'accrual',
  groupBy: null,
  groups: [
    {
      key: null,
      assets: { rows: [row('cash', '1000', 'Bank', 'asset', '500000')], total: '500000' },
      liabilities: {
        rows: [row('ap', '2000', 'Trade payables', 'liability', '120000')],
        total: '120000',
      },
      equity: {
        rows: [row('retained', '3200', 'Retained earnings', 'equity', '100000')],
        total: '100000',
      },
      totals: TOTALS,
    },
  ],
  totals: TOTALS,
};

function footing(): HTMLElement {
  return screen.getByRole('table', { name: 'Footing' });
}

describe('BalanceSheetReport — the two derived earnings lines', () => {
  it('prints both, and neither is one line', () => {
    render(<BalanceSheetReport report={SHEET} hideZeroRows={false} onDrillThrough={() => {}} />);

    const rows = within(footing()).getAllByRole('rowheader');
    const labels = rows.map((header) => header.textContent ?? '');

    expect(labels.some((label) => label.startsWith('Prior-year earnings'))).toBe(true);
    expect(labels.some((label) => label.startsWith('Current-year earnings'))).toBe(true);
  });

  it('says each is derived and not an account', () => {
    render(<BalanceSheetReport report={SHEET} hideZeroRows={false} onDrillThrough={() => {}} />);

    const prior = within(footing()).getByRole('rowheader', { name: /Prior-year earnings/ });
    const current = within(footing()).getByRole('rowheader', { name: /Current-year earnings/ });

    expect(prior).toHaveTextContent('Derived, not an account');
    expect(current).toHaveTextContent('Derived, not an account');
  });

  /**
   * The fiscal year is a *resolved* value — its start month is a per-org setting (D-17) —
   * so two orgs reading a sheet at the same date measure this line over different windows.
   * A reader who cannot see the window cannot check the number.
   */
  it('names the fiscal year the current-year line was measured over', () => {
    render(<BalanceSheetReport report={SHEET} hideZeroRows={false} onDrillThrough={() => {}} />);

    expect(
      within(footing()).getByRole('rowheader', { name: /Current-year earnings/ }),
    ).toHaveTextContent('fiscal year 2026 (2026-01-01 to 2026-12-31)');
    expect(
      within(footing()).getByRole('rowheader', { name: /Prior-year earnings/ }),
    ).toHaveTextContent('before 2026-01-01');
  });

  /**
   * Not among the accounts. Placing them in the equity table would put two figures that are
   * not accounts in the same columns as the ones that are — and would make that section's
   * own total look as though it had omitted them.
   */
  it('keeps them out of the equity accounts table', () => {
    render(<BalanceSheetReport report={SHEET} hideZeroRows={false} onDrillThrough={() => {}} />);

    const equity = within(screen.getByRole('table', { name: 'Equity' }));
    expect(equity.queryByText(/Current-year earnings/)).toBeNull();
    expect(equity.queryByText(/Prior-year earnings/)).toBeNull();
    // The org's own retained-earnings account is an ordinary equity account, counted once.
    expect(equity.getByRole('rowheader', { name: /Retained earnings/ })).toBeInTheDocument();
    expect(equity.getByRole('rowheader', { name: /Total equity accounts/ })).toBeInTheDocument();
  });

  it('foots on the identity the derived lines exist to make true', () => {
    render(<BalanceSheetReport report={SHEET} hideZeroRows={false} onDrillThrough={() => {}} />);

    function footingAmount(label: RegExp): string {
      const header = within(footing()).getByRole('rowheader', { name: label });
      const line = header.closest('tr');
      if (line === null) throw new Error(`No footing row for ${String(label)}.`);
      return within(line).getAllByRole('cell')[0]?.textContent ?? '';
    }

    // 1200.00 + 1000.00 + 1800.00 + 1000.00 = 5000.00, and assets are 5000.00.
    expect(footingAmount(/^Total liabilities\b(?! and)/)).toBe('$1,200.00');
    expect(footingAmount(/^Total equity accounts/)).toBe('$1,000.00');
    expect(footingAmount(/^Prior-year earnings/)).toBe('$1,800.00');
    expect(footingAmount(/^Current-year earnings/)).toBe('$1,000.00');
    expect(footingAmount(/^Total liabilities and equity/)).toBe('$5,000.00');
    expect(footingAmount(/^Total assets/)).toBe('$5,000.00');
    expect(footingAmount(/^Difference/)).toBe('$0.00');
  });

  /** D-22: the basis is stated, so accrual figures cannot be read under a cash heading. */
  it('states the basis', () => {
    render(<BalanceSheetReport report={SHEET} hideZeroRows={false} onDrillThrough={() => {}} />);

    expect(screen.getByText('Accrual basis')).toBeInTheDocument();
    expect(screen.getByText('As at 2026-06-30')).toBeInTheDocument();
  });
});
