import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { PaymentHistory } from './payment-history';
import type { Allocation, DocumentSettlement } from './queries';

/** The pending row is a `Link` (to `/disbursements`), so every render needs a router. */
function renderHistory(ui: ReactElement): void {
  render(<MemoryRouter>{ui}</MemoryRouter>);
}

/**
 * The settlement summary bar + applied-allocations list a bill or vendor credit's VIEW
 * state shows. Everything under test is read straight off the props — the point of this
 * component is that it computes nothing (see `payment-history.tsx`'s header comment).
 */
function allocation(partial: Partial<Allocation>): Allocation {
  return {
    id: 'a1',
    sourceType: 'payment',
    sourceId: 's1',
    sourceNumber: null,
    targetType: 'bill',
    targetId: 't1',
    targetNumber: 'BILL-1',
    amount: '10000',
    date: '2026-07-01',
    createdAt: '2026-07-01T00:00:00.000Z',
    ...partial,
  } as unknown as Allocation;
}

const settlement: DocumentSettlement = { allocated: '15000', outstanding: '47500' };

describe('PaymentHistory', () => {
  it('shows the three summary figures as grouped currency, and a label per allocation', () => {
    renderHistory(
      <PaymentHistory
        kind="bill"
        allocations={[
          allocation({ id: 'a1', sourceType: 'payment', amount: '10000' }),
          allocation({
            id: 'a2',
            sourceType: 'discount',
            sourceNumber: null,
            amount: '5000',
            date: '2026-07-05',
          }),
        ]}
        settlement={settlement}
        totalGross="62500"
      />,
    );

    expect(screen.getByText('Payment history')).toBeInTheDocument();
    expect(screen.getByText('$625.00')).toBeInTheDocument(); // total amount
    expect(screen.getByText('$150.00')).toBeInTheDocument(); // applied
    expect(screen.getByText('$475.00')).toBeInTheDocument(); // still owed

    expect(screen.getByText('Payment applied')).toBeInTheDocument();
    expect(screen.getByText('Discount taken')).toBeInTheDocument();
    expect(screen.getByText('$100.00')).toBeInTheDocument();
    expect(screen.getByText('$50.00')).toBeInTheDocument();
  });

  it('shows the empty line but keeps the summary bar when nothing has been applied', () => {
    renderHistory(
      <PaymentHistory
        kind="bill"
        allocations={[]}
        settlement={{ allocated: '0', outstanding: '62500' }}
        totalGross="62500"
      />,
    );

    expect(screen.getByText('Nothing has been applied yet.')).toBeInTheDocument();
    expect(screen.getAllByText('$625.00')).toHaveLength(2); // total amount + still owed
    expect(screen.getByText('$0.00')).toBeInTheDocument(); // applied
  });

  it('lists a pending payment as its own "Pending" entry, even with nothing applied yet', () => {
    renderHistory(
      <PaymentHistory
        kind="bill"
        allocations={[]}
        settlement={{ allocated: '0', outstanding: '62500' }}
        totalGross="62500"
        pendingCommitted="30000"
      />,
    );

    // The pending intent shows as an entry (not the empty state), marked "Pending",
    // and links to disbursements — the payment is built and only needs issuing.
    expect(screen.queryByText('Nothing has been applied yet.')).toBeNull();
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.getByText('$300.00')).toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute('href', '/disbursements');
  });

  it('renders no pending entry when there is nothing committed', () => {
    renderHistory(
      <PaymentHistory
        kind="bill"
        allocations={[allocation({ amount: '10000' })]}
        settlement={settlement}
        totalGross="62500"
        pendingCommitted="0"
      />,
    );

    expect(screen.queryByText('Pending')).toBeNull();
  });

  it('softens the heading to "Applied" for a vendor credit', () => {
    renderHistory(
      <PaymentHistory
        kind="vendor_credit"
        allocations={[]}
        settlement={{ allocated: '0', outstanding: '0' }}
        totalGross="0"
      />,
    );

    // The heading and the "Applied" summary figure's label read the same word by design
    // (both are correct for a vendor credit) — two matches rather than one confirms the
    // heading rendered "Applied" and not "Payment history".
    expect(screen.getAllByText('Applied')).toHaveLength(2);
    expect(screen.queryByText('Payment history')).toBeNull();
  });
});
