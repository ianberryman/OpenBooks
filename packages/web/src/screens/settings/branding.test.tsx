import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { StubRoute } from './test-support';
import { installApiStub, renderWithQueryClient } from './test-support';

/**
 * Branding (OB-131, Phase 1, S4).
 *
 * One property is worth a test and it is the patch semantics: `updateOrgBrandingRequestSchema`
 * says an absent field is left alone and an explicit `null` clears a nullable one, and a
 * screen that sent every field on every save — or sent `''` for a field the user cleared —
 * would be publishing a different contract than the one the server enforces. The second test
 * checks the form pre-fills from `GET /v1/branding` rather than rendering blank fields the
 * first paint, which would read as data loss to anyone who has already set a letterhead.
 */
const { BrandingSection } = await import('./branding');

const BRANDING = {
  displayName: 'Northwind Books',
  addressLine1: '1 Trade Street',
  addressLine2: null,
  city: 'Seattle',
  region: 'WA',
  postalCode: '98101',
  country: 'US',
  email: 'billing@northwind.test',
  phone: null,
  website: null,
  taxNumber: null,
  logoStorageKey: null,
  // eslint-disable-next-line openbooks/no-raw-color -- fixture: a hex colour value, not a UI style literal
  brandColor: '#1a1a1a',
  invoiceFooter: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function getRoute(branding: typeof BRANDING = BRANDING): StubRoute {
  return {
    method: 'GET',
    path: '/v1/branding',
    reply: () => ({ status: 200, body: branding }),
  };
}

describe('BrandingSection', () => {
  it('pre-fills the form from the loaded branding rather than rendering it blank', async () => {
    installApiStub([getRoute()]);
    renderWithQueryClient(<BrandingSection />);

    expect(await screen.findByLabelText('Display name')).toHaveValue('Northwind Books');
    expect(screen.getByLabelText('Address line 1')).toHaveValue('1 Trade Street');
    expect(screen.getByLabelText('City')).toHaveValue('Seattle');
    // A field the org has never set renders empty, not "null" or "undefined" as text.
    expect(screen.getByLabelText('Phone')).toHaveValue('');
  });

  it('sends only the changed fields, not every field on every save', async () => {
    const stub = installApiStub([
      getRoute(),
      {
        method: 'PATCH',
        path: '/v1/branding',
        reply: () => ({
          status: 200,
          body: {
            ...BRANDING,
            city: 'Portland',
            phone: null,
            updatedAt: '2026-01-02T00:00:00.000Z',
          },
        }),
      },
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<BrandingSection />);

    const city = await screen.findByLabelText('City');
    await user.clear(city);
    await user.type(city, 'Portland');

    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(stub.keysFor('PATCH', '/v1/branding')).toHaveLength(1);
    });
    const call = stub.calls.find((entry) => entry.method === 'PATCH');
    // Only `city` changed, so only `city` is on the wire — not `displayName`, not any of
    // the ten other fields the form also renders.
    expect(call?.body).toEqual({ city: 'Portland' });
  });

  it('clears a nullable field the user emptied by sending null, not an absent key', async () => {
    const stub = installApiStub([
      getRoute(),
      {
        method: 'PATCH',
        path: '/v1/branding',
        reply: () => ({
          status: 200,
          body: { ...BRANDING, addressLine1: null, updatedAt: '2026-01-02T00:00:00.000Z' },
        }),
      },
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<BrandingSection />);

    const addressLine1 = await screen.findByLabelText('Address line 1');
    await user.clear(addressLine1);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(stub.keysFor('PATCH', '/v1/branding')).toHaveLength(1);
    });
    const call = stub.calls.find((entry) => entry.method === 'PATCH');
    expect(call?.body).toEqual({ addressLine1: null });
  });

  it('disables Save while there is nothing to change', async () => {
    installApiStub([getRoute()]);
    renderWithQueryClient(<BrandingSection />);

    await screen.findByLabelText('Display name');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('offers Remove logo only once a logo is on file', async () => {
    installApiStub([getRoute()]);
    renderWithQueryClient(<BrandingSection />);

    await screen.findByLabelText('Display name');
    expect(screen.queryByRole('button', { name: /remove logo/i })).toBeNull();
  });

  it('uploads a chosen logo as JSON with a base64 body, not multipart', async () => {
    const stub = installApiStub([
      getRoute(),
      {
        method: 'POST',
        path: '/v1/branding/logo',
        reply: () => ({
          status: 200,
          body: { ...BRANDING, logoStorageKey: 'org-logos/1.png', updatedAt: BRANDING.updatedAt },
        }),
      },
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<BrandingSection />);

    await screen.findByLabelText('Display name');
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'logo.png', {
      type: 'image/png',
    });
    await user.upload(screen.getByLabelText('Logo file'), file);
    await user.click(screen.getByRole('button', { name: 'Upload logo' }));

    await waitFor(() => {
      expect(stub.keysFor('POST', '/v1/branding/logo')).toHaveLength(1);
    });
    const call = stub.calls.find((entry) => entry.method === 'POST');
    expect(call?.body).toMatchObject({ filename: 'logo.png', contentType: 'image/png' });
    // Base64 of the four PNG signature bytes above — proves the upload sends the file's
    // actual bytes rather than a placeholder, without hard-coding a whole-file fixture.
    expect((call?.body as { content: string }).content).toBe('iVBORw==');

    // The response's `logoStorageKey` lands in the query cache, so "Remove logo" appears
    // without a second `GET /v1/branding`.
    expect(await screen.findByRole('button', { name: 'Remove logo' })).toBeInTheDocument();
  });

  it('shows field-level messages from a refused save', async () => {
    installApiStub([
      getRoute(),
      {
        method: 'PATCH',
        path: '/v1/branding',
        reply: () => ({
          status: 400,
          body: {
            error: {
              code: 'validation_failed',
              message: 'Some of what was entered cannot be saved as it is.',
              details: { issues: [{ path: 'displayName', message: 'Required.' }] },
            },
          },
        }),
      },
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<BrandingSection />);

    const displayName = await screen.findByLabelText('Display name');
    await user.clear(displayName);
    await user.type(displayName, 'A different name');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    // The form-level banner and the field-level message under `displayName` are both
    // `role="alert"`, so this asserts on their text rather than picking one `alert` node.
    expect(await screen.findByText('Check the highlighted fields')).toBeInTheDocument();
    expect(screen.getByText('Required.')).toBeInTheDocument();
  });
});
