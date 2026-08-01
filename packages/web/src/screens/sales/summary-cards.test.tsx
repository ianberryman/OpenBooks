import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { InvoicesSummaryCards } from './summary-cards';
import type { InvoiceCardFilter } from './invoice-list';
import type { InvoicesSummary, InvoicesSummaryResult } from './queries';

/**
 * The invoices-list summary cards (OB-069 UI).
 *
 * The figures are the server's, so nothing here checks arithmetic — what is answerable in
 * jsdom is that the three cards render the amounts the endpoint returned as currency, that
 * the loading and error states stand in without throwing, and that each card toggles its
 * filter and reflects the active one in its pressed state.
 */
const DATA: InvoicesSummary = {
  asOf: '2026-07-31',
  totalUnpaid: '34378',
  openCount: 3,
  totalOverdue: '112500',
  overdueCount: 2,
  paidLast30Days: '250000',
};

function result(partial: Partial<InvoicesSummaryResult>): InvoicesSummaryResult {
  return { data: null, error: null, refetch: () => {}, ...partial };
}

function cards(
  partial: Partial<InvoicesSummaryResult>,
  props?: {
    activeFilter?: InvoiceCardFilter | null;
    onSelectFilter?: (filter: InvoiceCardFilter) => void;
  },
) {
  return (
    <InvoicesSummaryCards
      summary={result(partial)}
      activeFilter={props?.activeFilter ?? null}
      onSelectFilter={props?.onSelectFilter ?? (() => {})}
    />
  );
}

describe('InvoicesSummaryCards', () => {
  it('renders the three figures as grouped currency', () => {
    render(cards({ data: DATA }));

    expect(screen.getByText('$343.78')).toBeInTheDocument();
    expect(screen.getByText('$1,125.00')).toBeInTheDocument();
    expect(screen.getByText('$2,500.00')).toBeInTheDocument();
    expect(screen.getByText('Across 3 open invoices')).toBeInTheDocument();
    expect(screen.getByText('2 overdue')).toBeInTheDocument();
  });

  it('singularises the open-invoice count', () => {
    render(cards({ data: { ...DATA, openCount: 1 } }));

    expect(screen.getByText('Across 1 open invoice')).toBeInTheDocument();
  });

  it('shows a placeholder rather than a figure while loading', () => {
    render(cards({ data: null }));

    expect(screen.getByText('Total unpaid')).toBeInTheDocument();
    expect(screen.queryByText(/\$/)).toBeNull();
  });

  it('surfaces an error instead of the cards', () => {
    render(cards({ error: new Error('boom') }));

    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('shows a danger tone amount when something is overdue', () => {
    render(cards({ data: DATA }));

    const overdueAmount = screen.getByText('$1,125.00');
    expect(overdueAmount).toHaveClass('text-danger-text');
  });

  it('reports the card tapped as a filter', async () => {
    const onSelectFilter = vi.fn();
    const user = userEvent.setup();
    render(cards({ data: DATA }, { onSelectFilter }));

    await user.click(screen.getByRole('button', { name: /Total overdue/ }));
    expect(onSelectFilter).toHaveBeenCalledWith('overdue');
  });

  it('marks the active card pressed and leaves the others unpressed', () => {
    render(cards({ data: DATA }, { activeFilter: 'unpaid' }));

    expect(screen.getByRole('button', { name: /Total unpaid/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: /Total overdue/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });
});
