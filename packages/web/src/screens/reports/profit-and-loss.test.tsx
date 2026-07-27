import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { components } from '../../api';
import type { DrillTarget } from './filters';
import { ProfitAndLossReport } from './profit-and-loss';

/**
 * A sliced statement, and the bucket that must never be missing (B6, D-18).
 *
 * "Tagging never moves money": a report sliced by an axis, summed across its groups **plus
 * the unassigned bucket**, equals the same report unsliced. The unassigned bucket is not
 * optional in the UI either — a view that dropped untagged lines would show a smaller
 * business than exists, and it would do it most on the accounts nobody remembered to tag.
 *
 * The other thing asserted here is that nothing re-signs the amounts. The server has
 * already signed each section to its own side, keyed off the account's `type` and never its
 * `normalBalance`, so a contra-revenue account arrives negative and subtracts from revenue
 * as a discount should. A second flip in the renderer would turn that back into an addition
 * and would be invisible on any chart without a contra account.
 */

type ProfitAndLoss = components['schemas']['ProfitAndLoss'];
type ProfitAndLossRow = components['schemas']['ProfitAndLossRow'];

const DEPARTMENT = '11111111-1111-4111-8111-111111111111';

function row(
  accountId: string,
  code: string,
  name: string,
  type: ProfitAndLossRow['type'],
  amount: string,
  normalBalance: ProfitAndLossRow['normalBalance'] = type === 'revenue' ? 'credit' : 'debit',
): ProfitAndLossRow {
  return {
    accountId,
    code,
    name,
    type,
    normalBalance,
    parentAccountId: null,
    isActive: true,
    amount,
    subtotal: amount,
  };
}

interface GroupFixture {
  readonly key: components['schemas']['ReportGroupKey'] | null;
  readonly sales: string;
  readonly discounts: string;
  readonly revenueTotal: string;
  readonly wages: string;
  readonly netIncome: string;
}

function group(fixture: GroupFixture): components['schemas']['ProfitAndLossGroup'] {
  return {
    key: fixture.key,
    revenue: {
      rows: [
        row('sales', '4000', 'Sales', 'revenue', fixture.sales),
        // A contra-revenue account: `revenue` type, `debit` normal balance, negative here.
        row('discounts', '4900', 'Sales discounts', 'revenue', fixture.discounts, 'debit'),
      ],
      total: fixture.revenueTotal,
    },
    expenses: {
      rows: [row('wages', '6000', 'Wages', 'expense', fixture.wages)],
      total: fixture.wages,
    },
    netIncome: fixture.netIncome,
  };
}

const TAGGED = group({
  key: { dimensionValueId: 'sales-dept', code: 'SALES', name: 'Sales team' },
  sales: '300000',
  discounts: '-20000',
  revenueTotal: '280000',
  wages: '100000',
  netIncome: '180000',
});

const UNTAGGED = group({
  key: null,
  sales: '50000',
  discounts: '0',
  revenueTotal: '50000',
  wages: '10000',
  netIncome: '40000',
});

const SLICED: ProfitAndLoss = {
  basis: 'accrual',
  groupBy: DEPARTMENT,
  range: { from: '2026-01-01', to: '2026-03-31' },
  groups: [TAGGED, UNTAGGED],
  totals: { revenue: '330000', expenses: '110000', netIncome: '220000' },
};

