import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { StubRoute } from './test-support';
import { installApiStub, renderWithQueryClient } from './test-support';

/**
 * OAuth clients (OB-105; OB-053, OB-098 — ROADMAP D-53, D-54, D-61).
 *
 * Three things are worth a test: the list renders every redirect URI a client carries, a
 * register call sends the parsed line-per-entry `redirectUris` array with one idempotency
 * key and reveals `clientSecret` exactly once, and deactivate posts to the deactivate
 * route.
 */
const { OAuthClientsScreen } = await import('../oauth-clients');

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';

function client(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CLIENT_ID,
    clientId: 'client_ab12cd34',
    name: 'Acme Sync',
    redirectUris: ['https://acme.example.com/callback'],
    createdAt: '2026-01-01T00:00:00.000Z',
    deactivatedAt: null,
    ...overrides,
  };
}

function listRoute(clients: readonly Record<string, unknown>[]): StubRoute {
  return {
    method: 'GET',
    path: '/v1/oauth-clients',
    reply: () => ({ status: 200, body: { items: clients, nextCursor: null } }),
  };
}

describe('OAuthClientsScreen', () => {
  it('lists every redirect URI a client carries', async () => {
    installApiStub([listRoute([client()])]);
    renderWithQueryClient(<OAuthClientsScreen />);

    expect(await screen.findByText('Acme Sync')).toBeInTheDocument();
    expect(screen.getByText('client_ab12cd34')).toBeInTheDocument();
    expect(screen.getByText('https://acme.example.com/callback')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('registers a client with one idempotency key and reveals the secret exactly once', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn(() => Promise.resolve()) },
    });

    const stub = installApiStub([
      listRoute([]),
      {
        method: 'POST',
        path: '/v1/oauth-clients',
        reply: ({ body }) => ({
          status: 201,
          body: { ...(body as object), ...client(), clientSecret: 'secret_value_xyz' },
        }),
      },
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<OAuthClientsScreen />);

    await user.click(await screen.findByRole('button', { name: 'Register a client' }));

    const dialog = await screen.findByRole('dialog', { name: 'Register an OAuth client' });
    await user.type(within(dialog).getByLabelText('Name'), 'Acme Sync');
    // `fireEvent.change`, not `user.type`: a multi-line paste has no per-keystroke model in
    // jsdom worth driving one character at a time, the same escape hatch
    // `recurring-invoices.test.tsx` reaches for on the date input.
    fireEvent.change(within(dialog).getByLabelText('Redirect URIs'), {
      target: {
        value: 'https://acme.example.com/callback\nhttps://acme.example.com/other',
      },
    });
    await user.click(within(dialog).getByRole('button', { name: 'Register client' }));

    await waitFor(() => {
      expect(stub.keysFor('POST', '/v1/oauth-clients')).toHaveLength(1);
    });
    const registered = stub.calls.find((call) => call.method === 'POST');
    expect(registered?.body).toEqual({
      name: 'Acme Sync',
      redirectUris: ['https://acme.example.com/callback', 'https://acme.example.com/other'],
    });
    expect(registered?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);

    expect(await screen.findByText('secret_value_xyz')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: "I've saved it — close" }));
    await waitFor(() => {
      expect(screen.queryByText('secret_value_xyz')).not.toBeInTheDocument();
    });

    vi.unstubAllGlobals();
  });

  it('deactivates a client through the deactivate route', async () => {
    const stub = installApiStub([
      listRoute([client()]),
      {
        method: 'POST',
        path: '/v1/oauth-clients/:oauthClientId/deactivate',
        reply: () => ({
          status: 200,
          body: client({ deactivatedAt: '2026-01-02T00:00:00.000Z' }),
        }),
      },
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<OAuthClientsScreen />);

    await user.click(await screen.findByRole('button', { name: 'Deactivate Acme Sync' }));

    await waitFor(() => {
      expect(stub.calls.some((call) => call.method === 'POST')).toBe(true);
    });
    const deactivated = stub.calls.find((call) => call.method === 'POST');
    expect(deactivated?.path).toBe(`/v1/oauth-clients/${CLIENT_ID}/deactivate`);
    expect(deactivated?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });
});
