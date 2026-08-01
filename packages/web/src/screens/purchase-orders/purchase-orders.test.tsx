import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { StubRoute } from './test-support';
import { installApiStub, renderWithQueryClient } from './test-support';

/**
 * Purchase orders (initiative M, OB-170…174; ROADMAP D-M3, D-M4, D-M6, D-M7) — the AP-side
 * mirror of an estimate, so this suite is the mirror of `estimates/estimates.test.tsx`.
 *
 * Four things are worth a test:
 *
 * 1. **The list reads what the server computed and says so plainly** — document number,
 *    vendor, status and total, none of it recomputed here.
 * 2. **A create carries one idempotency key and the exact body the contract describes** —
 *    including the fixed `taxMode: 'exclusive'` this screen never exposes a control for
 *    (`order-state.ts`'s file header explains why) and no `dimensionValueIds` at all (D-M7).
 * 3. **Approve hits `POST …/approve` with no body**, once, keyed to the order rather than the
 *    click.
 * 4. **Convert hits `POST …/convert` and reports the bill it produced**, never a second
 *    `PurchaseOrder` — the detail navigates to `/purchases/bills/:id`.
 */
const { PurchaseOrdersScreen } = await import('../purchase-orders');

const TIMESTAMPS = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };

const VENDOR_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
const ORDER_ID = '33333333-3333-4333-8333-333333333333';
const BILL_ID = '44444444-4444-4444-8444-444444444444';

const VENDOR = {
  id: VENDOR_ID,
  code: 'VEND-1',
  displayName: 'Morgan Supplies',
  legalName: null,
  email: 'orders@morgan.example',
  phone: null,
  isCustomer: false,
  isVendor: true,
  isEmployee: false,
  notes: null,
  isActive: true,
  ...TIMESTAMPS,
};

const ACCOUNT = {
  id: ACCOUNT_ID,
  code: '5000',
  name: 'Cost of goods',
  type: 'expense',
  normalBalance: 'debit',
  parentAccountId: null,
  description: null,
  cashBasisRole: null,
  isActive: true,
  ...TIMESTAMPS,
};

function totals(gross: string): Record<string, unknown> {
  return { net: gross, tax: '0', gross };
}

function orderSummary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ORDER_ID,
    documentNumber: null,
    reference: null,
    contactId: VENDOR_ID,
    issueDate: '2026-01-01',
    expectedDate: null,
    taxMode: 'exclusive',
    status: 'draft',
    memo: null,
    totals: totals('100000'),
    convertedBillId: null,
    approvedAt: null,
    ...TIMESTAMPS,
    ...overrides,
  };
}

/** The reference-data routes every render needs, regardless of what the test is about. */
function referenceRoutes(): StubRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/contacts',
      reply: () => ({ status: 200, body: { items: [VENDOR], nextCursor: null } }),
    },
    {
      method: 'GET',
      path: '/v1/accounts',
      reply: () => ({ status: 200, body: { items: [ACCOUNT], nextCursor: null } }),
    },
  ];
}

function listRoute(orders: readonly Record<string, unknown>[]): StubRoute {
  return {
    method: 'GET',
    path: '/v1/purchase-orders',
    reply: () => ({ status: 200, body: { items: orders, nextCursor: null } }),
  };
}

/** The headline figures the list's summary cards read (`GET /v1/purchase-orders/summary`).
 * Zeros are enough for tests that do not assert the figures. This route matches the
 * `:purchaseOrderId` pattern too, so callers must order it ahead of the detail route. */
function summaryRoute(): StubRoute {
  return {
    method: 'GET',
    path: '/v1/purchase-orders/summary',
    reply: () => ({
      status: 200,
      body: {
        asOf: '2026-07-01',
        draftValue: '0',
        draftCount: 0,
        approvedValue: '0',
        approvedCount: 0,
        convertedValue: '0',
        convertedCount: 0,
      },
    }),
  };
}

/** The full order (lines included) the routed detail/editor loads by id — the list holds only
 * the lineless summary. */
function fullOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...orderSummary(overrides), lines: [] };
}

function detailRoute(order: Record<string, unknown>): StubRoute {
  return {
    method: 'GET',
    path: '/v1/purchase-orders/:purchaseOrderId',
    reply: () => ({ status: 200, body: order }),
  };
}

