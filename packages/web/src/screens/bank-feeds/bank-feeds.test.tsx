import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { StubRoute } from './test-support';
import { installApiStub, renderWithQueryClient } from './test-support';

/**
 * Live bank feeds (OB-227; wraps the six `/v1/bank-feeds` operations).
 *
 * Five things are worth a test:
 *
 * 1. **The list reads what the server computed** — the bank account resolved off the
 *    account map, the feed source, institution, active state and last-synced — none of it
 *    recomputed here — and a failed run surfaces its `lastSyncError`.
 * 2. **A connection the sync has not reached reads "Never", not a blank cell.**
 * 3. **Connecting is link-session then connect**, each carrying one idempotency key and the
 *    exact body the contract describes, and the restricted key never comes back out anywhere
 *    in the DOM (D-83).
 * 4. **A manual sync goes through the sync route**, carrying an idempotency key.
 * 5. **Disconnect is confirmed and goes through the deactivate route, never a `PATCH`.**
 */
const { BankFeedsScreen } = await import('./index');

const BANK_ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const CONNECTION_ID = '33333333-3333-4333-8333-333333333333';
const EXTERNAL_ACCOUNT_ID = 'acct_live_001';

const ALL_PERMISSIONS = ['banking.read', 'banking.connect', 'banking.import'];

const TIMESTAMPS = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };

function bankAccount(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: BANK_ACCOUNT_ID,
    accountId: '99999999-9999-4999-8999-999999999999',
    name: 'Barclays Current',
    institutionName: 'Barclays',
    externalAccountId: null,
    feedSource: 'file',
    isActive: true,
    ...TIMESTAMPS,
    ...overrides,
  };
}

function connection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CONNECTION_ID,
    bankAccountId: BANK_ACCOUNT_ID,
    feedSource: 'stripe_financial_connections',
    credentialSource: 'bring_your_own',
    externalAccountId: EXTERNAL_ACCOUNT_ID,
    institution: 'Barclays',
    isActive: true,
    lastSyncedAt: null,
    lastSyncError: null,
    ...TIMESTAMPS,
    ...overrides,
  };
}

/** `GET /v1/auth/me` — the permission set the advisory gating reads (D-25). */
function identityRoute(permissions: readonly string[] = ALL_PERMISSIONS): StubRoute {
  return {
    method: 'GET',
    path: '/v1/auth/me',
    reply: () => ({ status: 200, body: { permissions } }),
  };
}

/** The bank-account picker route every render loads for its account labels. */
function bankAccountsRoute(
  accounts: readonly Record<string, unknown>[] = [bankAccount()],
): StubRoute {
  return {
    method: 'GET',
    path: '/v1/bank-accounts',
    reply: () => ({ status: 200, body: { items: accounts, nextCursor: null } }),
  };
}

function listRoute(connections: readonly Record<string, unknown>[]): StubRoute {
  return {
    method: 'GET',
    path: '/v1/bank-feeds',
    reply: () => ({ status: 200, body: { items: connections, nextCursor: null } }),
  };
}