describe('ProfitAndLossReport — a sliced statement', () => {
  it('shows the unassigned bucket beside the named ones', () => {
    render(<ProfitAndLossReport report={SLICED} hideZeroRows={false} onDrillThrough={() => {}} />);

    expect(screen.getByRole('heading', { name: 'SALES — Sales team' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Unassigned' })).toBeInTheDocument();
    expect(screen.getByText('lines carrying no value on this axis')).toBeInTheDocument();
  });

  it('prints the cross-slice totals that the groups add back up to', () => {
    render(<ProfitAndLossReport report={SLICED} hideZeroRows={false} onDrillThrough={() => {}} />);

    const totals = within(screen.getByRole('table', { name: /Every slice/ }));
    // 2800.00 tagged + 500.00 untagged = 3300.00, which is the unsliced statement (B6).
    expect(
      within(
        totals.getByRole('rowheader', { name: 'Revenue' }).closest('tr') ?? document.body,
      ).getAllByRole('cell')[0]?.textContent,
    ).toBe('3300.00');
    expect(
      within(
        totals.getByRole('rowheader', { name: 'Net income' }).closest('tr') ?? document.body,
      ).getAllByRole('cell')[0]?.textContent,
    ).toBe('2200.00');
  });

  /**
   * The drill-through from the unassigned bucket, which is the case a list of value ids
   * cannot express: its lines are defined by carrying *no* value on the axis. Hence
   * `includeUnassigned` on the filter, and hence a `null` key travelling with the target.
   */
  it('drills through the unassigned bucket as the unassigned bucket', async () => {
    const user = userEvent.setup();
    const onDrillThrough = vi.fn<(target: DrillTarget) => void>();
    render(
      <ProfitAndLossReport report={SLICED} hideZeroRows={false} onDrillThrough={onDrillThrough} />,
    );

    // The second "Wages" control is the unassigned group's; the first is the Sales team's.
    const wages = screen.getAllByRole('button', { name: 'Wages' });
    await user.click(wages[1] ?? wages[0] ?? document.createElement('button'));

    expect(onDrillThrough).toHaveBeenCalledExactlyOnceWith({
      accountId: 'wages',
      group: { dimensionId: DEPARTMENT, key: null },
    });
  });

  it('drills through a named bucket carrying that bucket’s value', async () => {
    const user = userEvent.setup();
    const onDrillThrough = vi.fn<(target: DrillTarget) => void>();
    render(
      <ProfitAndLossReport report={SLICED} hideZeroRows={false} onDrillThrough={onDrillThrough} />,
    );

    const wages = screen.getAllByRole('button', { name: 'Wages' });
    await user.click(wages[0] ?? document.createElement('button'));

    expect(onDrillThrough).toHaveBeenCalledExactlyOnceWith({
      accountId: 'wages',
      group: {
        dimensionId: DEPARTMENT,
        key: { dimensionValueId: 'sales-dept', code: 'SALES', name: 'Sales team' },
      },
    });
  });
});

describe('ProfitAndLossReport — an unsliced statement', () => {
  const UNSLICED: ProfitAndLoss = {
    basis: 'accrual',
    groupBy: null,
    range: { from: null, to: '2026-03-31' },
    groups: [{ ...TAGGED, key: null }],
    totals: { revenue: '280000', expenses: '100000', netIncome: '180000' },
  };

  it('renders one statement with no bucket heading and no cross-slice block', () => {
    render(
      <ProfitAndLossReport report={UNSLICED} hideZeroRows={false} onDrillThrough={() => {}} />,
    );

    expect(screen.queryByRole('heading', { name: 'Unassigned' })).toBeNull();
    expect(screen.queryByRole('table', { name: /Every slice/ })).toBeNull();
  });

  /** The bounds the server says it applied, not the ones the controls hold. */
  it('reports an absent lower bound as the ledger’s beginning', () => {
    render(
      <ProfitAndLossReport report={UNSLICED} hideZeroRows={false} onDrillThrough={() => {}} />,
    );

    expect(
      screen.getByText('the ledger’s beginning to 2026-03-31, both inclusive'),
    ).toBeInTheDocument();
    expect(screen.getByText('Accrual basis')).toBeInTheDocument();
  });

  it('leaves a contra-revenue account negative rather than flipping it a second time', () => {
    render(
      <ProfitAndLossReport report={UNSLICED} hideZeroRows={false} onDrillThrough={() => {}} />,
    );

    const line = screen.getByRole('rowheader', { name: /Sales discounts/ }).closest('tr');
    expect(within(line ?? document.body).getAllByRole('cell')[0]?.textContent).toBe('-200.00');
  });
});
