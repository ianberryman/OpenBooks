import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * As in `reconciliation.test.tsx`: the generated client captures `globalThis.fetch` and its
 * base URL when `src/api/client.ts` is evaluated, so both stubs are in place before the
 * imports below run (`vi.hoisted`). Nothing else is mocked — the screen, the query hooks,
 * the generated client and the component layer are all real; the network is the one
 * boundary this package owns (spec §12).
 */
const { fetchMock } = vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', 'http://openbooks.test');
  const fetchMock = vi.fn<(request: Request) => Promise<Response>>();
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock };
});

import { createQueryClient } from '../../query/client';
import { BankAccountsScreen } from './bank-accounts';
import type { Account, BankAccount } from './queries';

type Route = (request: Request, url: URL) => Response | Promise<Response>;

const routes = new Map<string, Route>();

function stub(method: string, pathname: string, route: Route): void {
  routes.set(`${method} ${pathname}`, route);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The envelope every non-2xx on this API carries (`errorResponseSchema`). */
function apiError(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): Response {
  return json(status, {
    error: { code, message, ...(details === undefined ? {} : { details }) },
  });
}

const BANK_ACC = '11111111-1111-4111-8111-111111111111';
const LEDGER = '22222222-2222-4222-8222-222222222222';

function ledgerAccount(): Account {
  return {
    id: LEDGER,
    code: '1000',
    name: 'Bank',
    type: 'asset',
    normalBalance: 'debit',
    parentAccountId: null,
    description: null,
    cashBasisRole: null,
    isActive: true,
    createdAt: '2026-01-01T09:00:00.000Z',
    updatedAt: '2026-01-01T09:00:00.000Z',
  };
}

function bankAccount(overrides: Partial<BankAccount> = {}): BankAccount {
  return {
    id: BANK_ACC,
    accountId: LEDGER,
    externalAccountId: null,
    feedSource: 'file',
    institutionName: 'Barclays',
    isActive: true,
    name: 'Barclays Current',
    createdAt: '2026-01-05T09:00:00.000Z',
    updatedAt: '2026-01-05T09:00:00.000Z',
    ...overrides,
  };
}

function stubLedgerAccounts(): void {
  stub('GET', '/v1/accounts', () => json(200, { items: [ledgerAccount()], nextCursor: null }));
}

function renderScreen(): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <BankAccountsScreen />
    </QueryClientProvider>,
  );
}

function requestsTo(method: string, pathname: string): Request[] {
  return fetchMock.mock.calls
    .map(([request]) => request)
    .filter((request) => request.method === method && new URL(request.url).pathname === pathname);
}

beforeEach(() => {
  routes.clear();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (request) => {
    const url = new URL(request.url);
    const route = routes.get(`${request.method} ${url.pathname}`);
    if (route === undefined) {
      throw new Error(`The test stubbed no route for ${request.method} ${url.pathname}.`);
    }
    return route(request, url);
  });
});

describe('BankAccountsScreen — registering', () => {
  /**
   * Registration chooses a ledger account (D-46) and sends the chosen id plus the metadata
   * a statement import needs. A blank optional box is the user declining to give one, so it
   * is absent from the body rather than an empty string.
   */
  it('posts the chosen ledger account, the name and the institution', async () => {
    const user = userEvent.setup();

    stub('GET', '/v1/bank-accounts', () => json(200, { items: [], nextCursor: null }));
    stubLedgerAccounts();
    stub('POST', '/v1/bank-accounts', () => json(201, bankAccount()));

    renderScreen();

    await user.click(await screen.findByRole('button', { name: 'Register bank account' }));
    const dialog = await screen.findByRole('dialog', { name: 'Register a bank account' });

    await user.click(within(dialog).getByRole('combobox', { name: 'Ledger account' }));
    await user.click(await screen.findByRole('option', { name: /1000 — Bank/ }));

    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Barclays Current');
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Institution (optional)' }),
      'Barclays',
    );

    await user.click(within(dialog).getByRole('button', { name: 'Register bank account' }));

    const [posted] = requestsTo('POST', '/v1/bank-accounts');
    expect(posted).toBeDefined();
    const body = (await posted?.clone().json()) as Record<string, unknown>;
    expect(body).toEqual({
      accountId: LEDGER,
      name: 'Barclays Current',
      institutionName: 'Barclays',
    });
    // A blank optional is absent, not empty.
    expect(Object.keys(body)).not.toContain('externalAccountId');
    // Every write carries a key.
    expect(posted?.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('BankAccountsScreen — deactivate and reactivate', () => {
  it('deactivates an active account through the deactivate route', async () => {
    const user = userEvent.setup();

    stub('GET', '/v1/bank-accounts', () => json(200, { items: [bankAccount()], nextCursor: null }));
    stub('POST', `/v1/bank-accounts/${BANK_ACC}/deactivate`, () =>
      json(200, bankAccount({ isActive: false })),
    );

    renderScreen();

    await user.click(await screen.findByRole('button', { name: 'Deactivate' }));

    const [posted] = requestsTo('POST', `/v1/bank-accounts/${BANK_ACC}/deactivate`);
    expect(posted).toBeDefined();
    expect(posted?.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reactivates an inactive account through the reactivate route', async () => {
    const user = userEvent.setup();

    stub('GET', '/v1/bank-accounts', () =>
      json(200, { items: [bankAccount({ isActive: false })], nextCursor: null }),
    );
    stub('POST', `/v1/bank-accounts/${BANK_ACC}/reactivate`, () =>
      json(200, bankAccount({ isActive: true })),
    );

    renderScreen();

    await user.click(await screen.findByRole('button', { name: 'Reactivate' }));

    const [posted] = requestsTo('POST', `/v1/bank-accounts/${BANK_ACC}/reactivate`);
    expect(posted).toBeDefined();
  });

  /**
   * The one refusal this screen exists to make legible (OB-095): deactivating with a
   * reconciliation session still open. The server decides — the balances and the session
   * state are its to hold — so the call is made and the mapped refusal is surfaced rather
   * than swallowed into the shared error surface.
   */
  it('surfaces the open-session refusal when deactivation is blocked', async () => {
    const user = userEvent.setup();

    stub('GET', '/v1/bank-accounts', () => json(200, { items: [bankAccount()], nextCursor: null }));
    stub('POST', `/v1/bank-accounts/${BANK_ACC}/deactivate`, () =>
      apiError(412, 'precondition_failed', 'This bank account has a reconciliation session open.', {
        precondition: 'bank_account_has_open_session',
      }),
    );

    renderScreen();

    await user.click(await screen.findByRole('button', { name: 'Deactivate' }));

    const refusal = await screen.findByRole('alert');
    expect(refusal).toHaveTextContent('This account has a reconciliation open');
    expect(refusal).toHaveTextContent(/Finalise the session/);
  });
});
