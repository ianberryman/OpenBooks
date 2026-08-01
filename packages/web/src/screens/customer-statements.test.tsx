import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { CustomerStatementsScreen } from './customer-statements';
import type { CustomerStatement } from './customer-statements/queries';

/**
 * The customer statements screen (OB-220 part 1).
 *
 * `./customer-statements/queries` and `./sales/queries` are mocked directly rather than
 * stubbed at the network boundary — this screen owns its data fetching through those two
 * hook modules, so the hooks are the seam, the way `screens/sales/document-list.test.tsx`
 * keeps its subject network-free by mocking at the boundary closest to the component under
 * test (there, props; here, the hook module). Three things are worth asserting: the
 * customer picker offers only contacts flagged `isCustomer` (a vendor must not appear), a
 * generated row renders its pill in the right tone, and the closing balance renders as
 * grouped currency rather than raw minor-unit cents.
 */

const mocks = vi.hoisted(() => ({
  useCustomerStatements: vi.fn(),
  useCreateCustomerStatement: vi.fn(),
  useSalesReferenceData: vi.fn(),
}));

vi.mock('./customer-statements/queries', () => ({
  useCustomerStatements: mocks.useCustomerStatements,
  useCreateCustomerStatement: mocks.useCreateCustomerStatement,
}));

vi.mock('./sales/queries', () => ({
  useSalesReferenceData: mocks.useSalesReferenceData,
}));

const CUSTOMER_ID = '11111111-1111-1111-1111-111111111111';
const VENDOR_ID = '22222222-2222-2222-2222-222222222222';

function statement(partial: Partial<CustomerStatement>): CustomerStatement {
  return {
    id: 'stmt-1',
    contactId: CUSTOMER_ID,
    contactName: 'Jordan Ellis',
    asOf: '2026-07-31',
    status: 'generated',
    recipientEmail: null,
    closingBalanceMinor: '62500',
    downloadUrl: 'https://files.example.test/stmt-1.pdf',
    publicUrl: null,
    generatedByUserId: 'user-1',
    generatedByName: 'Ian Berryman',
    createdAt: '2026-07-31T09:00:00.000Z',
    ...partial,
  };
}

function stubReferenceData(): void {
  mocks.useSalesReferenceData.mockReturnValue({
    data: {
      contacts: [
        { id: CUSTOMER_ID, displayName: 'Jordan Ellis', isCustomer: true },
        { id: VENDOR_ID, displayName: 'Acme Supplies', isCustomer: false },
      ],
    },
    error: null,
    refetch: () => {},
  });
}

function stubCreate(): void {
  mocks.useCreateCustomerStatement.mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  });
}

describe('CustomerStatementsScreen', () => {
  it('offers only customers — not vendors — in the picker', async () => {
    const user = userEvent.setup();
    stubReferenceData();
    stubCreate();
    mocks.useCustomerStatements.mockReturnValue({
      isPending: false,
      isError: false,
      isSuccess: true,
      data: { statements: [] },
      error: null,
      refetch: () => {},
    });

    render(<CustomerStatementsScreen />);

    await user.click(screen.getByRole('combobox'));
    expect(screen.getByRole('option', { name: 'Jordan Ellis' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Acme Supplies' })).toBeNull();
  });

  it('shows the empty state when no statements have been generated', () => {
    stubReferenceData();
    stubCreate();
    mocks.useCustomerStatements.mockReturnValue({
      isPending: false,
      isError: false,
      isSuccess: true,
      data: { statements: [] },
      error: null,
      refetch: () => {},
    });

    render(<CustomerStatementsScreen />);

    expect(screen.getByText(/No statements generated yet/)).toBeInTheDocument();
  });

  it('renders a generated statement row with its pill tone and the balance as currency', () => {
    stubReferenceData();
    stubCreate();
    mocks.useCustomerStatements.mockReturnValue({
      isPending: false,
      isError: false,
      isSuccess: true,
      data: { statements: [statement({})] },
      error: null,
      refetch: () => {},
    });

    render(<CustomerStatementsScreen />);

    expect(screen.getByText('Jordan Ellis')).toBeInTheDocument();
    expect(screen.getByText('$625.00')).toBeInTheDocument();

    const pill = screen.getByText('Generated');
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveClass('bg-surface-sunken');

    const download = screen.getByRole('link', { name: 'Download PDF' });
    expect(download).toHaveAttribute('href', 'https://files.example.test/stmt-1.pdf');
    expect(screen.queryByRole('link', { name: 'Customer link' })).toBeNull();
  });

  it('marks a sent statement with the positive-tone pill and shows the customer link', () => {
    stubReferenceData();
    stubCreate();
    mocks.useCustomerStatements.mockReturnValue({
      isPending: false,
      isError: false,
      isSuccess: true,
      data: {
        statements: [
          statement({
            status: 'sent',
            recipientEmail: 'ap@example.test',
            publicUrl: 'https://openbooks.test/s/stmt-1',
          }),
        ],
      },
      error: null,
      refetch: () => {},
    });

    render(<CustomerStatementsScreen />);

    const pill = screen.getByText('Sent');
    expect(pill).toHaveClass('bg-success-soft');
    expect(screen.getByRole('link', { name: 'Customer link' })).toHaveAttribute(
      'href',
      'https://openbooks.test/s/stmt-1',
    );
  });
});
