import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DocumentList } from './document-list';
import type { CreditNoteSummary, InvoiceSummary, SalesReferenceData } from './queries';

/**
 * The invoices/credit-notes list (OB-069 UI).
 *
 * Three things are under test that the redesign introduced: the **Overdue** pill, derived
 * from `dueDate` against `asOf` (a date comparison, not a money figure); the **Unpaid**
 * pill (`accent` tone) for an owing document that has not yet slipped past its due date
 * (D-34's "approved"/"part_paid" — the mockup labels both "UNPAID"); and the **compact
 * card stack** below `md`, where the labels switch on whether anything is still owed.
 * Amounts render as grouped currency throughout.
 */
const viewport = vi.hoisted(() => ({ compact: false }));
vi.mock('../../lib/use-viewport', () => ({ useIsCompact: () => viewport.compact }));

afterEach(() => {
  viewport.compact = false;
});

const CUSTOMER_ID = '11111111-1111-1111-1111-111111111111';
const AS_OF = '2026-07-31';

const reference = {
  contactsById: new Map([[CUSTOMER_ID, { displayName: 'Jordan Ellis' }]]),
} as unknown as SalesReferenceData;

function invoice(partial: Partial<InvoiceSummary>): InvoiceSummary {
  return {
    id: 'inv-1',
    documentNumber: 'INV-0001',
    reference: null,
    contactId: CUSTOMER_ID,
    issueDate: '2026-05-01',
    dueDate: '2026-06-01',
    status: 'approved',
    totals: { net: '62500', tax: '0', gross: '62500' },
    settlement: { allocated: '0', outstanding: '62500' },
    createdAt: '2026-05-01T09:00:00.000Z',
    updatedAt: '2026-05-01T09:00:00.000Z',
    ...partial,
  };
}

function creditNote(partial: Partial<CreditNoteSummary>): CreditNoteSummary {
  return {
    id: 'cn-1',
    documentNumber: 'CN-0001',
    reference: null,
    contactId: CUSTOMER_ID,
    issueDate: '2026-05-01',
    status: 'approved',
    totals: { net: '10000', tax: '0', gross: '10000' },
    settlement: { allocated: '0', outstanding: '10000' },
    createdAt: '2026-05-01T09:00:00.000Z',
    updatedAt: '2026-05-01T09:00:00.000Z',
    ...partial,
  };
}

describe('DocumentList — table', () => {
  it('marks an approved invoice past its due date as Overdue, and formats amounts as currency', () => {
    render(
      <DocumentList
        kind="invoice"
        documents={[invoice({})]}
        reference={reference}
        asOf={AS_OF}
        truncated={false}
        onOpen={() => {}}
      />,
    );

    expect(screen.getByText('Overdue')).toBeInTheDocument();
    // Total and Still-owed columns both carry it on an unpaid, overdue invoice.
    expect(screen.getAllByText('$625.00')).toHaveLength(2);
  });

  it('labels an owing invoice not yet past its due date as Unpaid, in the accent tone', () => {
    render(
      <DocumentList
        kind="invoice"
        documents={[invoice({ dueDate: '2026-08-15' })]}
        reference={reference}
        asOf={AS_OF}
        truncated={false}
        onOpen={() => {}}
      />,
    );

    const pill = screen.getByText('Unpaid');
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveClass('bg-accent-soft');
    expect(screen.queryByText('Overdue')).toBeNull();
  });

  it('labels a part-paid invoice past its due date Overdue rather than Unpaid', () => {
    render(
      <DocumentList
        kind="invoice"
        documents={[
          invoice({
            status: 'part_paid',
            settlement: { allocated: '20000', outstanding: '42500' },
          }),
        ]}
        reference={reference}
        asOf={AS_OF}
        truncated={false}
        onOpen={() => {}}
      />,
    );

    expect(screen.getByText('Overdue')).toBeInTheDocument();
    expect(screen.queryByText('Unpaid')).toBeNull();
  });

  it('shows Paid for a settled invoice and does not call it overdue', () => {
    render(
      <DocumentList
        kind="invoice"
        documents={[
          invoice({ status: 'paid', settlement: { allocated: '62500', outstanding: '0' } }),
        ]}
        reference={reference}
        asOf={AS_OF}
        truncated={false}
        onOpen={() => {}}
      />,
    );

    expect(screen.getByText('Paid')).toBeInTheDocument();
    expect(screen.queryByText('Overdue')).toBeNull();
  });

  it('opens the invoice, by row, on click of its number', async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();

    render(
      <DocumentList
        kind="invoice"
        documents={[invoice({})]}
        reference={reference}
        asOf={AS_OF}
        truncated={false}
        onOpen={onOpen}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'INV-0001' }));
    expect(onOpen).toHaveBeenCalledWith('inv-1');
  });

  it('shows the empty state when there are no documents', () => {
    render(
      <DocumentList
        kind="invoice"
        documents={[]}
        reference={reference}
        asOf={AS_OF}
        truncated={false}
        onOpen={() => {}}
      />,
    );

    expect(screen.getByText(/No invoices yet/)).toBeInTheDocument();
  });

  it('adds the first-page note when the page is truncated', () => {
    render(
      <DocumentList
        kind="invoice"
        documents={[invoice({})]}
        reference={reference}
        asOf={AS_OF}
        truncated
        onOpen={() => {}}
      />,
    );

    expect(screen.getByText(/Showing the first page/)).toBeInTheDocument();
  });

  it('has no Due column on the credit-note tab', () => {
    render(
      <DocumentList
        kind="credit_note"
        documents={[creditNote({})]}
        reference={reference}
        asOf={AS_OF}
        truncated={false}
        onOpen={() => {}}
      />,
    );

    expect(screen.queryByRole('columnheader', { name: 'Due' })).not.toBeInTheDocument();
  });
});

describe('DocumentList — compact cards', () => {
  it('labels an owing invoice "Due date" / "Still owed", and opens it on tap', async () => {
    viewport.compact = true;
    const onOpen = vi.fn();
    const user = userEvent.setup();

    render(
      <DocumentList
        kind="invoice"
        documents={[invoice({})]}
        reference={reference}
        asOf={AS_OF}
        truncated={false}
        onOpen={onOpen}
      />,
    );

    expect(screen.getByText('Jordan Ellis')).toBeInTheDocument();
    expect(screen.getByText('Due date')).toBeInTheDocument();
    expect(screen.getByText('Still owed')).toBeInTheDocument();
    expect(screen.getByText('$625.00')).toBeInTheDocument();

    await user.click(screen.getByRole('button'));
    expect(onOpen).toHaveBeenCalledWith('inv-1');
  });

  it('labels a settled invoice "Issued" / "Total amount", in the success tone', () => {
    viewport.compact = true;

    render(
      <DocumentList
        kind="invoice"
        documents={[
          invoice({ status: 'paid', settlement: { allocated: '62500', outstanding: '0' } }),
        ]}
        reference={reference}
        asOf={AS_OF}
        truncated={false}
        onOpen={() => {}}
      />,
    );

    expect(screen.getByText('Issued')).toBeInTheDocument();
    expect(screen.getByText('Total amount')).toBeInTheDocument();
    const amount = screen.getByText('$625.00');
    expect(amount).toHaveClass('text-success-text');
  });

  it('colors an overdue amount red', () => {
    viewport.compact = true;

    render(
      <DocumentList
        kind="invoice"
        documents={[invoice({})]}
        reference={reference}
        asOf={AS_OF}
        truncated={false}
        onOpen={() => {}}
      />,
    );

    const amount = screen.getByText('$625.00');
    expect(amount).toHaveClass('text-danger-text');
  });
});
