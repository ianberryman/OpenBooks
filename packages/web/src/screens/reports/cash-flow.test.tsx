import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { components } from '../../api';
import { CashFlowReport } from './cash-flow';

/**
 * The Statement of Cash Flows (OB-157; D-88).
 *
 * Unlike the other three viewers, there is no per-account section here to check the
 * hierarchy of — the server already reduced the period to three reconciled figures,
 * and this file's job is to check they print under the right labels and that the
 * `reconciles` flag is read rather than assumed.
 */

type StatementOfCashFlows = components['schemas']['StatementOfCashFlows'];

const REPORT: StatementOfCashFlows = {
  range: { from: '2026-01-01', to: '2026-03-31' },
  basis: 'accrual',
  netIncome: '400000',
  openingCash: '100000',
  closingCash: '460000',
  netChangeInCash: '360000',
  adjustments: '-40000',
  reconciles: true,
};

function cashFlowTable(): HTMLElement {
  return screen.getByRole('table', { name: 'Cash flow' });
}

describe('CashFlowReport', () => {
  it('prints net income, the reconciling adjustments, and the change in cash', () => {
    render(<CashFlowReport report={REPORT} />);

    const table = within(cashFlowTable());
    expect(
      within(
        table.getByRole('rowheader', { name: 'Net income' }).closest('tr') ?? document.body,
      ).getAllByRole('cell')[0]?.textContent,
    ).toBe('4000.00');
    expect(
      within(
        table.getByRole('rowheader', { name: /Adjustments to reconcile/ }).closest('tr') ??
          document.body,
      ).getAllByRole('cell')[0]?.textContent,
    ).toBe('-400.00');
    expect(
      within(
        table.getByRole('rowheader', { name: 'Net change in cash' }).closest('tr') ?? document.body,
      ).getAllByRole('cell')[0]?.textContent,
    ).toBe('3600.00');
  });

  it('foots opening cash plus the change in cash to closing cash', () => {
    render(<CashFlowReport report={REPORT} />);

    const table = within(cashFlowTable());
    // 1000.00 + 3600.00 = 4600.00.
    expect(
      within(
        table.getByRole('rowheader', { name: 'Cash at start of period' }).closest('tr') ??
          document.body,
      ).getAllByRole('cell')[0]?.textContent,
    ).toBe('1000.00');
    expect(
      within(
        table.getByRole('rowheader', { name: 'Cash at end of period' }).closest('tr') ??
          document.body,
      ).getAllByRole('cell')[0]?.textContent,
    ).toBe('4600.00');
  });

  it('states the basis and the applied range', () => {
    render(<CashFlowReport report={REPORT} />);

    expect(screen.getByText('Accrual basis')).toBeInTheDocument();
    expect(screen.getByText('2026-01-01 to 2026-03-31, both inclusive')).toBeInTheDocument();
  });

  it('reports a reconciled statement without a warning', () => {
    render(<CashFlowReport report={REPORT} />);

    expect(screen.getByText(/Net income plus adjustments equals/)).toBeInTheDocument();
    expect(screen.queryByText(/does not hold/)).toBeNull();
  });

  /**
   * `reconciles` is true by construction on the server — `adjustments` is defined as the
   * figure that makes it true — so a `false` here means the arithmetic broke, and the
   * screen says so rather than silently printing three figures that do not tie.
   */
  it('warns when the server reports a broken reconciliation', () => {
    render(<CashFlowReport report={{ ...REPORT, reconciles: false }} />);

    expect(screen.getByText(/does not hold/)).toBeInTheDocument();
  });
});
