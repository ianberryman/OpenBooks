import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { StubRoute } from './test-support';
import { installApiStub, renderWithQueryClient } from './test-support';

/**
 * Estimates (initiative M, OB-172, OB-176; ROADMAP D-M3, D-M4, D-M6, D-M7).
 *
 * Four things are worth a test:
 *
 * 1. **The list reads what the server computed and says so plainly** — document number,
 *    customer, status and total, none of it recomputed here.
 * 2. **A create carries one idempotency key and the exact body the contract describes** —
 *    including the fixed `taxMode: 'exclusive'` this screen never exposes a control for
 *    (`estimate-state.ts`'s file header explains why) and no `dimensionValueIds` at all
 *    (D-M7).
 * 3. **Approve hits `POST …/approve` with no body**, once, keyed to the estimate rather
 *    than the click.
 * 4. **Convert hits `POST …/convert` and reports the invoice it produced**, never a second
 *    `Estimate`.
 */
const { EstimatesScreen } = await import('../estimates');

const TIMESTAMPS = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
const ESTIMATE_ID = '33333333-3333-4333-8333-333333333333';
const INVOICE_ID = '44444444-4444-4444-8444-444444444444';

const CUSTOMER = {
  id: CUSTOMER_ID,
  code: 'CUST-1',
  displayName: 'Jordan Ellis',
  legalName: null,
  email: 'jordan@example.com',
  phone: null,
  isCustomer: true,
  isVendor: false,
  isEmployee: false,
  notes: null,
  isActive: true,
  ...TIMESTAMPS,
};

const ACCOUNT = {
  id: ACCOUNT_ID,
  code: '4000',
  name: 'Consulting revenue',
  type: 'revenue',
  normalBalance: 'credit',
  parentAccountId: null,
  description: null,
  cashBasisRole: null,
  isActive: true,
  ...TIMESTAMPS,
};

function totals(gross: string): Record<string, unknown> {
  return { net: gross, tax: '0', gross };
}

function estimateSummary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ESTIMATE_ID,
    documentNumber: null,
    reference: null,
    contactId: CUSTOMER_ID,
    issueDate: '2026-01-01',
    expiryDate: null,
    taxMode: 'exclusive',
    status: 'draft',
    memo: null,
    totals: totals('100000'),
    convertedInvoiceId: null,
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
      reply: () => ({ status: 200, body: { items: [CUSTOMER], nextCursor: null } }),
    },
    {
      method: 'GET',
      path: '/v1/accounts',
      reply: () => ({ status: 200, body: { items: [ACCOUNT], nextCursor: null } }),
    },
  ];
}

function listRoute(estimates: readonly Record<string, unknown>[]): StubRoute {
  return {
    method: 'GET',
    path: '/v1/estimates',
    reply: () => ({ status: 200, body: { items: estimates, nextCursor: null } }),
  };
}

describe('EstimatesScreen', () => {
  it('reads document number, customer, status and total off the estimate rather than deriving them', async () => {
    installApiStub([
      ...referenceRoutes(),
      listRoute([
        estimateSummary({ documentNumber: '1007', status: 'approved', totals: totals('250000') }),
      ]),
    ]);
    renderWithQueryClient(<EstimatesScreen />);

    expect(await screen.findByText('1007')).toBeInTheDocument();
    expect(screen.getByText('Jordan Ellis')).toBeInTheDocument();
    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.getByText('2500.00')).toBeInTheDocument();
  });

  it(
    'creates an estimate with one idempotency key, the fixed exclusive tax mode, and no ' +
      'dimension tags on its line',
    async () => {
      const stub = installApiStub([
        ...referenceRoutes(),
        listRoute([]),
        {
          method: 'POST',
          path: '/v1/estimates',
          reply: ({ body }) => ({
            status: 201,
            body: {
              ...(body as object),
              id: ESTIMATE_ID,
              documentNumber: null,
              status: 'draft',
              totals: totals('50000'),
              convertedInvoiceId: null,
              approvedAt: null,
              ...TIMESTAMPS,
            },
          }),
        },
      ]);
      const user = userEvent.setup();
      renderWithQueryClient(<EstimatesScreen />);

      const newButton = await screen.findByRole('button', { name: 'New estimate' });
      await waitFor(() => {
        expect(newButton).toBeEnabled();
      });
      await user.click(newButton);

      const dialog = await screen.findByRole('dialog', { name: 'New estimate' });

      await user.click(within(dialog).getByRole('combobox', { name: 'Customer' }));
      await user.click(await screen.findByText('Jordan Ellis'));

      const lines = within(dialog).getAllByLabelText(/Description, line/);
      await user.type(lines[0] as HTMLElement, 'Consulting');

      await user.clear(within(dialog).getByLabelText('Quantity, line 1'));
      await user.type(within(dialog).getByLabelText('Quantity, line 1'), '2');

      await user.type(within(dialog).getByLabelText('Unit price, line 1'), '500');

      await user.click(within(dialog).getByRole('combobox', { name: 'Income account, line 1' }));
      await user.click(await screen.findByText('Consulting revenue'));

      await user.click(within(dialog).getByRole('button', { name: 'Create' }));

      await waitFor(() => {
        expect(stub.keysFor('POST', '/v1/estimates')).toHaveLength(1);
      });
      const created = stub.calls.find((call) => call.method === 'POST');
      expect(created?.body).toEqual({
        contactId: CUSTOMER_ID,
        issueDate: expect.any(String) as string,
        expiryDate: null,
        reference: null,
        memo: null,
        taxMode: 'exclusive',
        lines: [
          {
            description: 'Consulting',
            quantity: '2',
            unitAmount: '50000',
            accountId: ACCOUNT_ID,
          },
        ],
      });
      expect(created?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    },
  );

  it('approves a draft with a single POST and no body', async () => {
    const stub = installApiStub([
      ...referenceRoutes(),
      listRoute([estimateSummary({ status: 'draft' })]),
      {
        method: 'POST',
        path: '/v1/estimates/:estimateId/approve',
        reply: () => ({
          status: 200,
          body: estimateSummary({ documentNumber: '1008', status: 'approved' }),
        }),
      },
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<EstimatesScreen />);

    await user.click(await screen.findByRole('button', { name: 'Approve' }));

    const dialog = await screen.findByRole('dialog', { name: 'Approve this estimate?' });
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(stub.keysFor('POST', '/v1/estimates/:estimateId/approve')).toHaveLength(1);
    });
    const approved = stub.calls.find((call) => call.method === 'POST');
    expect(approved?.body).toBeUndefined();
    expect(approved?.path).toBe(`/v1/estimates/${ESTIMATE_ID}/approve`);
  });

  it('converts an approved estimate and reports the invoice it produced, not a second estimate', async () => {
    installApiStub([
      ...referenceRoutes(),
      listRoute([estimateSummary({ documentNumber: '1009', status: 'approved' })]),
      {
        method: 'POST',
        path: '/v1/estimates/:estimateId/convert',
        reply: () => ({
          status: 200,
          body: {
            id: INVOICE_ID,
            documentNumber: '2001',
            contactId: CUSTOMER_ID,
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
    renderWithQueryClient(<EstimatesScreen />);

    await user.click(await screen.findByRole('button', { name: 'Convert to invoice' }));

    const dialog = await screen.findByRole('dialog', {
      name: 'Convert this estimate to an invoice?',
    });
    await user.click(within(dialog).getByRole('button', { name: 'Convert' }));

    expect(await screen.findByText(/Invoice 2001 was created/)).toBeInTheDocument();
  });
});
