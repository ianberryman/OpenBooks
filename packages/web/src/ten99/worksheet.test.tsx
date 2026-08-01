import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import type { Ten99WorksheetRow } from '@openbooks/shared-types';

import { Ten99Worksheet } from './worksheet';

/**
 * The Worksheet tab (OB-228 Wave-1 Stream D).
 *
 * `./queries` is mocked directly, the seam `screens/customer-statements.test.tsx` uses for
 * the same reason: this component owns its own data fetching through that module, so the
 * hooks are the boundary closest to the component under test. `./vendor-tax-profile-dialog`
 * is mocked too, so this file asserts *which* contact the "Edit profile" button opens
 * rather than re-testing the dialog's own form — that is `vendor-tax-profile-dialog.test.tsx`'s
 * job.
 *
 * Three things worth asserting here: paid amounts render as grouped currency (never raw
 * cents), the review pills reflect `meetsThreshold`/`hasTaxId`/`likelyExempt` rather than a
 * client-side recomputation, and "Generate 1099s" is disabled until at least one vendor is
 * over the threshold — the human-review gate D-228-3 exists for.
 */

const mocks = vi.hoisted(() => ({
  useTen99Worksheet: vi.fn(),
  useCreateTen99Run: vi.fn(),
}));

vi.mock('./queries', () => ({
  useTen99Worksheet: mocks.useTen99Worksheet,
  useCreateTen99Run: mocks.useCreateTen99Run,
}));

vi.mock('./vendor-tax-profile-dialog', () => ({
  VendorTaxProfileDialog: ({ contactId }: { readonly contactId: string | null }) => (
    <div data-testid="profile-dialog">{contactId ?? 'closed'}</div>
  ),
}));

function row(partial: Partial<Ten99WorksheetRow>): Ten99WorksheetRow {
  return {
    contactId: 'vendor-1',
    contactName: 'Acme Supplies',
    legalName: 'Acme Supplies LLC',
    taxIdLast4: '1234',
    taxClassification: 'llc',
    defaultForm: '1099_nec',
    defaultBox: 'nec_1',
    paidMinor: '75000',
    meetsThreshold: true,
    hasTaxId: true,
    likelyExempt: false,
    ...partial,
  };
}

function stubCreate(overrides: Partial<ReturnType<typeof mocks.useCreateTen99Run>> = {}): void {
  mocks.useCreateTen99Run.mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
    ...overrides,
  });
}

function renderWorksheet(): void {
  render(
    <MemoryRouter>
      <Ten99Worksheet taxYear={2025} />
    </MemoryRouter>,
  );
}

describe('Ten99Worksheet', () => {
  it('renders a vendor row with grouped currency, a masked TIN and its review pills', () => {
    stubCreate();
    mocks.useTen99Worksheet.mockReturnValue({
      isPending: false,
      isError: false,
      isSuccess: true,
      data: { taxYear: 2025, thresholdMinor: '60000', rows: [row({})] },
      error: null,
      refetch: () => {},
    });

    renderWorksheet();

    expect(screen.getByText('Acme Supplies')).toBeInTheDocument();
    expect(screen.getByText('$750.00')).toBeInTheDocument();
    expect(screen.getByText('••1234')).toBeInTheDocument();
    expect(screen.getByText('Over threshold')).toBeInTheDocument();
    expect(screen.getByText('Has TIN')).toBeInTheDocument();
    expect(screen.queryByText('Likely exempt')).toBeNull();
  });

  it('shows "No TIN" and no last-four when the vendor has none on file', () => {
    stubCreate();
    mocks.useTen99Worksheet.mockReturnValue({
      isPending: false,
      isError: false,
      isSuccess: true,
      data: {
        taxYear: 2025,
        thresholdMinor: '60000',
        rows: [row({ taxIdLast4: null, hasTaxId: false })],
      },
      error: null,
      refetch: () => {},
    });

    renderWorksheet();

    expect(screen.getByText('No TIN')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('disables "Generate 1099s" when no vendor is over the threshold', () => {
    stubCreate();
    mocks.useTen99Worksheet.mockReturnValue({
      isPending: false,
      isError: false,
      isSuccess: true,
      data: {
        taxYear: 2025,
        thresholdMinor: '60000',
        rows: [row({ meetsThreshold: false })],
      },
      error: null,
      refetch: () => {},
    });

    renderWorksheet();

    expect(screen.getByRole('button', { name: 'Generate 1099s' })).toBeDisabled();
  });

  it('enables "Generate 1099s" once a vendor is over the threshold', () => {
    stubCreate();
    mocks.useTen99Worksheet.mockReturnValue({
      isPending: false,
      isError: false,
      isSuccess: true,
      data: { taxYear: 2025, thresholdMinor: '60000', rows: [row({ meetsThreshold: true })] },
      error: null,
      refetch: () => {},
    });

    renderWorksheet();

    expect(screen.getByRole('button', { name: 'Generate 1099s' })).toBeEnabled();
  });

  it('opens the profile dialog for the row whose "Edit profile" was clicked', async () => {
    const user = userEvent.setup();
    stubCreate();
    mocks.useTen99Worksheet.mockReturnValue({
      isPending: false,
      isError: false,
      isSuccess: true,
      data: {
        taxYear: 2025,
        thresholdMinor: '60000',
        rows: [row({ contactId: 'vendor-42', contactName: 'Jordan Ellis' })],
      },
      error: null,
      refetch: () => {},
    });

    renderWorksheet();

    expect(screen.getByTestId('profile-dialog')).toHaveTextContent('closed');
    await user.click(screen.getByRole('button', { name: 'Edit profile' }));
    expect(screen.getByTestId('profile-dialog')).toHaveTextContent('vendor-42');
  });

  it('shows the empty state when no eligible vendor was paid', () => {
    stubCreate();
    mocks.useTen99Worksheet.mockReturnValue({
      isPending: false,
      isError: false,
      isSuccess: true,
      data: { taxYear: 2025, thresholdMinor: '60000', rows: [] },
      error: null,
      refetch: () => {},
    });

    renderWorksheet();

    expect(screen.getByText(/No 1099-eligible vendor was paid in 2025/)).toBeInTheDocument();
  });
});
