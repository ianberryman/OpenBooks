import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { VendorTaxProfile } from '@openbooks/shared-types';

import { VendorTaxProfileDialog } from './vendor-tax-profile-dialog';

/**
 * The vendor 1099 profile dialog (OB-228 Wave-1 Stream D).
 *
 * `./queries` is mocked at the hook boundary, `screens/customer-statements.test.tsx`'s
 * seam. What matters most here is D-228-2: the dialog must never have a full TIN to leak —
 * this suite asserts a stored TIN's last four appears only in the hint text, never in a
 * form field's `value`, and that a blank TIN field on save omits `taxId` entirely rather
 * than sending an empty string that would clear it by accident.
 */

const mocks = vi.hoisted(() => ({
  useVendorTaxProfile: vi.fn(),
  useUpsertVendorTaxProfile: vi.fn(),
}));

vi.mock('./queries', () => ({
  useVendorTaxProfile: mocks.useVendorTaxProfile,
  useUpsertVendorTaxProfile: mocks.useUpsertVendorTaxProfile,
}));

function profile(partial: Partial<VendorTaxProfile>): VendorTaxProfile {
  return {
    contactId: 'vendor-1',
    contactName: 'Acme Supplies',
    isEligible: true,
    taxIdLast4: '1234',
    taxIdType: 'ein',
    taxClassification: 'llc',
    defaultForm: '1099_nec',
    defaultBox: 'nec_1',
    legalName: 'Acme Supplies LLC',
    w9ReceivedOn: '2025-02-01',
    updatedAt: '2025-02-01T00:00:00.000Z',
    ...partial,
  };
}

function stubProfile(data: VendorTaxProfile | undefined): void {
  mocks.useVendorTaxProfile.mockReturnValue({
    isPending: data === undefined,
    isSuccess: data !== undefined,
    data,
    error: null,
    refetch: () => {},
  });
}

function stubUpsert(mutate: (variables: unknown) => void = vi.fn()): void {
  mocks.useUpsertVendorTaxProfile.mockReturnValue({
    mutate,
    isPending: false,
    isError: false,
    error: null,
  });
}

function renderDialog(): void {
  render(
    <VendorTaxProfileDialog contactId="vendor-1" contactName="Acme Supplies" onClose={() => {}} />,
  );
}

describe('VendorTaxProfileDialog', () => {
  it('renders nothing when no contact is being edited', () => {
    stubProfile(undefined);
    stubUpsert();

    render(<VendorTaxProfileDialog contactId={null} contactName="" onClose={() => {}} />);

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it("shows the stored TIN's last four in the hint, never as a field value", async () => {
    stubProfile(profile({}));
    stubUpsert();

    renderDialog();

    const dialog = await screen.findByRole('dialog', { name: /Acme Supplies/ });
    expect(dialog).toHaveTextContent('On file, ending 1234');

    const tinField = screen.getByLabelText<HTMLInputElement>('Taxpayer ID (TIN)');
    expect(tinField.value).toBe('');
    expect(tinField).toHaveAttribute('type', 'password');
  });

  it('omits taxId from the save payload when the field was left blank', async () => {
    const mutate = vi.fn();
    stubProfile(profile({}));
    stubUpsert(mutate);
    const user = userEvent.setup();

    renderDialog();

    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(mutate).toHaveBeenCalledTimes(1);
    const body = mutate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).not.toHaveProperty('taxId');
    expect(body['contactId']).toBe('vendor-1');
    expect(body['isEligible']).toBe(true);
  });

  it('sends taxId: null when "Clear the stored TIN" is checked', async () => {
    const mutate = vi.fn();
    stubProfile(profile({}));
    stubUpsert(mutate);
    const user = userEvent.setup();

    renderDialog();

    await screen.findByRole('dialog');
    await user.click(screen.getByRole('checkbox', { name: 'Clear the stored TIN' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const body = mutate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body['taxId']).toBeNull();
  });

  it('sends a typed replacement TIN as-is', async () => {
    const mutate = vi.fn();
    stubProfile(profile({}));
    stubUpsert(mutate);
    const user = userEvent.setup();

    renderDialog();

    await screen.findByRole('dialog');
    await user.type(screen.getByLabelText('Taxpayer ID (TIN)'), '12-3456789');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const body = mutate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body['taxId']).toBe('12-3456789');
  });

  it('has no "Clear the stored TIN" checkbox for a vendor with no TIN on file', async () => {
    stubProfile(profile({ taxIdLast4: null }));
    stubUpsert();

    renderDialog();

    await screen.findByRole('dialog');
    expect(screen.queryByRole('checkbox', { name: 'Clear the stored TIN' })).toBeNull();
  });
});
