import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The generated client is a module singleton that captures `globalThis.fetch` and its base
 * URL when `src/api/client.ts` is evaluated, so both stubs have to be in place *before* the
 * imports below run — hence `vi.hoisted`. The base URL is stubbed because jsdom leaves
 * Node's `fetch` in place and `new Request('/v1/payments')` there is an invalid URL.
 *
 * Nothing else is mocked. The screen, the query hooks, the generated client and the
 * component layer are all the real ones; what is replaced is the network, at the one
 * boundary spec §12 says this package owns.
 */
const { fetchMock } = vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', 'http://openbooks.test');
  const fetchMock = vi.fn<(request: Request) => Promise<Response>>();
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock };
});

import { createQueryClient } from '../../query/client';
import { MoneyInScreen } from '../money-in';
import type { Aging, Payment, PaymentSummary } from './queries';

type Route = (request: Request, url: URL) => Response | Promise<Response>;

const routes = new Map<string, Route>();

function stub(method: string, pathname: string, route: Route): void {
  routes.set(`${method} ${pathname}`, route);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The envelope every non-2xx on this API carries (`errorResponseSchema`). */
function apiError(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): Response {
  return json(status, {
    error: { code, message, ...(details === undefined ? {} : { details }) },
  });
}

const ACME = '11111111-1111-4111-8111-111111111111';
const BANK = '22222222-2222-4222-8222-222222222222';
const PAYMENT = '33333333-3333-4333-8333-333333333333';
const INVOICE = '44444444-4444-4444-8444-444444444444';

function stubDirectories(): void {
  stub('GET', '/v1/contacts', () =>
    json(200, {
      items: [
        {
          id: ACME,
          code: 'C-100',
          displayName: 'Acme Supplies',
          legalName: null,
          email: null,
          phone: null,
          isCustomer: true,
          isVendor: false,
          notes: null,
          isActive: true,
          createdAt: '2026-01-05T09:00:00.000Z',
          updatedAt: '2026-01-05T09:00:00.000Z',
        },
      ],
      nextCursor: null,
    }),
  );

  stub('GET', '/v1/accounts', () =>
    json(200, {
      items: [
        {
          id: BANK,
          code: '1000',
          name: 'Operating bank account',
          description: null,
          type: 'asset',
          normalBalance: 'debit',
          parentAccountId: null,
          isActive: true,
          createdAt: '2026-01-05T09:00:00.000Z',
          updatedAt: '2026-01-05T09:00:00.000Z',
        },
      ],
      nextCursor: null,
    }),
  );
}

function payment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: PAYMENT,
    direction: 'received',
    contactId: ACME,
    date: '2026-03-02',
    amount: '150000',
    accountId: BANK,
    reference: 'BACS 8841',
    memo: null,
    status: 'recorded',
    settlement: { allocated: '0', outstanding: '150000' },
    allocations: [],
    journalId: '55555555-5555-4555-8555-555555555555',
    voidJournalId: null,
    createdAt: '2026-03-02T09:00:00.000Z',
    updatedAt: '2026-03-02T09:00:00.000Z',
    ...overrides,
  };
}

function summaryOf(full: Payment): PaymentSummary {
  return {
    id: full.id,
    direction: full.direction,
    contactId: full.contactId,
    date: full.date,
    amount: full.amount,
    accountId: full.accountId,
    reference: full.reference,
    status: full.status,
    settlement: full.settlement,
    createdAt: full.createdAt,
  };
}

function renderScreen(): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MoneyInScreen />
    </QueryClientProvider>,
  );
}

function requestsTo(method: string, pathname: string): Request[] {
  return fetchMock.mock.calls
    .map(([request]) => request)
    .filter((request) => request.method === method && new URL(request.url).pathname === pathname);
}

beforeEach(() => {
  routes.clear();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (request) => {
    const url = new URL(request.url);
    const route = routes.get(`${request.method} ${url.pathname}`);
    if (route === undefined) {
      throw new Error(`The test stubbed no route for ${request.method} ${url.pathname}.`);
    }
    return route(request, url);
  });
});

