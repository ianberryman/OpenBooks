import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DocumentList } from './document-list';
import type { ApDocumentSummary } from './ap-document';
import type { ReferenceData } from './queries';

/**
 * The bills/vendor-credits list (OB-069 UI).
 *
 * Two things are under test that the redesign introduced: the **Overdue** pill, which is
 * derived from `dueDate` against `asOf` (a date comparison, not a money figure), and the
 * **compact card stack** below `md`, where the amount label switches between "Total amount"
 * and "Still owed" on what is left. Amounts render as grouped currency throughout.
 */
const viewport = vi.hoisted(() => ({ compact: false }));
vi.mock('../../lib/use-viewport', () => ({ useIsCompact: () => viewport.compact }));

afterEach(() => {
  viewport.compact = false;
});

const VENDOR_ID = '11111111-1111-1111-1111-111111111111';
const AS_OF = '2026-07-31';

const reference = {
  vendorsById: new Map([[VENDOR_ID, { displayName: 'Acme Supplies' }]]),
} as unknown as ReferenceData;

function bill(partial: Partial<ApDocumentSummary>): ApDocumentSummary {
  return {
    id: 'b1',
    documentNumber: '1',
    reference: 'INV-1',
    contactId: VENDOR_ID,
    issueDate: '2026-05-01',
    dueDate: '2026-06-01',
    status: 'approved',
    totals: { net: '62500', tax: '0', gross: '62500' },
    settlement: { allocated: '0', outstanding: '62500' },
    committed: '0',
    ...partial,
  };
}

describe('DocumentList — table', () => {
  it('marks an approved bill past its due date as Overdue, and formats amounts as currency', () => {
    render(
      <DocumentList
        kind="bill"
        items={[bill({})]}
        reference={reference}
        asOf={AS_OF}
        truncated={false}
        onOpen={() => {}}
      />,
    );

    expect(screen.getByText('Overdue')).toBeInTheDocument();
    // Total and Still-owed columns both carry it on an unpaid bill.
    expect(screen.getAllByText('$625.00')).toHaveLength(2);
  });

  it('shows Paid for a settled bill and does not call it overdue', () => {
    render(
      <DocumentList
        kind="bill"
        items={[bill({ status: 'paid', settlement: { allocated: '62500', outstanding: '0' } })]}
        reference={reference}
        asOf={AS_OF}
        truncated={false}
        onOpen={() => {}}
      />,
    );

    expect(screen.getByText('Paid')).toBeInTheDocument();
    expect(screen.queryByText('Overdue')).toBeNull();
  });
});

describe('DocumentList — compact cards', () => {
  it('labels a bill with a balance "Still owed" and opens it on tap', async () => {
    viewport.compact = true;
    const onOpen = vi.fn();
    const user = userEvent.setup();

    render(
      <DocumentList
        kind="bill"
        items={[bill({})]}
        reference={reference}
        asOf={AS_OF}
        truncated={false}
        onOpen={onOpen}
      />,
    );

    expect(screen.getByText('Acme Supplies')).toBeInTheDocument();
    expect(screen.getByText('Still owed')).toBeInTheDocument();
    expect(screen.getByText('$625.00')).toBeInTheDocument();

    await user.click(screen.getByRole('button'));
    expect(onOpen).toHaveBeenCalledWith('b1');
  });

  it('labels a settled bill "Total amount" and shows its total', () => {
    viewport.compact = true;

    render(
      <DocumentList
        kind="bill"
        items={[bill({ status: 'paid', settlement: { allocated: '62500', outstanding: '0' } })]}
        reference={reference}
        asOf={AS_OF}
        truncated={false}
        onOpen={() => {}}
      />,
    );

    expect(screen.getByText('Total amount')).toBeInTheDocument();
    expect(screen.getByText('$625.00')).toBeInTheDocument();
  });
});
