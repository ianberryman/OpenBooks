import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { StubRoute } from './test-support';
import { installApiStub, renderWithQueryClient } from './test-support';

/**
 * Budgets (OB-180…184; ROADMAP D-N1…D-N6).
 *
 * One thing is worth a test here: **a save sends one idempotency key and a batch body
 * naming only the account the user actually edited** — `SetBudgetsRequest`'s own words, and
 * the reason `grid.tsx` tracks a dirty set rather than resending every row on every save.
 * The account-total slot (no `dimensionValueId` on the wire) is exercised because that is
 * the slot v1's grid opens on by default, with no dimension chosen.
 */
const { BudgetsScreen } = await import('../budgets');

const TIMESTAMPS = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };

const PERIOD_ID = '11111111-1111-4111-8111-111111111111';
const REVENUE_ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
const EXPENSE_ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';
const ASSET_ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';
const BUDGET_ID = '55555555-5555-4555-8555-555555555555';

const PERIOD = {
  id: PERIOD_ID,
  name: '2026-03',
  startDate: '2026-03-01',
  endDate: '2026-03-31',
  status: 'open',
  closedAt: null,
  closedByUserId: null,
};

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

const REVENUE_ACCOUNT = account({
  id: REVENUE_ACCOUNT_ID,
  code: '4000',
  name: 'Consulting revenue',
  type: 'revenue',
  normalBalance: 'credit',
});

const EXPENSE_ACCOUNT = account({
  id: EXPENSE_ACCOUNT_ID,
  code: '6000',
  name: 'Office supplies',
  type: 'expense',
  normalBalance: 'debit',
});

// Present in the chart but never offered by the grid — only revenue and expense accounts
// are budgeted in v1 (D-N2).
const ASSET_ACCOUNT = account({
  id: ASSET_ACCOUNT_ID,
  code: '1000',
  name: 'Operating bank account',
  type: 'asset',
  normalBalance: 'debit',
});

/** The reference-data routes every render needs, regardless of what the test is about. */
function referenceRoutes(): StubRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/fiscal-periods',
      reply: () => ({ status: 200, body: { periods: [PERIOD] } }),
    },
    {
      method: 'GET',
      path: '/v1/accounts',
      reply: () => ({
        status: 200,
        body: { items: [REVENUE_ACCOUNT, EXPENSE_ACCOUNT, ASSET_ACCOUNT], nextCursor: null },
      }),
    },
    {
      method: 'GET',
      path: '/v1/dimensions',
      reply: () => ({ status: 200, body: { items: [], nextCursor: null } }),
    },
  ];
}

function budgetsRoute(items: readonly Record<string, unknown>[]): StubRoute {
  return {
    method: 'GET',
    path: '/v1/budgets',
    reply: () => ({ status: 200, body: { items } }),
  };
}

describe('BudgetsScreen', () => {
  it('never offers an asset account in the grid — only revenue and expense are budgeted', async () => {
    installApiStub([...referenceRoutes(), budgetsRoute([])]);
    const user = userEvent.setup();
    renderWithQueryClient(<BudgetsScreen />);

    await user.click(screen.getByRole('combobox', { name: 'Fiscal period' }));
    await user.click(await screen.findByRole('option', { name: '2026-03' }));

    expect(await screen.findByLabelText('Consulting revenue budgeted amount')).toBeInTheDocument();
    expect(screen.getByLabelText('Office supplies budgeted amount')).toBeInTheDocument();
    expect(
      screen.queryByLabelText('Operating bank account budgeted amount'),
    ).not.toBeInTheDocument();
  });

  it(
    'saves one idempotency key and a batch naming only the account the user edited, ' +
      'with no dimensionValueId when no dimension was chosen',
    async () => {
      const stub = installApiStub([
        ...referenceRoutes(),
        budgetsRoute([]),
        {
          method: 'POST',
          path: '/v1/budgets',
          reply: ({ body }) => {
            const entries = (body as { entries: Record<string, unknown>[] }).entries;
            return {
              status: 200,
              body: {
                items: entries.map((entry) => ({
                  ...entry,
                  id: BUDGET_ID,
                  dimensionId: null,
                  ...TIMESTAMPS,
                })),
              },
            };
          },
        },
      ]);
      const user = userEvent.setup();
      renderWithQueryClient(<BudgetsScreen />);

      await user.click(screen.getByRole('combobox', { name: 'Fiscal period' }));
      await user.click(await screen.findByRole('option', { name: '2026-03' }));

      const revenueInput = await screen.findByLabelText('Consulting revenue budgeted amount');
      await user.type(revenueInput, '1000');

      const saveButton = screen.getByRole('button', { name: 'Save budgets' });
      await waitFor(() => {
        expect(saveButton).toBeEnabled();
      });
      await user.click(saveButton);

      await waitFor(() => {
        expect(stub.keysFor('POST', '/v1/budgets')).toHaveLength(1);
      });
      const posted = stub.calls.find((call) => call.method === 'POST');
      expect(posted?.body).toEqual({
        entries: [{ accountId: REVENUE_ACCOUNT_ID, periodId: PERIOD_ID, amount: '100000' }],
      });
      expect(posted?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    },
  );

  it('prefills the grid from the account-total budgets already on record for the period', async () => {
    installApiStub([
      ...referenceRoutes(),
      budgetsRoute([
        {
          id: BUDGET_ID,
          accountId: EXPENSE_ACCOUNT_ID,
          periodId: PERIOD_ID,
          amount: '250000',
          dimensionId: null,
          dimensionValueId: null,
          ...TIMESTAMPS,
        },
      ]),
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<BudgetsScreen />);

    await user.click(screen.getByRole('combobox', { name: 'Fiscal period' }));
    await user.click(await screen.findByRole('option', { name: '2026-03' }));

    const expenseInput = await screen.findByLabelText('Office supplies budgeted amount');
    await waitFor(() => {
      expect(expenseInput).toHaveValue('2500.00');
    });
  });
});