describe('MoneyInScreen — payments', () => {
  /**
   * D-37, end to end, and the case the whole screen is shaped around: a deposit arrives
   * before anyone has decided what it settles.
   *
   * The form must not require an invoice, the request must not invent one — an empty
   * `allocations` array is a different request from an absent one and would be a claim the
   * user made a decision — and what comes back must be presented as money on account
   * rather than as an incomplete entry.
   */
  it('records a payment against no invoice and presents the whole of it as credit', async () => {
    const user = userEvent.setup();
    const recorded = payment();
    let listed: readonly PaymentSummary[] = [];

    stubDirectories();
    stub('GET', '/v1/payments', () => json(200, { items: listed, nextCursor: null }));
    stub('POST', '/v1/payments', () => {
      listed = [summaryOf(recorded)];
      return json(201, recorded);
    });
    stub('GET', `/v1/payments/${PAYMENT}`, () => json(200, recorded));

    renderScreen();
    expect(await screen.findByText('No payments match these filters.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Record payment' }));
    const form = await screen.findByRole('dialog', { name: 'Record a payment' });

    await user.click(within(form).getByRole('combobox', { name: 'Contact' }));
    // The listbox is portalled to the body by Radix's Popover, so it is not `within(form)`.
    // The option's accessible name carries its detail column — the contact's code — too.
    await user.click(await screen.findByRole('option', { name: /Acme Supplies/ }));

    await user.type(within(form).getByRole('textbox', { name: 'Amount' }), '1500');

    await user.click(within(form).getByRole('combobox', { name: 'Account' }));
    await user.click(await screen.findByRole('option', { name: /Operating bank account/ }));

    // Nothing was chosen to apply it to, and the form never asked.
    expect(within(form).queryByRole('table')).toBeNull();

    await user.click(within(form).getByRole('button', { name: 'Record payment' }));

    const [posted] = requestsTo('POST', '/v1/payments');
    expect(posted).toBeDefined();
    const body: unknown = await posted?.clone().json();
    expect(body).toMatchObject({
      direction: 'received',
      contactId: ACME,
      accountId: BANK,
      // Cents, never a decimal and never a JSON number (D-13).
      amount: '150000',
    });
    expect(Object.keys(body as Record<string, unknown>)).not.toContain('allocations');
    // Every write carries a key, minted where the user's intent was formed.
    expect(posted?.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);

    const panel = await screen.findByRole('region', { name: 'Payment detail' });
    expect(panel).toHaveTextContent('1500.00 on account');
    expect(panel).toHaveTextContent(/it can be applied to any of their documents/);
    expect(
      within(panel).getByText(/Nothing has been applied from this payment yet/),
    ).toBeInTheDocument();
  });

  /**
   * The asymmetry, at the only layer a user meets it: over-allocating a document is refused
   * (C3) while over-paying is fine. The refusal has to arrive as something the user can act
   * on — the server's own message states the figures in minor units, which read as a
   * hundredfold error — and the repair has to leave the difference where D-37 puts it.
   */
  it('renders an over-allocation refusal with the repair that leaves the rest as credit', async () => {
    const user = userEvent.setup();
    const existing = payment();

    stubDirectories();
    stub('GET', '/v1/payments', () =>
      json(200, { items: [summaryOf(existing)], nextCursor: null }),
    );
    stub('GET', `/v1/payments/${PAYMENT}`, () => json(200, existing));
    stub('GET', '/v1/invoices', (_request, url) =>
      json(200, {
        items:
          url.searchParams.get('status') === 'approved'
            ? [
                {
                  id: INVOICE,
                  contactId: ACME,
                  documentNumber: 'INV-1004',
                  reference: null,
                  issueDate: '2026-02-01',
                  dueDate: '2026-03-03',
                  status: 'approved',
                  totals: {
                    subtotal: '50000',
                    tax: '0',
                    total: '50000',
                    taxSummary: [],
                  },
                  settlement: { allocated: '0', outstanding: '50000' },
                  createdAt: '2026-02-01T09:00:00.000Z',
                  updatedAt: '2026-02-01T09:00:00.000Z',
                },
              ]
            : [],
        nextCursor: null,
      }),
    );
    stub('POST', `/v1/payments/${PAYMENT}/allocations`, () =>
      apiError(
        412,
        'precondition_failed',
        'This document has 50000 minor units outstanding and the allocation is for 80000.',
        { precondition: 'document_over_allocated' },
      ),
    );

    renderScreen();
    await user.click(
      await screen.findByRole('button', { name: 'Open the 2026-03-02 payment for Acme Supplies' }),
    );
    await user.click(await screen.findByRole('button', { name: 'Apply this credit' }));

    const amountField = await screen.findByRole('textbox', {
      name: 'Amount to apply to INV-1004',
    });
    await user.type(amountField, '800');

    // The warning is advisory and does not block: this screen's copy of `outstanding` was
    // read when the list was fetched, and the refusal that decides is the server's.
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    const refusal = await screen.findByRole('alert');
    expect(refusal).toHaveTextContent('One document was asked to settle more than it owes');
    // Formatted, not the server's minor units.
    expect(refusal).toHaveTextContent('INV-1004 has 500.00 outstanding and was asked for 800.00');
    expect(refusal).toHaveTextContent(/the rest stays as credit on the contact/);

    await user.click(
      within(refusal).getByRole('button', { name: 'Reduce to what is outstanding' }),
    );

    expect(await screen.findByRole('textbox', { name: 'Amount to apply to INV-1004' })).toHaveValue(
      '500.00',
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  /**
   * The early-pay discount suggestion (OB-138; ROADMAP D-79, D-81), surfaced beside an
   * eligible invoice the way `multi-entry-dialog.tsx` surfaces it on the bank-match
   * workbench — "the money-in screen remains for receipts not in the feed" is D-81's own
   * words for why this screen needs the same suggestion. Read-only here: `allocation-
   * editor.tsx`'s own note explains the gap this stops short of — there is no write path
   * yet to confirm a discount on a manual receipt, only on a bank-match clearing entry.
   */
  it('shows an early-pay discount suggestion next to an eligible invoice', async () => {
    const user = userEvent.setup();
    const existing = payment();

    stubDirectories();
    stub('GET', '/v1/payments', () =>
      json(200, { items: [summaryOf(existing)], nextCursor: null }),
    );
    stub('GET', `/v1/payments/${PAYMENT}`, () => json(200, existing));
    stub('GET', '/v1/invoices', (_request, url) =>
      json(200, {
        items:
          url.searchParams.get('status') === 'approved'
            ? [
                {
                  id: INVOICE,
                  contactId: ACME,
                  documentNumber: 'INV-1004',
                  reference: null,
                  issueDate: '2026-02-01',
                  dueDate: '2026-03-03',
                  status: 'approved',
                  totals: { subtotal: '50000', tax: '0', total: '50000', taxSummary: [] },
                  settlement: { allocated: '0', outstanding: '50000' },
                  createdAt: '2026-02-01T09:00:00.000Z',
                  updatedAt: '2026-02-01T09:00:00.000Z',
                },
              ]
            : [],
        nextCursor: null,
      }),
    );
    stub('GET', '/v1/payment-terms/discount-suggestion', () =>
      json(200, {
        targetId: INVOICE,
        discountAmountMinor: '1000',
        deadline: '2026-03-08',
        accountId: '99999999-9999-4999-8999-999999999999',
      }),
    );

    renderScreen();
    await user.click(
      await screen.findByRole('button', { name: 'Open the 2026-03-02 payment for Acme Supplies' }),
    );
    await user.click(await screen.findByRole('button', { name: 'Apply this credit' }));

    const hint = await screen.findByText(/Eligible for an early-pay discount/);
    expect(hint).toHaveTextContent('10.00');
    expect(hint).toHaveTextContent('2026-03-08');

    // Informational only: nothing on this row claims to apply it.
    expect(screen.queryByRole('button', { name: /discount/i })).toBeNull();
  });

  /**
   * Presence of `nextCursor` is the only signal that another page exists — a full page does
   * not imply one — and the cursor goes back verbatim (D-21).
   */
  it('pages on the cursor it was given, and only when it was given one', async () => {
    const user = userEvent.setup();
    const first = payment({ date: '2026-03-02' });
    const second = payment({
      id: '66666666-6666-4666-8666-666666666666',
      date: '2026-03-09',
      reference: 'BACS 8902',
    });

    stubDirectories();
    stub('GET', '/v1/payments', (_request, url) =>
      url.searchParams.get('cursor') === 'cursor-abc'
        ? json(200, { items: [summaryOf(second)], nextCursor: null })
        : json(200, { items: [summaryOf(first)], nextCursor: 'cursor-abc' }),
    );

    renderScreen();
    await user.click(await screen.findByRole('button', { name: 'Load more' }));

    expect(
      await screen.findByRole('button', { name: 'Open the 2026-03-09 payment for Acme Supplies' }),
    ).toBeInTheDocument();
    expect(
      requestsTo('GET', '/v1/payments').some(
        (request) => new URL(request.url).searchParams.get('cursor') === 'cursor-abc',
      ),
    ).toBe(true);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });
});

describe('MoneyInScreen — aging', () => {
  /**
   * The credit note in the response is deliberately handed over **first**, ahead of the
   * overdue invoice.
   *
   * The server sorts a contact's documents with the credits last, and this asserts the page
   * does not merely inherit that: the credit rows are rendered under a heading of their own,
   * so the section is decided here rather than by an ordering decided elsewhere. What must
   * hold is D-40's shape — a negative amount, no due date, no age, and last.
   */
  function stubAging(): void {
    const report: Aging = {
      asOf: '2026-03-31',
      ledger: 'receivable',
      rows: [
        {
          contactId: ACME,
          contactName: 'Acme Supplies',
          amounts: {
            current: '-75000',
            days1To30: '50000',
            days31To60: '0',
            days61To90: '0',
            days90Plus: '0',
            total: '-25000',
          },
          documents: [
            {
              documentType: 'payment',
              documentId: PAYMENT,
              documentNumber: '7',
              reference: 'BACS 8841',
              issueDate: '2026-03-02',
              dueDate: null,
              total: '-150000',
              outstanding: '-75000',
              daysPastDue: null,
              bucket: 'current',
            },
            {
              documentType: 'invoice',
              documentId: INVOICE,
              documentNumber: 'INV-1004',
              reference: null,
              issueDate: '2026-02-01',
              dueDate: '2026-03-03',
              total: '50000',
              outstanding: '50000',
              daysPastDue: 28,
              bucket: 'days1To30',
            },
          ],
        },
      ],
      totals: {
        current: '-75000',
        days1To30: '50000',
        days31To60: '0',
        days61To90: '0',
        days90Plus: '0',
        total: '-25000',
      },
    };

    stub('GET', '/v1/reports/aging', (_request, url) =>
      json(200, {
        ...report,
        rows: report.rows.map((row) => ({
          ...row,
          documents: url.searchParams.get('detail') === 'true' ? row.documents : null,
        })),
      }),
    );
  }

  it('shows unapplied credit as a negative row of its own, last, and never netted', async () => {
    const user = userEvent.setup();
    stubDirectories();
    stub('GET', '/v1/payments', () => json(200, { items: [], nextCursor: null }));
    stubAging();

    renderScreen();
    await user.click(screen.getByRole('button', { name: 'Aging' }));
    await user.click(
      await screen.findByRole('checkbox', { name: 'Show the documents behind each row' }),
    );

    const detail = await screen.findByRole('table', { name: /Open items for Acme Supplies/ });
    const rows = within(detail).getAllByRole('row');
    const text = rows.map((row) => row.textContent ?? '');

    const invoiceRow = text.findIndex((row) => row.includes('INV-1004'));
    const heading = text.findIndex((row) => row.includes('Money on account'));
    const creditRow = text.findIndex((row) => row.includes('Payment on account'));

    expect(invoiceRow).toBeGreaterThan(-1);
    // Last, behind the heading that says what it is, whatever order the server sent it in.
    expect(heading).toBeGreaterThan(invoiceRow);
    expect(creditRow).toBeGreaterThan(heading);

    // Negative, and not netted against the 500.00 invoice above it.
    expect(rows[creditRow]).toHaveTextContent('-750.00');
    expect(rows[invoiceRow]).toHaveTextContent('500.00');
    expect(rows[creditRow]).toHaveTextContent('Not chased');
    expect(detail).toHaveTextContent(/netting would invent an allocation nobody made/);
  });

  /**
   * D-40: aging is computed **as at** a date, so the control re-asks the server rather than
   * narrowing what is loaded. A client-side filter would use today's allocations against a
   * past date's documents and produce a figure nobody could reproduce.
   */
  it('re-asks the server when the as-at date changes', async () => {
    const user = userEvent.setup();
    stubDirectories();
    stub('GET', '/v1/payments', () => json(200, { items: [], nextCursor: null }));
    stubAging();

    renderScreen();
    await user.click(screen.getByRole('button', { name: 'Aging' }));
    await screen.findByRole('table', { name: 'Aging by contact and bucket' });

    const asOf = screen.getByLabelText('As at');
    await user.clear(asOf);
    await user.type(asOf, '2026-02-28');

    await vi.waitFor(() => {
      const asked = requestsTo('GET', '/v1/reports/aging').map((request) =>
        new URL(request.url).searchParams.get('asOf'),
      );
      expect(asked).toContain('2026-02-28');
    });
  });
});
