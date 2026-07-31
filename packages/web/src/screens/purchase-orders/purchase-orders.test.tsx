import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { StubRoute } from './test-support';
import { installApiStub, renderWithQueryClient } from './test-support';

/**
 * Purchase orders (D-M3, D-M6, D-M7).
 *
 * Three things are worth a test, `fixed-assets.test.tsx`'s own list:
 *
 * 1. **The list reads what the server stored and says so plainly** — vendor, status and
 *    total, none of it recomputed here.
 * 2. **A create carries one idempotency key and the exact body the contract describes** —
 *    `taxMode` hard-coded to `exclusive` since this screen offers no tax-rate control, and
 *    an empty `lines` array when nothing was typed (`createPurchaseOrder`'s own words:
 *    lines is optional).
 * 3. **Approve and convert hit their own routes, never a patch of `status`** — D-M6's
 *    status is stored, not derived, and this screen only ever calls the two POST endpoints
 *    that change it.
 */
const { PurchaseOrdersScreen } = await import('../purchase-orders');

const TIMESTAMPS = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };

const VENDOR_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
const PURCHASE_ORDER_ID = '33333333-3333-4333-8333-333333333333';
const BILL_ID = '44444444-4444-4444-8444-444444444444';

const VENDOR = {
  id: VENDOR_ID,
  displayName: 'Acme Supplies',
  code: null,
  email: 'ap@acme.test',
  phone: null,
  legalName: null,
  notes: null,
  isActive: true,
  isCustomer: false,
  isVendor: true,
  isEmployee: false,
  ...TIMESTAMPS,
};

const ACCOUNT = {
  id: ACCOUNT_ID,
  code: '5000',
  name: 'Office supplies',
  description: null,
  type: 'expense',
  normalBalance: 'debit',
  parentAccountId: null,
  cashBasisRole: null,
  isActive: true,
  ...TIMESTAMPS,
};

function totals(gross: string): { net: string; tax: string; gross: string } {
  return { net: gross, tax: '0', gross };
}

function purchaseOrderSummary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PURCHASE_ORDER_ID,
    contactId: VENDOR_ID,
    documentNumber: null,
    reference: null,
    memo: null,
    issueDate: '2026-01-15',
    expectedDate: null,
    taxMode: 'exclusive',
    status: 'draft',
    approvedAt: null,
    convertedBillId: null,
    totals: totals('0'),
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

