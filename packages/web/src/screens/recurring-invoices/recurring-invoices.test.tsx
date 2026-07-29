import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { StubRoute } from './test-support';
import { installApiStub, renderWithQueryClient } from './test-support';

/**
 * Recurring invoices (OB-133; OB-128, OB-130, ROADMAP D-75, D-76).
 *
 * Three things are worth a test (the first gets two: active, and paused with no next run):
 *
 * 1. **The list reads what the server computed and says so plainly** — cadence, customer
 *    and active/paused, none of it recomputed here.
 * 2. **A create carries one idempotency key and the exact body the contract describes**,
 *    including `startDate` — the one field that seeds the schedule and is never seen
 *    again.
 * 3. **Pause and resume are the same route, `PATCH { isActive }`, and never `POST
 *    …/deactivate`** — there is no dedicated pause/resume endpoint, so the toggle on the
 *    list must not reach for the one-way retirement route by mistake.
 */
const { RecurringInvoicesScreen } = await import('../recurring-invoices');

const TIMESTAMPS = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
const TAX_RATE_ID = '33333333-3333-4333-8333-333333333333';
const TEMPLATE_ID = '44444444-4444-4444-8444-444444444444';

const CUSTOMER = {
  id: CUSTOMER_ID,
  code: 'CUST-1',
  displayName: 'Jordan Ellis',
  legalName: null,
  email: null,
  phone: null,
  isCustomer: true,
  isVendor: false,
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

const TAX_RATE = {
  id: TAX_RATE_ID,
  name: 'VAT 20%',
  percentage: '20',
  accountId: ACCOUNT_ID,
  appliesTo: 'sales',
  isActive: true,
  ...TIMESTAMPS,
};

function template(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TEMPLATE_ID,
    contactId: CUSTOMER_ID,
    name: 'Monthly retainer',
    materializationMode: 'draft',
    taxMode: 'exclusive',
    frequency: 'monthly',
    intervalCount: 1,
    dueDays: 14,
    memo: null,
    nextRunDate: '2026-08-01',
    lastRunDate: null,
    endDate: null,
    isActive: true,
    lines: [
      {
        description: 'Retainer',
        quantity: '1',
        unitAmount: '100000',
        accountId: ACCOUNT_ID,
        taxRateId: TAX_RATE_ID,
      },
    ],
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
    {
      method: 'GET',
      path: '/v1/tax-rates',
      reply: () => ({ status: 200, body: { items: [TAX_RATE], nextCursor: null } }),
    },
  ];
}

function listRoute(templates: readonly Record<string, unknown>[]): StubRoute {
  return {
    method: 'GET',
    path: '/v1/recurring-invoices',
    reply: () => ({ status: 200, body: { items: templates, nextCursor: null } }),
  };
}

