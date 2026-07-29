import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { StubRoute } from './test-support';
import { installApiStub, renderWithQueryClient } from './test-support';

/**
 * Payment-processor connections (OB-151; wraps OB-147/OB-150).
 *
 * Four things are worth a test:
 *
 * 1. **The list reads what the server computed** — the processor, the clearing and fee
 *    account resolved off `reference.accountsById`, active state, and when it last
 *    polled — none of it recomputed here.
 * 2. **A paused connection with no poll yet reads "Never", not a blank cell.**
 * 3. **Connecting carries one idempotency key and the exact body the contract
 *    describes, and the secret fields never come back out anywhere in the DOM** —
 *    D-83's guarantee that this screen has nothing to echo even by accident.
 * 4. **Deactivate and reactivate are their own routes**, never a `PATCH`, because there
 *    is no dedicated toggle endpoint on this surface either (`connections.ts`).
 */
const { ProcessingScreen } = await import('../processing');

const CLEARING_ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const FEE_ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
const CONNECTION_ID = '33333333-3333-4333-8333-333333333333';

const TIMESTAMPS = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };

function account(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    parentAccountId: null,
    description: null,
    cashBasisRole: null,
    isActive: true,
    ...TIMESTAMPS,
    ...overrides,
  };
}

const CLEARING_ACCOUNT = account({
  id: CLEARING_ACCOUNT_ID,
  code: '1010',
  name: 'Stripe clearing',
  type: 'asset',
  normalBalance: 'debit',
});

const FEE_ACCOUNT = account({
  id: FEE_ACCOUNT_ID,
  code: '6100',
  name: 'Processor fees',
  type: 'expense',
  normalBalance: 'debit',
});

function connection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CONNECTION_ID,
    processor: 'stripe',
    clearingAccountId: CLEARING_ACCOUNT_ID,
    feeAccountId: FEE_ACCOUNT_ID,
    publishableKey: null,
    externalAccountId: null,
    isActive: true,
    lastPolledAt: null,
    reconciledThrough: null,
    ...overrides,
  };
}

/** The reference-data route every render needs, regardless of what the test is about. */
function referenceRoutes(): StubRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/accounts',
      reply: () => ({
        status: 200,
        body: { items: [CLEARING_ACCOUNT, FEE_ACCOUNT], nextCursor: null },
      }),
    },
  ];
}

/** `GET /v1/processing/connections` returns a bare array, not `{ items, nextCursor }` —
 *  `connections.ts`'s "not a paged collection". */
function listRoute(connections: readonly Record<string, unknown>[]): StubRoute {
  return {
    method: 'GET',
    path: '/v1/processing/connections',
    reply: () => ({ status: 200, body: connections }),
  };
}

describe('ProcessingScreen', () => {
  it('reads processor, account labels and active state off the connection rather than deriving them', async () => {
    installApiStub([
      ...referenceRoutes(),
      listRoute([connection({ isActive: true, lastPolledAt: '2026-07-01T12:30:00.000Z' })]),
    ]);
    renderWithQueryClient(<ProcessingScreen />);

    expect(await screen.findByText('Stripe')).toBeInTheDocument();
    expect(screen.getByText('1010 — Stripe clearing')).toBeInTheDocument();
    expect(screen.getByText('6100 — Processor fees')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deactivate Stripe' })).toBeInTheDocument();
  });

  it('shows "Never" for a connection the poll has not reached yet, not a blank cell', async () => {
    installApiStub([
      ...referenceRoutes(),
      listRoute([connection({ isActive: false, lastPolledAt: null })]),
    ]);
    renderWithQueryClient(<ProcessingScreen />);

    expect(await screen.findByText('Stripe')).toBeInTheDocument();
    expect(screen.getByText('Never')).toBeInTheDocument();
    expect(screen.getByText('Inactive')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reactivate Stripe' })).toBeInTheDocument();
  });

  it('connects a processor with one idempotency key and never echoes the secrets back into the DOM', async () => {
    const stub = installApiStub([
      ...referenceRoutes(),
      listRoute([]),
      {
        method: 'POST',
        path: '/v1/processing/connections',
        reply: ({ body }) => {
          const request = body as Record<string, unknown>;
          return {
            status: 201,
            // The shape `processorConnectionSchema` actually declares (D-83): never
            // `secretKey`/`webhookSecret`, whatever the request carried.
            body: {
              id: CONNECTION_ID,
              processor: request['processor'],
              clearingAccountId: request['clearingAccountId'],
              feeAccountId: request['feeAccountId'],
              publishableKey: request['publishableKey'] ?? null,
              externalAccountId: request['externalAccountId'] ?? null,
              isActive: true,
              lastPolledAt: null,
              reconciledThrough: null,
            },
          };
        },
      },
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<ProcessingScreen />);

    const connectButton = await screen.findByRole('button', { name: 'Connect a processor' });
    await waitFor(() => {
      expect(connectButton).toBeEnabled();
    });
    await user.click(connectButton);

    const dialog = await screen.findByRole('dialog', { name: 'Connect a payment processor' });

    // Processor stays at its default ("Stripe") — only the two accounts and the two
    // secrets need setting.
    await user.click(within(dialog).getByRole('combobox', { name: 'Clearing account' }));
    await user.click(await screen.findByText('1010 — Stripe clearing'));

    await user.click(within(dialog).getByRole('combobox', { name: 'Fee account' }));
    await user.click(await screen.findByText('6100 — Processor fees'));

    await user.type(within(dialog).getByLabelText('Secret key'), 'sk_test_verysecret');
    await user.type(within(dialog).getByLabelText('Webhook secret'), 'whsec_verysecret');

    await user.click(within(dialog).getByRole('button', { name: 'Connect processor' }));

    await waitFor(() => {
      expect(stub.keysFor('POST', '/v1/processing/connections')).toHaveLength(1);
    });
    const posted = stub.calls.find((call) => call.method === 'POST');
    expect(posted?.body).toEqual({
      processor: 'stripe',
      clearingAccountId: CLEARING_ACCOUNT_ID,
      feeAccountId: FEE_ACCOUNT_ID,
      secretKey: 'sk_test_verysecret',
      webhookSecret: 'whsec_verysecret',
    });
    expect(posted?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);

    // The dialog closes on success, and neither secret ever appears anywhere in the
    // rendered document — not in the (now-closed) form, and not echoed onto the list,
    // because `ProcessorConnection` carries no field either could travel back out
    // through (D-83).
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(screen.queryByText('sk_test_verysecret')).not.toBeInTheDocument();
    expect(screen.queryByText('whsec_verysecret')).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain('sk_test_verysecret');
    expect(document.body.innerHTML).not.toContain('whsec_verysecret');
  });

  it('deactivates through the deactivate route, never a PATCH', async () => {
    const stub = installApiStub([
      ...referenceRoutes(),
      listRoute([connection({ isActive: true })]),
      {
        method: 'POST',
        path: `/v1/processing/connections/${CONNECTION_ID}/deactivate`,
        reply: () => ({ status: 200, body: connection({ isActive: false }) }),
      },
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<ProcessingScreen />);

    await user.click(await screen.findByRole('button', { name: 'Deactivate Stripe' }));

    await waitFor(() => {
      expect(stub.calls.some((call) => call.method === 'POST')).toBe(true);
    });
    const posted = stub.calls.find((call) => call.method === 'POST');
    expect(posted?.path).toBe(`/v1/processing/connections/${CONNECTION_ID}/deactivate`);
    expect(posted?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(stub.calls.some((call) => call.method === 'PATCH')).toBe(false);
  });
});
