import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { StubRoute } from './test-support';
import { installApiStub, renderWithQueryClient } from './test-support';

/**
 * The Disbursements queue (OB-116; ROADMAP D-64, D-65, D-68, D-109, D-110).
 *
 * Four things are worth a test:
 *
 * 1. **The queue reads the server's own `status`/`rail`/`totalAmount`**, never deriving
 *    them.
 * 2. **Rail routing is `PATCH { rail }`, one idempotency key per change** — never a
 *    dedicated route, the same shape `recurring-invoices.tsx` states for pause/resume.
 * 3. **Issuing shows the check number on success** — `IssueOutcome.checkNumber`, surfaced
 *    rather than narrated (D-65).
 * 4. **Cancelling is `POST …/cancel`**, confirmed, one idempotency key.
 */
const { DisbursementsScreen } = await import('../disbursements');

const TIMESTAMPS = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };

const VENDOR_ID = '11111111-1111-4111-8111-111111111111';
const BILL_ID = '22222222-2222-4222-8222-222222222222';
const BANK_ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';
const PENDING_PAYMENT_ID = '55555555-5555-4555-8555-555555555555';
const INTENT_ID = '77777777-7777-4777-8777-777777777777';

function pendingPayment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PENDING_PAYMENT_ID,
    contactId: VENDOR_ID,
    vendorName: 'Acme Supplies',
    bankAccountId: BANK_ACCOUNT_ID,
    rail: 'check',
    memo: null,
    status: 'open',
    totalAmount: '100000',
    issuedPaymentId: null,
    intents: [
      {
        id: INTENT_ID,
        billId: BILL_ID,
        payAmount: '100000',
        discountAccountId: null,
        discountAmount: null,
        appliedVendorCreditId: null,
      },
    ],
    ...TIMESTAMPS,
    ...overrides,
  };
}

function listRoute(payments: readonly Record<string, unknown>[]): StubRoute {
  return {
    method: 'GET',
    path: '/v1/pending-payments',
    reply: () => ({ status: 200, body: { pendingPayments: payments } }),
  };
}

describe('DisbursementsScreen', () => {
  it('reads status, rail and the total off the server rather than deriving them', async () => {
    installApiStub([listRoute([pendingPayment()])]);
    renderWithQueryClient(<DisbursementsScreen />);

    expect(await screen.findByText('Acme Supplies')).toBeInTheDocument();
    expect(screen.getByText('$1,000.00')).toBeInTheDocument();
    // The status filter above the table also renders "Open" (as the current filter's own
    // selected label), so the queue row's status pill is found within the table.
    expect(within(screen.getByRole('table')).getByText('Open')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /Rail for the payment/ })).toHaveTextContent(
      'Check',
    );
  });

  it('routes to a different rail with one PATCH and one idempotency key', async () => {
    const stub = installApiStub([
      listRoute([pendingPayment()]),
      {
        method: 'PATCH',
        path: '/v1/pending-payments/:pendingPaymentId',
        reply: ({ body }) => ({ status: 200, body: { ...pendingPayment(), ...(body as object) } }),
      },
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<DisbursementsScreen />);

    await user.click(await screen.findByRole('combobox', { name: /Rail for the payment/ }));
    await user.click(await screen.findByRole('option', { name: 'ACH' }));

    await waitFor(() => {
      expect(stub.calls.some((call) => call.method === 'PATCH')).toBe(true);
    });
    const patch = stub.calls.find((call) => call.method === 'PATCH');
    expect(patch?.body).toEqual({ rail: 'ach' });
    expect(patch?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('shows the check number an issue succeeds with', async () => {
    installApiStub([
      listRoute([pendingPayment()]),
      {
        method: 'POST',
        path: '/v1/pending-payments/:pendingPaymentId/issue',
        reply: () => ({
          status: 200,
          body: {
            pendingPaymentId: PENDING_PAYMENT_ID,
            status: 'issued',
            paymentId: '88888888-8888-4888-8888-888888888888',
            checkNumber: '1042',
            error: null,
          },
        }),
      },
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<DisbursementsScreen />);

    await user.click(await screen.findByRole('button', { name: 'Issue' }));

    const dialog = await screen.findByRole('dialog', {
      name: 'Issue the payment to Acme Supplies',
    });
    await user.click(within(dialog).getByRole('button', { name: 'Issue' }));

    expect(await screen.findByText('1042')).toBeInTheDocument();
  });

  it('cancels an open pending payment with one idempotency key', async () => {
    const stub = installApiStub([
      listRoute([pendingPayment()]),
      {
        method: 'POST',
        path: '/v1/pending-payments/:pendingPaymentId/cancel',
        reply: () => ({ status: 200, body: pendingPayment({ status: 'cancelled' }) }),
      },
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<DisbursementsScreen />);

    await user.click(await screen.findByRole('button', { name: /Cancel the payment/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Cancel this pending payment?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel payment' }));

    await waitFor(() => {
      expect(stub.calls.some((call) => call.method === 'POST')).toBe(true);
    });
    const cancel = stub.calls.find((call) => call.method === 'POST');
    expect(cancel?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });
});
