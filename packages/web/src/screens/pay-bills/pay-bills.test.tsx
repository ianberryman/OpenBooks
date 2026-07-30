import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { StubRoute } from './test-support';
import { installApiStub, renderWithQueryClient } from './test-support';

/**
 * The Pay Bills window (OB-116; ROADMAP D-63, D-64, D-68, D-79).
 *
 * Three things are worth a test:
 *
 * 1. **The table reads `outstanding`/`committed`/`availableToPay` off the server**, never
 *    deriving them (D-34, D-68).
 * 2. **Selecting a bill defaults its pay amount to what is available, and "Build payments"
 *    sends one `CreatePendingPaymentRequest` per vendor with one idempotency key** — the
 *    batch shape D-63 describes, exercised at the smallest possible size, one vendor.
 * 3. **The discount affordance fills `discountAmount`/`discountAccountId` from the preview
 *    and reduces the pay amount by the same figure**, which then travels on the built
 *    intent — the gap `money-in/allocation-editor.tsx`'s own `DiscountHint` names as still
 *    open for a manual receipt, closed here because `intents[]` has somewhere to post it.
 */
const { PayBillsScreen } = await import('../pay-bills');

const TIMESTAMPS = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };

const VENDOR_ID = '11111111-1111-4111-8111-111111111111';
const BILL_ID = '22222222-2222-4222-8222-222222222222';
const BANK_ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';
const LEDGER_ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';
const PENDING_PAYMENT_ID = '55555555-5555-4555-8555-555555555555';
const DISCOUNT_ACCOUNT_ID = '66666666-6666-4666-8666-666666666666';

function payableBill(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    billId: BILL_ID,
    contactId: VENDOR_ID,
    vendorName: 'Acme Supplies',
    reference: 'INV-500',
    issueDate: '2026-07-01',
    dueDate: '2026-07-31',
    outstanding: '100000',
    committed: '0',
    availableToPay: '100000',
    gross: '100000',
    ...overrides,
  };
}

function bankAccount(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: BANK_ACCOUNT_ID,
    accountId: LEDGER_ACCOUNT_ID,
    name: 'Operating account',
    institutionName: 'First Bank',
    externalAccountId: null,
    feedSource: 'file',
    isActive: true,
    ...TIMESTAMPS,
    ...overrides,
  };
}

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
        id: '77777777-7777-4777-8777-777777777777',
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

/** The reference-data routes every render needs, regardless of what the test is about. */
function referenceRoutes(): StubRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/bank-accounts',
      reply: () => ({ status: 200, body: { items: [bankAccount()], nextCursor: null } }),
    },
    {
      method: 'GET',
      path: '/v1/vendor-credits',
      reply: () => ({ status: 200, body: { items: [], nextCursor: null } }),
    },
  ];
}

function billsRoute(bills: readonly Record<string, unknown>[]): StubRoute {
  return {
    method: 'GET',
    path: '/v1/payable-bills',
    reply: () => ({ status: 200, body: { bills } }),
  };
}

function noDiscountRoute(): StubRoute {
  return {
    method: 'GET',
    path: '/v1/payment-terms/discount-suggestion',
    reply: () => ({ status: 204 }),
  };
}

describe('PayBillsScreen', () => {
  it('reads outstanding, committed and available off the bill rather than deriving them', async () => {
    installApiStub([...referenceRoutes(), billsRoute([payableBill()]), noDiscountRoute()]);
    renderWithQueryClient(<PayBillsScreen />);

    expect(await screen.findByText('Acme Supplies')).toBeInTheDocument();
    expect(screen.getByText('INV-500')).toBeInTheDocument();
    expect(screen.getAllByText('1000.00')).toHaveLength(2); // outstanding and availableToPay
    expect(screen.getByText('0.00')).toBeInTheDocument(); // committed
  });

  it('defaults the pay amount to what is available and builds one payment per vendor with one idempotency key', async () => {
    const stub = installApiStub([
      ...referenceRoutes(),
      billsRoute([payableBill()]),
      noDiscountRoute(),
      {
        method: 'POST',
        path: '/v1/pay-bills',
        reply: ({ body }) => ({
          status: 201,
          body: {
            pendingPayments: [
              pendingPayment({
                intents: (body as { payments: { intents: unknown }[] }).payments[0]?.intents,
              }),
            ],
          },
        }),
      },
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<PayBillsScreen />);

    const checkbox = await screen.findByRole('checkbox', { name: /Select Acme Supplies/ });
    await user.click(checkbox);

    expect(screen.getByLabelText('Pay amount for Acme Supplies')).toHaveValue('1000.00');

    await user.click(screen.getByRole('combobox', { name: 'Bank account' }));
    await user.click(await screen.findByText('Operating account'));

    await user.click(screen.getByRole('button', { name: 'Build payments' }));

    await waitFor(() => {
      expect(stub.keysFor('POST', '/v1/pay-bills')).toHaveLength(1);
    });
    const built = stub.calls.find((call) => call.method === 'POST');
    expect(built?.body).toEqual({
      payments: [
        {
          contactId: VENDOR_ID,
          bankAccountId: BANK_ACCOUNT_ID,
          rail: 'check',
          intents: [{ billId: BILL_ID, payAmount: '100000' }],
        },
      ],
    });

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Built 1 payment onto the Disbursements queue.',
    );
  });

  it('applying the suggested discount fills the intent and reduces the pay amount by the same figure', async () => {
    const stub = installApiStub([
      ...referenceRoutes(),
      billsRoute([payableBill()]),
      {
        method: 'GET',
        path: '/v1/payment-terms/discount-suggestion',
        reply: () => ({
          status: 200,
          body: {
            accountId: DISCOUNT_ACCOUNT_ID,
            deadline: '2026-07-11',
            discountAmountMinor: '2000',
            targetId: BILL_ID,
          },
        }),
      },
      {
        method: 'POST',
        path: '/v1/pay-bills',
        reply: () => ({ status: 201, body: { pendingPayments: [pendingPayment()] } }),
      },
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<PayBillsScreen />);

    await user.click(await screen.findByRole('checkbox', { name: /Select Acme Supplies/ }));
    await user.click(await screen.findByRole('button', { name: 'Apply discount' }));

    // 1000.00 available minus the 20.00 discount.
    expect(screen.getByLabelText('Pay amount for Acme Supplies')).toHaveValue('980.00');

    await user.click(screen.getByRole('combobox', { name: 'Bank account' }));
    await user.click(await screen.findByText('Operating account'));
    await user.click(screen.getByRole('button', { name: 'Build payments' }));

    await waitFor(() => {
      expect(stub.calls.some((call) => call.method === 'POST')).toBe(true);
    });
    const built = stub.calls.find((call) => call.method === 'POST');
    const body = built?.body as {
      payments: { intents: { discountAmount?: string; discountAccountId?: string }[] }[];
    };
    expect(body.payments[0]?.intents[0]?.discountAmount).toBe('2000');
    expect(body.payments[0]?.intents[0]?.discountAccountId).toBe(DISCOUNT_ACCOUNT_ID);
  });
});