describe('PurchaseOrdersScreen', () => {
  it('reads document number, vendor, status and total off the order rather than deriving them', async () => {
    installApiStub([
      ...referenceRoutes(),
      summaryRoute(),
      listRoute([
        orderSummary({ documentNumber: '1007', status: 'approved', totals: totals('250000') }),
      ]),
    ]);
    renderWithQueryClient(<PurchaseOrdersScreen />);

    expect(await screen.findByText('1007')).toBeInTheDocument();
    expect(screen.getByText('Morgan Supplies')).toBeInTheDocument();
    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.getByText('$2,500.00')).toBeInTheDocument();
  });

  /**
   * "New purchase order" pre-creates a draft (its lines are optional — the server produces an
   * empty one) and opens it at its own URL, so the create body is exactly a vendor, today's
   * issue date and the fixed `taxMode: 'exclusive'` this screen never exposes a control for —
   * no lines, and so no `dimensionValueIds` (D-M7) — carried on one idempotency key.
   */
  it('creates a draft on the New button with one key and the fixed exclusive tax mode, then opens its editor', async () => {
    const stub = installApiStub([
      ...referenceRoutes(),
      summaryRoute(),
      listRoute([]),
      {
        method: 'POST',
        path: '/v1/purchase-orders',
        reply: ({ body }) => ({
          status: 201,
          body: { ...fullOrder(), ...(body as object), id: ORDER_ID },
        }),
      },
      detailRoute(fullOrder()),
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<PurchaseOrdersScreen />);

    const newButton = await screen.findByRole('button', { name: 'New purchase order' });
    await waitFor(() => {
      expect(newButton).toBeEnabled();
    });
    await user.click(newButton);

    // A draft with no number yet, so it opens on the editor page (which owns the Memo field).
    expect(await screen.findByLabelText('Memo')).toBeInTheDocument();

    await waitFor(() => {
      expect(stub.keysFor('POST', '/v1/purchase-orders')).toHaveLength(1);
    });
    const created = stub.calls.find((call) => call.method === 'POST');
    expect(created?.body).toEqual({
      contactId: VENDOR_ID,
      issueDate: expect.any(String) as string,
      taxMode: 'exclusive',
    });
    expect(created?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('approves a draft from its editor with a single POST and no body', async () => {
    const stub = installApiStub([
      ...referenceRoutes(),
      detailRoute(fullOrder({ status: 'draft' })),
      {
        method: 'POST',
        path: '/v1/purchase-orders/:purchaseOrderId/approve',
        reply: () => ({
          status: 200,
          body: fullOrder({ documentNumber: '1008', status: 'approved' }),
        }),
      },
    ]);
    const user = userEvent.setup();
    // Cold-load the draft's own URL — the routing exists so a link lands on the right component.
    renderWithQueryClient(<PurchaseOrdersScreen />, `/purchase-orders/${ORDER_ID}`);

    await user.click(await screen.findByRole('button', { name: 'Approve & Send' }));

    const dialog = await screen.findByRole('dialog', { name: 'Approve this purchase order?' });
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(stub.keysFor('POST', '/v1/purchase-orders/:purchaseOrderId/approve')).toHaveLength(1);
    });
    const approved = stub.calls.find(
      (call) => call.method === 'POST' && call.path.endsWith('/approve'),
    );
    expect(approved?.body).toBeUndefined();
    expect(approved?.path).toBe(`/v1/purchase-orders/${ORDER_ID}/approve`);
  });

  it('converts an approved order and navigates to the bill it produced, not a second order', async () => {
    installApiStub([
      ...referenceRoutes(),
      detailRoute(fullOrder({ documentNumber: '1009', status: 'approved' })),
      {
        method: 'POST',
        path: '/v1/purchase-orders/:purchaseOrderId/convert',
        reply: () => ({
          status: 200,
          body: {
            id: BILL_ID,
            documentNumber: '2001',
            contactId: VENDOR_ID,
            issueDate: '2026-07-30',
            dueDate: '2026-07-30',
            taxMode: 'exclusive',
            status: 'draft',
            memo: null,
            reference: null,
            lines: [],
            totals: totals('100000'),
            settlement: { allocated: '0', outstanding: '100000' },
            voidedAt: null,
            reversesJournalId: null,
            journalId: null,
            ...TIMESTAMPS,
          },
        }),
      },
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<PurchaseOrdersScreen />, `/purchase-orders/${ORDER_ID}`);

    await user.click(await screen.findByRole('button', { name: 'Convert to bill' }));

    const dialog = await screen.findByRole('dialog', {
      name: 'Convert this purchase order to a bill?',
    });
    await user.click(within(dialog).getByRole('button', { name: 'Convert' }));

    // Converting hands back the produced Bill; the detail reports it by navigating to it —
    // the `/purchases/*` marker route stands in for the bill screen.
    expect(await screen.findByText('Bill page')).toBeInTheDocument();
  });
});