describe('PurchaseOrdersScreen', () => {
  it('reads vendor, status and total off the response rather than deriving them', async () => {
    installApiStub([
      ...referenceRoutes(),
      listRoute([
        purchaseOrderSummary({
          documentNumber: 'PO-0001',
          status: 'approved',
          approvedAt: '2026-01-16T00:00:00.000Z',
          totals: totals('50000'),
        }),
      ]),
    ]);
    renderWithQueryClient(<PurchaseOrdersScreen />);

    expect(await screen.findByText('PO-0001')).toBeInTheDocument();
    expect(screen.getByText('Acme Supplies')).toBeInTheDocument();
    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.getByText('$500.00')).toBeInTheDocument();
  });

  it('creates a draft with one idempotency key and the exact body the contract describes', async () => {
    const stub = installApiStub([
      ...referenceRoutes(),
      listRoute([]),
      {
        method: 'POST',
        path: '/v1/purchase-orders',
        reply: ({ body }) => ({
          status: 201,
          body: {
            ...(body as object),
            id: PURCHASE_ORDER_ID,
            documentNumber: null,
            status: 'draft',
            approvedAt: null,
            convertedBillId: null,
            totals: totals('0'),
            lines: [],
            ...TIMESTAMPS,
          },
        }),
      },
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<PurchaseOrdersScreen />);

    const newButton = await screen.findByRole('button', { name: 'New purchase order' });
    await waitFor(() => {
      expect(newButton).toBeEnabled();
    });
    await user.click(newButton);

    const dialog = await screen.findByRole('dialog', { name: 'New purchase order' });

    // Option lists open in their own Radix popover portal, appended alongside the dialog's
    // rather than nested inside it — `fixed-assets.test.tsx`'s own reason for picking an
    // option off the unscoped `screen`.
    await user.click(within(dialog).getByRole('combobox', { name: 'Vendor' }));
    await user.click(await screen.findByText('Acme Supplies'));

    await user.click(within(dialog).getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(stub.keysFor('POST', '/v1/purchase-orders')).toHaveLength(1);
    });
    const created = stub.calls.find((call) => call.method === 'POST');
    const body = created?.body as Record<string, unknown> | undefined;
    expect(typeof body?.['issueDate']).toBe('string');
    expect(created?.body).toEqual({
      contactId: VENDOR_ID,
      issueDate: body?.['issueDate'],
      expectedDate: null,
      reference: null,
      memo: null,
      taxMode: 'exclusive',
      // No line was ever touched, so the untouched blank row is dropped rather than sent
      // half-formed — `createPurchaseOrder`'s own words: lines is optional.
      lines: [],
    });
    expect(created?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('approves against its own route, one idempotency key, never a patch of status', async () => {
    const stub = installApiStub([
      ...referenceRoutes(),
      listRoute([purchaseOrderSummary()]),
      {
        method: 'POST',
        path: '/v1/purchase-orders/:purchaseOrderId/approve',
        reply: () => ({
          status: 200,
          body: purchaseOrderSummary({
            documentNumber: 'PO-0001',
            status: 'approved',
            approvedAt: '2026-01-16T00:00:00.000Z',
            lines: [],
          }),
        }),
      },
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<PurchaseOrdersScreen />);

    await user.click(await screen.findByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(stub.keysFor('POST', '/v1/purchase-orders/:purchaseOrderId/approve')).toHaveLength(1);
    });
    const approved = stub.calls.find((call) => call.path.endsWith('/approve'));
    expect(approved?.path).toBe(`/v1/purchase-orders/${PURCHASE_ORDER_ID}/approve`);
    expect(approved?.body).toBeUndefined();
    expect(approved?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);

    expect(await screen.findByText('Approved PO-0001.')).toBeInTheDocument();
  });

  it('converts an approved order to a bill against its own route', async () => {
    const stub = installApiStub([
      ...referenceRoutes(),
      listRoute([purchaseOrderSummary({ documentNumber: 'PO-0001', status: 'approved' })]),
      {
        method: 'POST',
        path: '/v1/purchase-orders/:purchaseOrderId/convert',
        reply: () => ({
          status: 200,
          body: {
            id: BILL_ID,
            contactId: VENDOR_ID,
            documentNumber: 'BILL-0001',
            reference: null,
            issueDate: '2026-01-16',
            dueDate: '2026-02-15',
            taxMode: 'exclusive',
            memo: null,
            status: 'draft',
            journalId: null,
            voidJournalId: null,
            lines: [],
            totals: totals('0'),
            taxSummary: [],
            settlement: { allocated: '0', outstanding: '0' },
            allocations: [],
            ...TIMESTAMPS,
          },
        }),
      },
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<PurchaseOrdersScreen />);

    await user.click(await screen.findByRole('button', { name: 'Convert to bill' }));

    await waitFor(() => {
      expect(stub.keysFor('POST', '/v1/purchase-orders/:purchaseOrderId/convert')).toHaveLength(1);
    });
    const converted = stub.calls.find((call) => call.path.endsWith('/convert'));
    expect(converted?.path).toBe(`/v1/purchase-orders/${PURCHASE_ORDER_ID}/convert`);
    expect(converted?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);

    expect(
      await screen.findByText(
        'Converted to draft bill BILL-0001 — approve it on the Purchases screen to reach the ledger.',
      ),
    ).toBeInTheDocument();
  });
});
