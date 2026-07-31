import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ApDocument } from './ap-document';
import { MobileDocumentView } from './mobile-document-view';

/**
 * The compact read-only VIEW of an approved bill/vendor credit. Everything under test is
 * read straight off `document` — see `mobile-document-view.tsx`'s header comment for why
 * nothing here is recomputed.
 */
function document(partial: Partial<ApDocument> = {}): ApDocument {
  return {
    id: 'd1',
    documentNumber: '42',
    reference: 'INV-9001',
    contactId: 'c1',
    issueDate: '2026-07-01',
    dueDate: '2026-07-15',
    taxMode: 'exclusive',
    status: 'approved',
    memo: null,
    lines: [
      {
        lineId: 'l1',
        lineNumber: 1,
        description: 'Widgets',
        quantity: '2',
        unitAmount: '5000',
        netAmount: '10000',
        taxAmount: '1000',
        grossAmount: '11000',
        taxRateId: 'tr1',
        taxRatePercentage: '10',
        accountId: 'a1',
        catalogItemId: null,
        dimensionValueIds: [],
      },
    ],
    totals: { net: '10000', tax: '1000', gross: '11000' },
    taxSummary: [{ taxRateId: 'tr1', taxRateName: 'GST', percentage: '10', tax: '1000' }],
    settlement: { allocated: '0', outstanding: '11000' },
    allocations: [],
    journalId: 'j1',
    voidJournalId: null,
    ...partial,
  } as unknown as ApDocument;
}

describe('MobileDocumentView', () => {
  it('renders the document number, status, a line and the total', () => {
    render(
      <MobileDocumentView
        kind="bill"
        document={document()}
        vendorName="Acme Supplies"
        vendorLocation="Seattle, WA, US"
        pastDue={false}
        actions={<button type="button">Print</button>}
        onBack={() => {}}
      />,
    );

    expect(screen.getByText('#42')).toBeInTheDocument();
    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.getByText('Widgets')).toBeInTheDocument();
    // The line gross, the document total and the still-outstanding figure all agree on this
    // single-line, unpaid fixture, and `PaymentHistory` repeats a couple of them in its own
    // summary bar — assert the grouped-currency string rendered at all rather than pin an
    // exact count that would break the moment either card's copy changes.
    expect(screen.getAllByText('$110.00').length).toBeGreaterThan(0);
    expect(screen.getByText('Acme Supplies')).toBeInTheDocument();
    expect(screen.getByText('Seattle, WA, US')).toBeInTheDocument();
  });

  it('omits the vendor location line when it is empty', () => {
    render(
      <MobileDocumentView
        kind="bill"
        document={document()}
        vendorName="Acme Supplies"
        vendorLocation=""
        pastDue={false}
        actions={null}
        onBack={() => {}}
      />,
    );

    expect(screen.queryByText(/Seattle/)).toBeNull();
  });
});
