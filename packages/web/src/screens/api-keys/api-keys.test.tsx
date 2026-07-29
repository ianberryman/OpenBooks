import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { StubRoute } from './test-support';
import { installApiStub, renderWithQueryClient } from './test-support';

/**
 * API keys (OB-105; OB-055, OB-061 — ROADMAP D-55, D-61).
 *
 * Three things are worth a test:
 *
 * 1. **The list reads `keyPrefix` and never a full key** — there is no `key` field on
 *    `ApiKey` to accidentally render, so this is really asserting the fixture shape
 *    matches the contract rather than testing this screen's own logic, but it is the one
 *    regression that would be invisible in review (a fixture with an extra field renders
 *    fine either way).
 * 2. **A create carries one idempotency key and reveals the secret exactly once**, from
 *    the create response and nowhere else.
 * 3. **Revoke posts to the revoke route, never a second create.**
 */
const { ApiKeysScreen } = await import('../api-keys');

const TIMESTAMPS = { createdAt: '2026-01-01T00:00:00.000Z' };
const ROLE_ID = '11111111-1111-4111-8111-111111111111';
const KEY_ID = '22222222-2222-4222-8222-222222222222';

const ROLE = {
  id: ROLE_ID,
  code: 'read_only',
  name: 'Read-only',
  description: 'Read access only.',
  isSystem: true,
};

function apiKey(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: KEY_ID,
    name: 'Nightly import job',
    keyPrefix: 'obk_live_ab12',
    roleId: ROLE_ID,
    createdByUserId: null,
    lastUsedAt: null,
    revokedAt: null,
    ...TIMESTAMPS,
    ...overrides,
  };
}

function rolesRoute(): StubRoute {
  return {
    method: 'GET',
    path: '/v1/roles',
    reply: () => ({ status: 200, body: { roles: [ROLE] } }),
  };
}

function listRoute(keys: readonly Record<string, unknown>[]): StubRoute {
  return {
    method: 'GET',
    path: '/v1/api-keys',
    reply: () => ({ status: 200, body: { items: keys, nextCursor: null } }),
  };
}

describe('ApiKeysScreen', () => {
  it('lists keys by their prefix, never a full key', async () => {
    installApiStub([rolesRoute(), listRoute([apiKey()])]);
    renderWithQueryClient(<ApiKeysScreen />);

    expect(await screen.findByText('Nightly import job')).toBeInTheDocument();
    expect(screen.getByText('obk_live_ab12…')).toBeInTheDocument();
    expect(screen.getByText('Read-only')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('creates a key with one idempotency key and reveals the secret exactly once', async () => {
    const stub = installApiStub([
      rolesRoute(),
      listRoute([]),
      {
        method: 'POST',
        path: '/v1/api-keys',
        reply: ({ body }) => ({
          status: 201,
          body: { ...(body as object), ...apiKey(), key: 'obk_live_ab12cdEFGH34secretvalue' },
        }),
      },
    ]);
    const user = userEvent.setup();
    // Defined AFTER `userEvent.setup()`, which installs its own `navigator.clipboard` stub —
    // ours has to win so the copy handler reaches this mock. jsdom's `navigator` is
    // non-configurable, so `clipboard` is defined on the existing navigator rather than
    // replacing the whole object. Held in a local rather than asserted through
    // `navigator.clipboard.writeText`, which reads as an unbound method.
    const writeText = vi.fn(() => Promise.resolve());
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    renderWithQueryClient(<ApiKeysScreen />);

    const issueButton = await screen.findByRole('button', { name: 'Issue a key' });
    await waitFor(() => {
      expect(issueButton).toBeEnabled();
    });
    await user.click(issueButton);

    const dialog = await screen.findByRole('dialog', { name: 'Issue an API key' });
    await user.type(within(dialog).getByLabelText('Name'), 'Nightly import job');
    await user.click(within(dialog).getByRole('combobox', { name: 'Role' }));
    await user.click(await screen.findByRole('option', { name: 'Read-only' }));
    await user.click(within(dialog).getByRole('button', { name: 'Issue key' }));

    await waitFor(() => {
      expect(stub.keysFor('POST', '/v1/api-keys')).toHaveLength(1);
    });
    const created = stub.calls.find((call) => call.method === 'POST');
    expect(created?.body).toEqual({ name: 'Nightly import job', roleId: ROLE_ID });
    expect(created?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);

    // The full key, and only the full key, appears once the create resolves.
    expect(await screen.findByText('obk_live_ab12cdEFGH34secretvalue')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Copy to clipboard' }));
    expect(writeText).toHaveBeenCalledWith('obk_live_ab12cdEFGH34secretvalue');

    await user.click(screen.getByRole('button', { name: "I've saved it — close" }));
    await waitFor(() => {
      expect(screen.queryByText('obk_live_ab12cdEFGH34secretvalue')).not.toBeInTheDocument();
    });

    if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
    else delete (navigator as { clipboard?: unknown }).clipboard;
  });

  it('revokes a key through the revoke route, never a second create', async () => {
    const stub = installApiStub([
      rolesRoute(),
      listRoute([apiKey({ revokedAt: null })]),
      {
        method: 'POST',
        path: '/v1/api-keys/:apiKeyId/revoke',
        reply: () => ({ status: 200, body: apiKey({ revokedAt: '2026-01-02T00:00:00.000Z' }) }),
      },
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<ApiKeysScreen />);

    await user.click(await screen.findByRole('button', { name: 'Revoke Nightly import job' }));

    await waitFor(() => {
      expect(stub.calls.some((call) => call.method === 'POST')).toBe(true);
    });
    const revoked = stub.calls.find((call) => call.method === 'POST');
    expect(revoked?.path).toBe(`/v1/api-keys/${KEY_ID}/revoke`);
    expect(revoked?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });
});
