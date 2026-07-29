import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { StubRoute } from './test-support';
import { installApiStub, renderWithQueryClient } from './test-support';

/**
 * Connected apps (OB-105; OB-098 — ROADMAP D-54, D-61).
 *
 * Two things are worth a test: the list shows the granted scope rather than the user's
 * full role (D-54), and revoke posts to the revoke route with one idempotency key.
 */
const { ConnectedAppsScreen } = await import('../connected-apps');

const CLIENT_ID = 'client_ab12cd34';

function connectedApp(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clientId: CLIENT_ID,
    name: 'Acme Sync',
    scope: ['invoices.read', 'contacts.read'],
    consentedAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: null,
    ...overrides,
  };
}

function listRoute(apps: readonly Record<string, unknown>[]): StubRoute {
  return {
    method: 'GET',
    path: '/v1/connected-apps',
    reply: () => ({ status: 200, body: { items: apps, nextCursor: null } }),
  };
}

describe('ConnectedAppsScreen', () => {
  it('shows the granted scope, not the caller’s full role', async () => {
    installApiStub([listRoute([connectedApp()])]);
    renderWithQueryClient(<ConnectedAppsScreen />);

    expect(await screen.findByText('Acme Sync')).toBeInTheDocument();
    expect(screen.getByText('invoices.read')).toBeInTheDocument();
    expect(screen.getByText('contacts.read')).toBeInTheDocument();
  });

  it('revokes access with one idempotency key', async () => {
    const stub = installApiStub([
      listRoute([connectedApp()]),
      {
        method: 'POST',
        path: '/v1/connected-apps/:clientId/revoke',
        reply: () => ({ status: 204 }),
      },
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<ConnectedAppsScreen />);

    await user.click(await screen.findByRole('button', { name: 'Revoke access for Acme Sync' }));

    await waitFor(() => {
      expect(stub.keysFor('POST', '/v1/connected-apps/:clientId/revoke')).toHaveLength(1);
    });
    const revoked = stub.calls.find((call) => call.method === 'POST');
    expect(revoked?.path).toBe(`/v1/connected-apps/${CLIENT_ID}/revoke`);
  });
});
