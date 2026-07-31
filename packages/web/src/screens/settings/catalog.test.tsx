import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { StubRoute } from './test-support';
import { installApiStub, renderWithQueryClient } from './test-support';

/**
 * The item catalog Settings section (initiative Catalog, D-CAT-1…5). Loaded after
 * `./test-support` — see that module's header for why a static import ahead of the
 * fetch/Request stub would fail every request here.
 */
const { CatalogSection } = await import('./catalog');

const SALES_ITEM = {
  id: 'item-consult',
  direction: 'sales',
  name: 'Consulting hour',
  code: 'CONSULT',
  defaultAccountId: null,
  defaultUnitAmount: '15000',
  defaultTaxRateId: null,
  isActive: true,
  createdAt: '2026-01-05T09:00:00.000Z',
  updatedAt: '2026-01-05T09:00:00.000Z',
};

function listRoute(items: readonly unknown[]): StubRoute {
  return {
    method: 'GET',
    path: '/v1/catalog-items',
    reply: () => ({ status: 200, body: { items, nextCursor: null } }),
  };
}

/** The dialog loads its direction-specific pickers on open; empty pages keep it quiet. */
const REFERENCE_ROUTES: readonly StubRoute[] = [
  {
    method: 'GET',
    path: '/v1/accounts',
    reply: () => ({ status: 200, body: { items: [], nextCursor: null } }),
  },
  {
    method: 'GET',
    path: '/v1/tax-rates',
    reply: () => ({ status: 200, body: { items: [], nextCursor: null } }),
  },
];

describe('CatalogSection', () => {
  it('lists an item with its direction and default price, never as a blank cell', async () => {
    installApiStub([listRoute([SALES_ITEM])]);
    renderWithQueryClient(<CatalogSection />);

    expect(await screen.findByText('Consulting hour')).toBeInTheDocument();
    expect(screen.getByText('CONSULT')).toBeInTheDocument();
    expect(screen.getByText('$150.00')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('creates a sales item, sending direction and name and null for the empty defaults', async () => {
    const user = userEvent.setup();
    const stub = installApiStub([
      listRoute([]),
      ...REFERENCE_ROUTES,
      {
        method: 'POST',
        path: '/v1/catalog-items',
        reply: ({ body }) => ({
          status: 201,
          body: { ...SALES_ITEM, id: 'item-new', ...(body as Record<string, unknown>) },
        }),
      },
    ]);
    renderWithQueryClient(<CatalogSection />);

    await user.click(await screen.findByRole('button', { name: 'New item' }));
    const dialog = await screen.findByRole('dialog', { name: 'New item' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Delivery');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(stub.calls.some((call) => call.method === 'POST')).toBe(true);
    });
    const posted = stub.calls.find(
      (call) => call.method === 'POST' && call.path === '/v1/catalog-items',
    );
    expect(posted?.body).toEqual({
      direction: 'sales',
      name: 'Delivery',
      code: null,
      defaultAccountId: null,
      defaultUnitAmount: null,
      defaultTaxRateId: null,
    });
    expect(posted?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('archives an item through deactivate rather than a delete', async () => {
    const user = userEvent.setup();
    const stub = installApiStub([
      listRoute([SALES_ITEM]),
      {
        method: 'POST',
        path: '/v1/catalog-items/:catalogItemId/deactivate',
        reply: () => ({ status: 200, body: { ...SALES_ITEM, isActive: false } }),
      },
    ]);
    renderWithQueryClient(<CatalogSection />);

    await user.click(await screen.findByRole('button', { name: 'Archive Consulting hour' }));

    await waitFor(() => {
      expect(
        stub.calls.some(
          (call) =>
            call.method === 'POST' && call.path === '/v1/catalog-items/item-consult/deactivate',
        ),
      ).toBe(true);
    });
  });
});