describe('BankFeedsScreen', () => {
  it('reads the bank account label, feed source, institution and active state off the connection, and surfaces a sync failure', async () => {
    installApiStub([
      identityRoute(),
      bankAccountsRoute(),
      listRoute([
        connection({ lastSyncedAt: '2026-07-01T12:30:00.000Z', lastSyncError: 'provider timeout' }),
      ]),
    ]);
    renderWithQueryClient(<BankFeedsScreen />);

    expect(await screen.findByText('Barclays Current')).toBeInTheDocument();
    expect(screen.getByText('Stripe Financial Connections')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText(/provider timeout/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Sync Stripe Financial Connections now' }),
    ).toBeInTheDocument();
  });

  it('shows "Never" for a connection the sync has not reached yet, not a blank cell', async () => {
    installApiStub([
      identityRoute(),
      bankAccountsRoute(),
      listRoute([connection({ lastSyncedAt: null })]),
    ]);
    renderWithQueryClient(<BankFeedsScreen />);

    expect(await screen.findByText('Barclays Current')).toBeInTheDocument();
    expect(screen.getByText('Never')).toBeInTheDocument();
  });

  it('connects through link-session then connect, each with one idempotency key, and never echoes the restricted key', async () => {
    const stub = installApiStub([
      identityRoute(),
      bankAccountsRoute(),
      listRoute([]),
      {
        method: 'POST',
        path: '/v1/bank-feeds/link-sessions',
        reply: () => ({
          status: 200,
          body: {
            clientSecret: 'stripe_financial_connections-link-session',
            linkedAccounts: [
              {
                externalAccountId: EXTERNAL_ACCOUNT_ID,
                institution: 'Barclays',
                displayName: 'Barclays Current ••1234',
                category: 'cash',
              },
            ],
          },
        }),
      },
      {
        method: 'POST',
        path: '/v1/bank-feeds',
        reply: ({ body }) => {
          const request = body as Record<string, unknown>;
          // The shape a read returns (D-83): never `restrictedKey`, whatever the request carried.
          return {
            status: 201,
            body: connection({
              bankAccountId: request['bankAccountId'],
              feedSource: request['feedSource'],
              externalAccountId: request['externalAccountId'],
              institution: request['institution'] ?? null,
            }),
          };
        },
      },
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<BankFeedsScreen />);

    const connectButton = await screen.findByRole('button', { name: 'Connect a bank feed' });
    await waitFor(() => {
      expect(connectButton).toBeEnabled();
    });
    await user.click(connectButton);

    const dialog = await screen.findByRole('dialog', { name: 'Connect a bank feed' });

    await user.click(within(dialog).getByRole('combobox', { name: 'Bank account' }));
    await user.click(await screen.findByText('Barclays Current'));

    await user.type(within(dialog).getByLabelText('Restricted key'), 'rk_test_verysecret');

    await user.click(within(dialog).getByRole('button', { name: 'Find accounts' }));

    // Step two: the picker of accounts the credential can already pull, then connect.
    await user.click(await within(dialog).findByRole('button', { name: 'Connect feed' }));

    await waitFor(() => {
      expect(stub.keysFor('POST', '/v1/bank-feeds')).toHaveLength(1);
    });

    const linkCall = stub.calls.find((call) => call.path === '/v1/bank-feeds/link-sessions');
    expect(linkCall?.body).toEqual({
      feedSource: 'stripe_financial_connections',
      restrictedKey: 'rk_test_verysecret',
    });
    expect(linkCall?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);

    const connectCall = stub.calls.find(
      (call) => call.method === 'POST' && call.path === '/v1/bank-feeds',
    );
    expect(connectCall?.body).toEqual({
      bankAccountId: BANK_ACCOUNT_ID,
      feedSource: 'stripe_financial_connections',
      restrictedKey: 'rk_test_verysecret',
      externalAccountId: EXTERNAL_ACCOUNT_ID,
      institution: 'Barclays',
    });
    expect(connectCall?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);

    // The dialog closes on success and the restricted key never appears anywhere.
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(document.body.innerHTML).not.toContain('rk_test_verysecret');
  });

  it('syncs through the sync route, carrying an idempotency key', async () => {
    const stub = installApiStub([
      identityRoute(),
      bankAccountsRoute(),
      listRoute([connection()]),
      {
        method: 'POST',
        path: `/v1/bank-feeds/${CONNECTION_ID}/sync`,
        reply: () => ({
          status: 200,
          body: {
            connectionId: CONNECTION_ID,
            cursor: 'c1',
            linesImported: 3,
            linesDuplicate: 1,
            syncedAt: '2026-07-02T00:00:00.000Z',
          },
        }),
      },
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<BankFeedsScreen />);

    await user.click(
      await screen.findByRole('button', { name: 'Sync Stripe Financial Connections now' }),
    );

    await waitFor(() => {
      expect(stub.calls.some((call) => call.method === 'POST')).toBe(true);
    });
    const posted = stub.calls.find((call) => call.method === 'POST');
    expect(posted?.path).toBe(`/v1/bank-feeds/${CONNECTION_ID}/sync`);
    expect(posted?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(stub.calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  it('disconnects through the deactivate route after a confirmation, never a PATCH', async () => {
    const stub = installApiStub([
      identityRoute(),
      bankAccountsRoute(),
      listRoute([connection()]),
      {
        method: 'POST',
        path: `/v1/bank-feeds/${CONNECTION_ID}/deactivate`,
        reply: () => ({ status: 200, body: connection({ isActive: false }) }),
      },
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<BankFeedsScreen />);

    await user.click(
      await screen.findByRole('button', { name: 'Disconnect Stripe Financial Connections' }),
    );

    // The confirmation, not the deactivate, is what the row action opens first.
    const dialog = await screen.findByRole('dialog', { name: 'Disconnect this bank feed?' });
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect feed' }));

    await waitFor(() => {
      expect(stub.calls.some((call) => call.method === 'POST')).toBe(true);
    });
    const posted = stub.calls.find((call) => call.method === 'POST');
    expect(posted?.path).toBe(`/v1/bank-feeds/${CONNECTION_ID}/deactivate`);
    expect(posted?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(stub.calls.some((call) => call.method === 'PATCH')).toBe(false);
  });
});
