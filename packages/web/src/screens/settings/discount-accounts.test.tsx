import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { StubRoute } from './test-support';
import { installApiStub, renderWithQueryClient } from './test-support';

/**
 * Loaded after `./test-support` — see that module's own header for why a static import of
 * the section here, ahead of the fetch/Request stub, would fail every request in this file.
 */
const { DiscountAccountsSection } = await import('./discount-accounts');

/**
 * Discount-account nominations (OB-136, OB-140; ROADMAP D-79, D-106, D-107).
 *
 * One thing is worth a test: the two pickers narrow by account **type** the way the
 * server's own `REQUIRED_TYPE` does — `given` offers only expense accounts, `received`
 * only revenue — and a single `Save` lands both in the one `PATCH` the API models, with
 * an explicit `null` for the side left unset.
 */

function account(id: string, code: string, name: string, type: string): unknown {
  return {
    id,
    code,
    name,
    description: null,
    type,
    normalBalance: type === 'expense' ? 'debit' : 'credit',
    parentAccountId: null,
    isActive: true,
    createdAt: '2026-01-05T09:00:00.000Z',
    updatedAt: '2026-01-05T09:00:00.000Z',
  };
}

const FEES = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SALES = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BANK = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function accountsRoute(): StubRoute {
  return {
    method: 'GET',
    path: '/v1/accounts',
    reply: () => ({
      status: 200,
      body: {
        items: [
          account(FEES, '7000', 'Early payment discounts given', 'expense'),
          account(SALES, '4000', 'Sales', 'revenue'),
          account(BANK, '1000', 'Operating bank account', 'asset'),
        ],
        nextCursor: null,
      },
    }),
  };
}

function discountAccountsRoute(given: string | null, received: string | null): StubRoute {
  return {
    method: 'GET',
    path: '/v1/settings/discount-accounts',
    reply: () => ({
      status: 200,
      body: { discountGivenAccountId: given, discountReceivedAccountId: received },
    }),
  };
}

describe('DiscountAccountsSection', () => {
  it('offers only expense accounts for the given side', async () => {
    const user = userEvent.setup();
    installApiStub([accountsRoute(), discountAccountsRoute(null, null)]);
    renderWithQueryClient(<DiscountAccountsSection />);

    await user.click(await screen.findByRole('combobox', { name: 'Discount given' }));
    expect(
      await screen.findByRole('option', { name: /Early payment discounts given/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Sales/ })).toBeNull();
    expect(screen.queryByRole('option', { name: /Operating bank account/ })).toBeNull();
  });

  it('offers only revenue accounts for the received side', async () => {
    const user = userEvent.setup();
    installApiStub([accountsRoute(), discountAccountsRoute(null, null)]);
    renderWithQueryClient(<DiscountAccountsSection />);

    await user.click(await screen.findByRole('combobox', { name: 'Discount received' }));
    expect(await screen.findByRole('option', { name: /Sales/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Early payment discounts given/ })).toBeNull();
    expect(screen.queryByRole('option', { name: /Operating bank account/ })).toBeNull();
  });

  it('saves both nominations in one PATCH, disabled until something changed', async () => {
    const user = userEvent.setup();
    const stub = installApiStub([
      accountsRoute(),
      discountAccountsRoute(null, null),
      {
        method: 'PATCH',
        path: '/v1/settings/discount-accounts',
        reply: ({ body }) => ({
          status: 200,
          body: body,
        }),
      },
    ]);
    renderWithQueryClient(<DiscountAccountsSection />);

    expect(await screen.findByRole('button', { name: 'Save' })).toBeDisabled();

    await user.click(await screen.findByRole('combobox', { name: 'Discount given' }));
    await user.click(await screen.findByRole('option', { name: /Early payment discounts given/ }));

    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(stub.calls.some((call) => call.method === 'PATCH')).toBe(true);
    });
    const patched = stub.calls.find((call) => call.method === 'PATCH');
    expect(patched?.body).toEqual({
      discountGivenAccountId: FEES,
      discountReceivedAccountId: null,
    });
    expect(patched?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);

    expect(await screen.findByText(/Saved\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});
