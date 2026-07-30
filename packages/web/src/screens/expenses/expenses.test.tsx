import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { StubRoute } from './test-support';
import { installApiStub, renderWithQueryClient } from './test-support';

/**
 * Employee expenses (D-M1, D-M2): an expense is a bill whose contact carries `isEmployee`.
 *
 * Three things are worth a test:
 *
 * 1. **The list reads what the server computed and says so plainly** — employee name,
 *    status and total, none of it recomputed here (D-38).
 * 2. **A draft carries one idempotency key and the exact body the contract describes** —
 *    the employee's `contactId`, not a vendor's, and lines with no tax rate at all
 *    (`expense-state.ts`'s own reason for omitting one).
 * 3. **Approve calls the dedicated route, not a status patch** — `POST
 *    /v1/expenses/{expenseId}/approve`, because status is computed and a client may not
 *    write it (D-38).
 */
const { ExpensesScreen } = await import('../expenses');

const TIMESTAMPS = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };

const EMPLOYEE_ID = '11111111-1111-4111-8111-111111111111';
const VENDOR_ID = '22222222-2222-4222-8222-222222222222';
const EXPENSE_ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';
const EXPENSE_ID = '44444444-4444-4444-8444-444444444444';

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

const TRAVEL_ACCOUNT = account({
  id: EXPENSE_ACCOUNT_ID,
  code: '6200',
  name: 'Travel expense',
  type: 'expense',
  normalBalance: 'debit',
});

function contact(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    code: null,
    email: null,
    legalName: null,
    notes: null,
    phone: null,
    isActive: true,
    isCustomer: false,
    isVendor: false,
    isEmployee: false,
    ...TIMESTAMPS,
    ...overrides,
  };
}

const EMPLOYEE = contact({
  id: EMPLOYEE_ID,
  displayName: 'Jamie Rivera',
  isEmployee: true,
});

// A vendor with no employee flag, present only to prove the employee picker excludes it
// (D-M8's own boundary: an expense's contact must carry `isEmployee`).
const VENDOR = contact({
  id: VENDOR_ID,
  displayName: 'Acme Supplies',
  isVendor: true,
});

function totals(gross: string): Record<string, unknown> {
  return { gross, net: gross, tax: '0' };
}

function settlement(outstanding: string): Record<string, unknown> {
  return { allocated: '0', outstanding };
}

function expenseSummary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: EXPENSE_ID,
    contactId: EMPLOYEE_ID,
    documentNumber: null,
    reference: null,
    issueDate: '2026-02-01',
    dueDate: '2026-03-01',
    status: 'draft',
    totals: totals('12500'),
    settlement: settlement('12500'),
    ...TIMESTAMPS,
    ...overrides,
  };
}

function fullExpense(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...expenseSummary(),
    memo: null,
    taxMode: 'exclusive',
    journalId: null,
    voidJournalId: null,
    allocations: [],
    taxSummary: [],
    lines: [],
    ...overrides,
  };
}

/** The reference-data routes every render needs, regardless of what the test is about. */
function referenceRoutes(): StubRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/accounts',
      reply: () => ({ status: 200, body: { items: [TRAVEL_ACCOUNT], nextCursor: null } }),
    },
    {
      method: 'GET',
      path: '/v1/contacts',
      reply: () => ({ status: 200, body: { items: [EMPLOYEE, VENDOR], nextCursor: null } }),
    },
  ];
}

function listRoute(items: readonly Record<string, unknown>[]): StubRoute {
  return {
    method: 'GET',
    path: '/v1/expenses',
    reply: () => ({ status: 200, body: { items, nextCursor: null } }),
  };
}