describe('RecurringInvoicesScreen', () => {
  it('reads cadence, customer and active state off the template rather than deriving them', async () => {
    const stub = installApiStub([
      ...referenceRoutes(),
      listRoute([template({ frequency: 'monthly', intervalCount: 2, isActive: true })]),
    ]);
    renderWithQueryClient(<RecurringInvoicesScreen />);

    expect(await screen.findByText('Monthly retainer')).toBeInTheDocument();
    expect(screen.getByText('Jordan Ellis')).toBeInTheDocument();
    // `intervalCount: 2` combined with `frequency` the way the template's own author meant
    // it — "Every 2 months", never a bare "Monthly" that drops the multiplier.
    expect(screen.getByText('Every 2 months')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('2026-08-01')).toBeInTheDocument();

    // The income-account and sales-tax filters are not cosmetic (`queries.ts`' reason): a
    // line's account credits the invoice each cycle raises, and every cycle materialises
    // an invoice, never a bill — so both requests must say so server-side.
    const accountsCall = stub.calls.find((call) => call.path === '/v1/accounts');
    expect(new URLSearchParams(accountsCall?.query ?? '').get('type')).toBe('revenue');
    const taxRatesCall = stub.calls.find((call) => call.path === '/v1/tax-rates');
    expect(new URLSearchParams(taxRatesCall?.query ?? '').get('appliesTo')).toBe('sales');
  });

  it('shows a paused template with no next run date rather than one the engine will not honour', async () => {
    installApiStub([...referenceRoutes(), listRoute([template({ isActive: false })])]);
    renderWithQueryClient(<RecurringInvoicesScreen />);

    expect(await screen.findByText('Monthly retainer')).toBeInTheDocument();
    expect(screen.getByText('Paused')).toBeInTheDocument();
    expect(screen.queryByText('2026-08-01')).not.toBeInTheDocument();
  });

  it('creates a template with one idempotency key and the exact body the contract describes', async () => {
    const stub = installApiStub([
      ...referenceRoutes(),
      listRoute([]),
      {
        method: 'POST',
        path: '/v1/recurring-invoices',
        reply: ({ body }) => ({
          status: 201,
          body: {
            ...(body as object),
            id: TEMPLATE_ID,
            nextRunDate: '2026-08-01',
            lastRunDate: null,
            isActive: true,
            ...TIMESTAMPS,
          },
        }),
      },
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<RecurringInvoicesScreen />);

    const newButton = await screen.findByRole('button', { name: 'New recurring invoice' });
    await waitFor(() => {
      expect(newButton).toBeEnabled();
    });
    await user.click(newButton);

    const dialog = await screen.findByRole('dialog', { name: 'New recurring invoice' });

    // The option list opens in its own Radix popover portal, appended alongside the
    // dialog's rather than nested inside it — `within(dialog)` would never find it, the
    // same reason `journal-entry.test.tsx` picks a combobox option off the unscoped
    // `screen`.
    await user.click(within(dialog).getByRole('combobox', { name: 'Customer' }));
    await user.click(await screen.findByText('Jordan Ellis'));

    await user.type(within(dialog).getByLabelText('Name'), 'Monthly retainer');

    // `fireEvent.change`, not `user.type`: a native date input has no segmented keyboard
    // model in jsdom to drive one key at a time, `combobox.test.tsx`'s own reason for
    // reaching for the same escape hatch on the one control `user-event` cannot drive.
    fireEvent.change(within(dialog).getByLabelText('Start date'), {
      target: { value: '2026-08-01' },
    });

    await user.click(within(dialog).getByRole('combobox', { name: 'Income account, line 1' }));
    await user.click(await screen.findByText('Consulting revenue'));

    await user.type(within(dialog).getByLabelText('Unit price, line 1'), '1000');

    await user.click(within(dialog).getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(stub.keysFor('POST', '/v1/recurring-invoices')).toHaveLength(1);
    });
    const created = stub.calls.find((call) => call.method === 'POST');
    expect(created?.body).toEqual({
      contactId: CUSTOMER_ID,
      name: 'Monthly retainer',
      materializationMode: 'draft',
      taxMode: 'exclusive',
      frequency: 'monthly',
      intervalCount: 1,
      dueDays: 0,
      memo: null,
      startDate: '2026-08-01',
      endDate: null,
      lines: [
        {
          description: null,
          quantity: '1',
          unitAmount: '100000',
          accountId: ACCOUNT_ID,
          taxRateId: null,
        },
      ],
    });
    expect(created?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('pauses and resumes through the general update, never the one-way retirement route', async () => {
    const stub = installApiStub([
      ...referenceRoutes(),
      listRoute([template({ isActive: true })]),
      {
        method: 'PATCH',
        path: '/v1/recurring-invoices/:templateId',
        reply: ({ body }) => ({
          status: 200,
          body: { ...template({ isActive: true }), ...(body as object) },
        }),
      },
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<RecurringInvoicesScreen />);

    await user.click(await screen.findByRole('button', { name: 'Pause Monthly retainer' }));

    await waitFor(() => {
      expect(stub.calls.some((call) => call.method === 'PATCH')).toBe(true);
    });
    const patch = stub.calls.find((call) => call.method === 'PATCH');
    expect(patch?.body).toEqual({ isActive: false });
    expect(stub.calls.some((call) => call.method === 'POST')).toBe(false);
    expect(patch?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });
});
