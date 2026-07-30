import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { StubRoute } from './test-support';
import { installApiStub, renderWithQueryClient } from './test-support';

/**
 * Recurring journals (OB-167; OB-162, ROADMAP D-90).
 *
 * Four things are worth a test (the first gets two: active, and paused with no next run):
 *
 * 1. **The list reads what the server computed and says so plainly** — cadence and
 *    active/paused, none of it recomputed here.
 * 2. **A create carries one idempotency key and the exact body the contract describes**,
 *    including `startDate` — the one field that seeds the schedule and is never seen
 *    again — and two balanced lines.
 * 3. **Pause and resume are the same route, `PATCH { isActive }`, and never `POST
 *    …/deactivate`** — there is no dedicated pause/resume endpoint, so the toggle on the
 *    list must not reach for the one-way retirement route by mistake.
 */
const { RecurringJournalsScreen } = await import('../recurring-journals');

const TIMESTAMPS = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };

const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_2_ID = '55555555-5555-4555-8555-555555555555';
const TEMPLATE_ID = '44444444-4444-4444-8444-444444444444';

const ACCOUNT = {
  id: ACCOUNT_ID,
  code: '6100',
  name: 'Rent expense',
  type: 'expense',
  normalBalance: 'debit',
  parentAccountId: null,
  description: null,
  cashBasisRole: null,
  isActive: true,
  ...TIMESTAMPS,
};

const ACCOUNT_2 = {
  id: ACCOUNT_2_ID,
  code: '2100',
  name: 'Accrued liabilities',
  type: 'liability',
  normalBalance: 'credit',
  parentAccountId: null,
  description: null,
  cashBasisRole: null,
  isActive: true,
  ...TIMESTAMPS,
};

function template(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TEMPLATE_ID,
    name: 'Monthly rent accrual',
    memo: null,
    materializationMode: 'draft',
    frequency: 'monthly',
    intervalCount: 1,
    nextRunDate: '2026-08-01',
    lastRunDate: null,
    endDate: null,
    isActive: true,
    lines: [
      {
        accountId: ACCOUNT_ID,
        side: 'debit',
        amount: '100000',
        contactId: null,
        description: null,
      },
      {
        accountId: ACCOUNT_2_ID,
        side: 'credit',
        amount: '100000',
        contactId: null,
        description: null,
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
      reply: () => ({ status: 200, body: { items: [], nextCursor: null } }),
    },
    {
      method: 'GET',
      path: '/v1/accounts',
      reply: () => ({ status: 200, body: { items: [ACCOUNT, ACCOUNT_2], nextCursor: null } }),
    },
  ];
}

function listRoute(templates: readonly Record<string, unknown>[]): StubRoute {
  return {
    method: 'GET',
    path: '/v1/recurring-journals',
    reply: () => ({ status: 200, body: { items: templates, nextCursor: null } }),
  };
}

describe('RecurringJournalsScreen', () => {
  it('reads cadence and active state off the template rather than deriving them', async () => {
    installApiStub([
      ...referenceRoutes(),
      listRoute([template({ frequency: 'monthly', intervalCount: 2, isActive: true })]),
    ]);
    renderWithQueryClient(<RecurringJournalsScreen />);

    expect(await screen.findByText('Monthly rent accrual')).toBeInTheDocument();
    // `intervalCount: 2` combined with `frequency` the way the template's own author meant
    // it — "Every 2 months", never a bare "Monthly" that drops the multiplier.
    expect(screen.getByText('Every 2 months')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('2026-08-01')).toBeInTheDocument();
  });

  it('shows a paused template with no next run date rather than one the engine will not honour', async () => {
    installApiStub([...referenceRoutes(), listRoute([template({ isActive: false })])]);
    renderWithQueryClient(<RecurringJournalsScreen />);

    expect(await screen.findByText('Monthly rent accrual')).toBeInTheDocument();
    expect(screen.getByText('Paused')).toBeInTheDocument();
    expect(screen.queryByText('2026-08-01')).not.toBeInTheDocument();
  });

  it('creates a template with one idempotency key and the exact balanced body the contract describes', async () => {
    const stub = installApiStub([
      ...referenceRoutes(),
      listRoute([]),
      {
        method: 'POST',
        path: '/v1/recurring-journals',
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
    renderWithQueryClient(<RecurringJournalsScreen />);

    const newButton = await screen.findByRole('button', { name: 'New recurring journal' });
    await waitFor(() => {
      expect(newButton).toBeEnabled();
    });
    await user.click(newButton);

    const dialog = await screen.findByRole('dialog', { name: 'New recurring journal' });

    await user.type(within(dialog).getByLabelText('Name'), 'Monthly rent accrual');

    // `fireEvent.change`, not `user.type`: a native date input has no segmented keyboard
    // model in jsdom to drive one key at a time, `journal-entry.test.tsx`'s own reason for
    // reaching for the same escape hatch on the one control `user-event` cannot drive.
    fireEvent.change(within(dialog).getByLabelText('Start date'), {
      target: { value: '2026-08-01' },
    });

    // The option list opens in its own Radix popover portal, appended alongside the
    // dialog's rather than nested inside it — `within(dialog)` would never find it, the
    // same reason `journal-entry.test.tsx` picks a combobox option off the unscoped
    // `screen`.
    await user.click(within(dialog).getByRole('combobox', { name: 'Account, line 1' }));
    await user.click(await screen.findByText('Rent expense'));
    await user.type(within(dialog).getByLabelText('Debit, line 1'), '1000');

    await user.click(within(dialog).getByRole('combobox', { name: 'Account, line 2' }));
    await user.click(await screen.findByText('Accrued liabilities'));
    await user.type(within(dialog).getByLabelText('Credit, line 2'), '1000');

    await user.click(within(dialog).getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(stub.keysFor('POST', '/v1/recurring-journals')).toHaveLength(1);
    });
    const created = stub.calls.find((call) => call.method === 'POST');
    expect(created?.body).toEqual({
      name: 'Monthly rent accrual',
      memo: null,
      materializationMode: 'draft',
      frequency: 'monthly',
      intervalCount: 1,
      startDate: '2026-08-01',
      endDate: null,
      lines: [
        {
          accountId: ACCOUNT_ID,
          side: 'debit',
          amount: '100000',
          contactId: null,
          description: null,
        },
        {
          accountId: ACCOUNT_2_ID,
          side: 'credit',
          amount: '100000',
          contactId: null,
          description: null,
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
        path: '/v1/recurring-journals/:templateId',
        reply: ({ body }) => ({
          status: 200,
          body: { ...template({ isActive: true }), ...(body as object) },
        }),
      },
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<RecurringJournalsScreen />);

    await user.click(await screen.findByRole('button', { name: 'Pause Monthly rent accrual' }));

    await waitFor(() => {
      expect(stub.calls.some((call) => call.method === 'PATCH')).toBe(true);
    });
    const patch = stub.calls.find((call) => call.method === 'PATCH');
    expect(patch?.body).toEqual({ isActive: false });
    expect(stub.calls.some((call) => call.method === 'POST')).toBe(false);
    expect(patch?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });
});
