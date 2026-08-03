import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ContactFormDialog } from './contact-form';
import type { Contact } from './queries';

/**
 * The "1099 reporting" section on the contact form (OB-253).
 *
 * `./queries` is mocked at the hook boundary, `vendor-tax-profile-dialog.test.tsx`'s and
 * `customer-statements.test.tsx`'s seam — this suite never submits the form, so the
 * mutation hooks only need to exist, not to do anything. `./vendor-tax-profile-dialog` is
 * mocked too, `worksheet.test.tsx`'s pattern: what matters here is *whether* the section
 * and the button appear and *which* contact id the dialog is opened with, not the dialog's
 * own form — that belongs to `vendor-tax-profile-dialog.test.tsx`.
 */

const mocks = vi.hoisted(() => ({
  useCreateContact: vi.fn(),
  useUpdateContact: vi.fn(),
  useIntentKey: vi.fn(),
}));

vi.mock('./queries', () => ({
  useCreateContact: mocks.useCreateContact,
  useUpdateContact: mocks.useUpdateContact,
  useIntentKey: mocks.useIntentKey,
}));

vi.mock('../../ten99/vendor-tax-profile-dialog', () => ({
  VendorTaxProfileDialog: ({ contactId }: { readonly contactId: string | null }) =>
    contactId !== null ? <div data-testid="ten99-dialog">{contactId}</div> : null,
}));

function contact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    code: null,
    displayName: 'Jordan Ellis',
    legalName: null,
    email: null,
    phone: null,
    isCustomer: false,
    isVendor: false,
    isEmployee: false,
    notes: null,
    addressLine1: null,
    addressLine2: null,
    city: null,
    region: null,
    postalCode: null,
    country: null,
    isActive: true,
    createdAt: '2026-01-05T09:00:00.000Z',
    updatedAt: '2026-01-05T09:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  mocks.useCreateContact.mockReturnValue({ mutate: vi.fn(), isPending: false, error: null });
  mocks.useUpdateContact.mockReturnValue({ mutate: vi.fn(), isPending: false, error: null });
  mocks.useIntentKey.mockReturnValue((intent: string) => `key:${intent}`);
});

describe('ContactFormDialog — 1099 reporting section', () => {
  it('offers "Set up 1099 profile" for an existing vendor, and opens the dialog for that contact', async () => {
    const user = userEvent.setup();
    const vendor = contact({ isVendor: true, displayName: 'Acme Supplies' });

    render(<ContactFormDialog contact={vendor} open={true} onOpenChange={() => {}} />);

    const form = await screen.findByRole('dialog', { name: 'Edit contact' });
    const button = screen.getByRole('button', { name: 'Set up 1099 profile' });
    expect(form).toContainElement(button);
    expect(screen.queryByTestId('ten99-dialog')).toBeNull();

    await user.click(button);

    expect(screen.getByTestId('ten99-dialog')).toHaveTextContent(vendor.id);
  });

  it('shows neither the section nor the button for an existing non-vendor', async () => {
    const nonVendor = contact({ isVendor: false });

    render(<ContactFormDialog contact={nonVendor} open={true} onOpenChange={() => {}} />);

    await screen.findByRole('dialog', { name: 'Edit contact' });
    expect(screen.queryByText('1099 reporting')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Set up 1099 profile' })).toBeNull();
  });

  it('hints to save first, with no button, when creating a new vendor', async () => {
    render(
      <ContactFormDialog
        contact={null}
        open={true}
        onOpenChange={() => {}}
        initialIsVendor={true}
      />,
    );

    await screen.findByRole('dialog', { name: 'New contact' });
    expect(screen.getByText(/Save this vendor first/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Set up 1099 profile' })).toBeNull();
  });
});