describe('ExpensesScreen', () => {
  it('reads the employee, status and total off the server rather than deriving them', async () => {
    installApiStub([
      ...referenceRoutes(),
      listRoute([expenseSummary({ status: 'approved', documentNumber: 'EXP-0007' })]),
    ]);
    renderWithQueryClient(<ExpensesScreen />);

    expect(await screen.findByText('Jamie Rivera')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'EXP-0007' })).toBeInTheDocument();
    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.getByText('125.00')).toBeInTheDocument();
    // Once approved, the row says reimbursement lives in Pay Bills — no expense-specific
    // reimbursement action exists on this screen at all (D-M2).
    expect(screen.getByText('Payable via Pay Bills.')).toBeInTheDocument();
    // Draft-only actions do not appear on an approved row.
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it(
    'creates a draft with one idempotency key, the employee’s contactId, and lines with ' +
      'no tax rate at all',
    async () => {
      const stub = installApiStub([
        ...referenceRoutes(),
        listRoute([]),
        {
          method: 'POST',
          path: '/v1/expenses',
          reply: ({ body }) => ({
            status: 201,
            body: fullExpense({ ...(body as object), id: EXPENSE_ID }),
          }),
        },
      ]);
      const user = userEvent.setup();
      renderWithQueryClient(<ExpensesScreen />);

      const newButton = await screen.findByRole('button', { name: 'New expense' });
      await waitFor(() => {
        expect(newButton).toBeEnabled();
      });
      await user.click(newButton);

      const dialog = await screen.findByRole('dialog', { name: 'New expense' });

      // Only the employee-flagged contact is offered — the vendor never appears here
      // (D-M8: `contactId` must carry `isEmployee`).
      await user.click(within(dialog).getByRole('combobox', { name: 'Employee' }));
      expect(screen.queryByText('Acme Supplies')).not.toBeInTheDocument();
      await user.click(await screen.findByText('Jamie Rivera'));

      fireEvent.change(within(dialog).getByLabelText('Issue date'), {
        target: { value: '2026-02-01' },
      });

      await user.type(within(dialog).getByLabelText('Description, line 1'), 'Client dinner');
      await user.click(within(dialog).getByRole('combobox', { name: 'Account, line 1' }));
      await user.click(await screen.findByText('Travel expense'));
      await user.type(within(dialog).getByLabelText('Unit amount, line 1'), '125');

      await user.click(within(dialog).getByRole('button', { name: 'Create draft' }));

      await waitFor(() => {
        expect(stub.keysFor('POST', '/v1/expenses')).toHaveLength(1);
      });
      const created = stub.calls.find((call) => call.method === 'POST');
      expect(created?.body).toEqual({
        contactId: EMPLOYEE_ID,
        issueDate: '2026-02-01',
        memo: null,
        reference: null,
        taxMode: 'exclusive',
        lines: [
          {
            description: 'Client dinner',
            quantity: '1',
            accountId: EXPENSE_ACCOUNT_ID,
            unitAmount: '12500',
          },
        ],
      });
      expect(created?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    },
  );

  it('approves a draft through the dedicated route, carrying one idempotency key', async () => {
    const stub = installApiStub([
      ...referenceRoutes(),
      listRoute([expenseSummary()]),
      {
        method: 'POST',
        path: '/v1/expenses/:expenseId/approve',
        reply: () => ({
          status: 200,
          body: fullExpense({ status: 'approved', documentNumber: 'EXP-0001' }),
        }),
      },
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<ExpensesScreen />);

    await user.click(await screen.findByRole('button', { name: 'Approve' }));

    const dialog = await screen.findByRole('dialog', { name: /Approve/ });
    await user.click(within(dialog).getByRole('button', { name: 'Approve expense' }));

    await waitFor(() => {
      expect(stub.keysFor('POST', '/v1/expenses/:expenseId/approve')).toHaveLength(1);
    });
    const approved = stub.calls.find((call) => call.method === 'POST');
    expect(approved?.path).toBe(`/v1/expenses/${EXPENSE_ID}/approve`);
    // The confirmation closes once the approval lands — nothing left to confirm.
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });
});
