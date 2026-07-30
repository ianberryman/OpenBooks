import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { components } from '../../api';
import { BudgetVsActualReport } from './budget-vs-actual';

/**
 * The pure render component, worked from a canned response — the fetching half and the
 * period picker are `useQuery`/`Select` plumbing identical to every other viewer in this
 * directory. What is worth asserting here: the unassigned bucket is never dropped from a
 * sliced report (B6, D-18, matching `profit-and-loss.test.tsx`), nothing re-derives a
 * variance the server already computed, and a null `variancePercent` — a zero budget —
 * prints as a dash rather than a claimed 0%.
 */

type BudgetVsActual = components['schemas']['BudgetVsActual'];
type BudgetVsActualRow = components['schemas']['BudgetVsActualRow'];

const DEPARTMENT = '11111111-1111-4111-8111-111111111111';

function row(
  accountId: string,
  code: string,
  name: string,
  type: BudgetVsActualRow['type'],
  budget: string,
  actual: string,
  variance: string,
  variancePercent: number | null,
): BudgetVsActualRow {
  return { accountId, code, name, type, budget, actual, variance, variancePercent };
}

const TAGGED: components['schemas']['BudgetVsActualGroup'] = {
  key: { dimensionValueId: 'sales-dept', code: 'SALES', name: 'Sales team' },
  revenue: {
    rows: [row('sales', '4000', 'Sales', 'revenue', '300000', '280000', '-20000', -6.7)],
    budget: '300000',
    actual: '280000',
    variance: '-20000',
  },
  expenses: {
    rows: [row('wages', '6000', 'Wages', 'expense', '100000', '90000', '10000', 10)],
    budget: '100000',
    actual: '90000',
    variance: '10000',
  },
  netIncome: { budget: '200000', actual: '190000', variance: '-10000' },
};

const UNTAGGED: components['schemas']['BudgetVsActualGroup'] = {
  key: null,
  revenue: {
    rows: [row('other-sales', '4001', 'Other sales', 'revenue', '0', '0', '0', null)],
    budget: '0',
    actual: '0',
    variance: '0',
  },
  expenses: { rows: [], budget: '0', actual: '0', variance: '0' },
  netIncome: { budget: '0', actual: '0', variance: '0' },
};

const SLICED: BudgetVsActual = {
  basis: 'accrual',
  groupBy: DEPARTMENT,
  period: { id: 'period-1', name: '2026-03', startDate: '2026-03-01', endDate: '2026-03-31' },
  groups: [TAGGED, UNTAGGED],
  totals: {
    revenue: { budget: '300000', actual: '280000', variance: '-20000' },
    expenses: { budget: '100000', actual: '90000', variance: '10000' },
    netIncome: { budget: '200000', actual: '190000', variance: '-10000' },
  },
};

describe('BudgetVsActualReport — a sliced statement', () => {
  it('shows the unassigned bucket beside the named ones', () => {
    render(<BudgetVsActualReport report={SLICED} hideZeroRows={false} />);

    expect(screen.getByRole('heading', { name: 'SALES — Sales team' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Unassigned' })).toBeInTheDocument();
  });

  it('prints the cross-slice totals under their own table, unedited', () => {
    render(<BudgetVsActualReport report={SLICED} hideZeroRows={false} />);

    const totals = within(screen.getByRole('table', { name: /Every slice/ }));
    expect(
      within(
        totals.getByRole('rowheader', { name: 'Net income' }).closest('tr') ?? document.body,
      ).getAllByRole('cell')[2]?.textContent,
    ).toBe('-100.00');
  });

  it('prints the variance percent with a sign, and a dash for a null percent', () => {
    render(<BudgetVsActualReport report={SLICED} hideZeroRows={false} />);

    expect(screen.getByText('-6.7%')).toBeInTheDocument();
    expect(screen.getByText('+10.0%')).toBeInTheDocument();

    const otherSales = screen.getByRole('rowheader', { name: /Other sales/ }).closest('tr');
    expect(within(otherSales ?? document.body).getAllByRole('cell')).toHaveLength(4);
    expect(within(otherSales ?? document.body).getAllByText('—').length).toBeGreaterThan(0);
  });
});

describe('BudgetVsActualReport — an unsliced statement', () => {
  const UNSLICED: BudgetVsActual = {
    basis: 'accrual',
    groupBy: null,
    period: { id: 'period-1', name: '2026-03', startDate: '2026-03-01', endDate: '2026-03-31' },
    groups: [{ ...TAGGED, key: null }],
    totals: {
      revenue: { budget: '300000', actual: '280000', variance: '-20000' },
      expenses: { budget: '100000', actual: '90000', variance: '10000' },
      netIncome: { budget: '200000', actual: '190000', variance: '-10000' },
    },
  };

  it('renders one statement with no bucket heading and no cross-slice block', () => {
    render(<BudgetVsActualReport report={UNSLICED} hideZeroRows={false} />);

    expect(screen.queryByRole('heading', { name: 'Unassigned' })).toBeNull();
    expect(screen.queryByRole('table', { name: /Every slice/ })).toBeNull();
  });

  it('states the period name and its date span', () => {
    render(<BudgetVsActualReport report={UNSLICED} hideZeroRows={false} />);

    expect(
      screen.getByText('2026-03 — 2026-03-01 to 2026-03-31, both inclusive'),
    ).toBeInTheDocument();
    expect(screen.getByText('Accrual basis')).toBeInTheDocument();
  });

  const withZeroRow: BudgetVsActual = {
    ...UNSLICED,
    groups: [
      {
        ...TAGGED,
        key: null,
        expenses: {
          ...TAGGED.expenses,
          rows: [
            ...TAGGED.expenses.rows,
            row('rent', '6100', 'Rent', 'expense', '0', '0', '0', null),
          ],
        },
      },
    ],
  };

  it('shows a row standing at zero by default — the server sends it on purpose', () => {
    render(<BudgetVsActualReport report={withZeroRow} hideZeroRows={false} />);
    expect(screen.getByRole('rowheader', { name: /Rent/ })).toBeInTheDocument();
  });

  it('hides a row standing at zero on both budget and actual when asked', () => {
    render(<BudgetVsActualReport report={withZeroRow} hideZeroRows={true} />);
    expect(screen.queryByRole('rowheader', { name: /Rent/ })).toBeNull();
  });
});
