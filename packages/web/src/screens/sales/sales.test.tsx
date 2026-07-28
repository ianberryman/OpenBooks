import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * OB-068's tests. Three properties, each of which is a decision the screen would silently
 * stop honouring if it regressed:
 *
 * 1. **Approve carries one key however many times it is clicked** (D-38). Approval posts a
 *    journal and allocates a gapless number; a second key would be a second claim, and
 *    nothing downstream could tell it from a deliberate second document.
 * 2. **`status` is never written.** It is derived on read (D-38), so a `PATCH` naming it
 *    would publish a contract in which a computed value is writable. The assertion is over
 *    every request the screen makes, not over one call site.
 * 3. **The `document_has_allocations` refusal renders as something to do.** Voiding a document
 *    with allocations against it is refused because the reversal would leave the payment
 *    reading as applied against a receivable that no longer exists; the recovery is to
 *    un-apply first, and the screen has to say so and offer it.
 *
 * The generated client is a module singleton that captures `globalThis.fetch` and its base
 * URL when `src/api/client.ts` is evaluated, so both stubs have to be in place *before* the
 * imports below run — hence `vi.hoisted`. Nothing else is mocked: the screen, the query
 * hooks, the generated client and the component layer are all the real ones, and what is
 * replaced is the network, at the one boundary spec §12 says this package owns.
 */
const { fetchMock } = vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', 'http://openbooks.test');
  const fetchMock = vi.fn<(request: Request) => Promise<Response>>();
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock };
});

import { createQueryClient } from '../../query/client';
import { SalesScreen } from '../sales';
import type { Account, Allocation, Contact, Invoice, TaxRate } from './queries';

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

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
const TAX_RATE_ID = '33333333-3333-4333-8333-333333333333';
const INVOICE_ID = '44444444-4444-4444-8444-444444444444';
const ALLOCATION_ID = '55555555-5555-4555-8555-555555555555';

const CUSTOMER: Contact = {
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
  createdAt: '2026-01-05T09:00:00.000Z',
  updatedAt: '2026-01-05T09:00:00.000Z',
};

const ACCOUNT: Account = {
  id: ACCOUNT_ID,
  code: '4000',
  name: 'Sales',
  type: 'revenue',
  normalBalance: 'credit',
  parentAccountId: null,
  description: null,
  cashBasisRole: null,
  isActive: true,
  createdAt: '2026-01-05T09:00:00.000Z',
  updatedAt: '2026-01-05T09:00:00.000Z',
};

const TAX_RATE: TaxRate = {
  id: TAX_RATE_ID,
  name: 'VAT 20%',
  percentage: '20',
  accountId: ACCOUNT_ID,
  appliesTo: 'sales',
  isActive: true,
  createdAt: '2026-01-05T09:00:00.000Z',
  updatedAt: '2026-01-05T09:00:00.000Z',
};

const ALLOCATION: Allocation = {
  id: ALLOCATION_ID,
  sourceType: 'payment',
  sourceId: '66666666-6666-4666-8666-666666666666',
  sourceNumber: null,
  targetType: 'invoice',
  targetId: INVOICE_ID,
  targetNumber: 'INV-0001',
  amount: '30000',
  date: '2026-02-10',
  createdAt: '2026-02-10T09:00:00.000Z',
};

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: INVOICE_ID,
    documentNumber: null,
    reference: null,
    contactId: CUSTOMER_ID,
    issueDate: '2026-02-01',
    dueDate: '2026-03-03',
    taxMode: 'exclusive',
    status: 'draft',
    memo: null,
    lines: [
      {
        lineId: '1',
        lineNumber: 1,
        description: 'Consulting',
        quantity: '1',
        unitAmount: '100000',
        accountId: ACCOUNT_ID,
        taxRateId: TAX_RATE_ID,
        taxRatePercentage: '20',
        netAmount: '100000',
        taxAmount: '20000',
        grossAmount: '120000',
        dimensionValueIds: [],
      },
    ],
    totals: { net: '100000', tax: '20000', gross: '120000' },
    taxSummary: [
      {
        taxRateId: TAX_RATE_ID,
        taxRateName: 'VAT 20%',
        percentage: '20',
        net: '100000',
        tax: '20000',
      },
    ],
    settlement: { allocated: '0', outstanding: '120000' },
    allocations: [],
    journalId: null,
    voidJournalId: null,
    createdAt: '2026-02-01T09:00:00.000Z',
    updatedAt: '2026-02-01T09:00:00.000Z',
    ...overrides,
  };
}

function summaryOf(source: Invoice): Record<string, unknown> {
  const { lines: _lines, taxSummary: _taxSummary, allocations: _allocations, ...rest } = source;
  return rest;
}

function stubReferenceData(): void {
  stub('GET', '/v1/contacts', () => json(200, { items: [CUSTOMER], nextCursor: null }));
  stub('GET', '/v1/accounts', () => json(200, { items: [ACCOUNT], nextCursor: null }));
  stub('GET', '/v1/tax-rates', () => json(200, { items: [TAX_RATE], nextCursor: null }));
  stub('GET', '/v1/credit-notes', () => json(200, { items: [], nextCursor: null }));
}

function renderScreen(): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <SalesScreen />
    </QueryClientProvider>,
  );
}

function requestsTo(method: string, pathname: string): Request[] {
  return fetchMock.mock.calls
    .map(([request]) => request)
    .filter((request) => request.method === method && new URL(request.url).pathname === pathname);
}

/** Cloned, because the route handler and the assertion both want to read it. */
async function bodyOf(request: Request): Promise<unknown> {
  return request.clone().json();
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

/** Opens the one invoice on the list and waits for its editor or view to mount. */
async function openTheInvoice(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  renderScreen();
  const link = await screen.findByRole('button', { name: /INV-0001|Draft/ });
  await user.click(link);
}

async function confirmDialog(
  user: ReturnType<typeof userEvent.setup>,
  buttonName: string | RegExp,
): Promise<void> {
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: buttonName }));
}

describe('SalesScreen', () => {
  /**
   * The property the idempotency header exists for, at the one call site where getting it
   * wrong is unrecoverable: approval allocates a gapless number and posts a journal, and
   * the ledger holds no `UPDATE` grant that could take either back (A6).
   *
   * The first attempt is refused by a server fault, which is exactly the case a user
   * answers by clicking again — and the two attempts must be the *same* claim, so the
   * server can tell "asked twice" from "the response was lost".
   */
  it('sends one idempotency key across repeated Approve clicks', async () => {
    const user = userEvent.setup();
    const draft = invoice();
    let attempts = 0;

    stubReferenceData();
    stub('GET', '/v1/invoices', () => json(200, { items: [summaryOf(draft)], nextCursor: null }));
    stub('GET', `/v1/invoices/${INVOICE_ID}`, () => json(200, draft));
    stub('POST', `/v1/invoices/${INVOICE_ID}/approve`, () => {
      attempts += 1;
      if (attempts === 1) {
        return apiError(500, 'internal_error', 'An internal error occurred.');
      }
      return json(200, {
        ...draft,
        status: 'approved',
        documentNumber: 'INV-0001',
        journalId: '77777777-7777-4777-8777-777777777777',
      });
    });

    await openTheInvoice(user);

    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    await confirmDialog(user, 'Approve');
    await screen.findByRole('alert');

    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    await confirmDialog(user, 'Approve');
    await screen.findByText('INV-0001');

    const approvals = requestsTo('POST', `/v1/invoices/${INVOICE_ID}/approve`);
    expect(approvals).toHaveLength(2);

    const keys = approvals.map((request) => request.headers.get('idempotency-key'));
    expect(keys[0]).toEqual(expect.any(String));
    expect(keys[0]).not.toBe('');
    // The whole assertion: the second attempt is the first attempt again, not a second
    // request that happens to do the same thing.
    expect(keys[1]).toBe(keys[0]);
  });

  /**
   * `status` is computed from the journals and the allocations on every read (D-38), so
   * there is no column to set and the API publishes no field for one. Approving is a
   * `POST` on its own path.
   *
   * Asserted over *every* request the screen made rather than over one call site, so a
   * future edit that reached for `PATCH { status }` anywhere — the list, the view, an
   * optimistic update — fails here.
   */
  it('never uses PATCH to change status, and approves on its own path', async () => {
    const user = userEvent.setup();
    const draft = invoice();

    stubReferenceData();
    stub('GET', '/v1/invoices', () => json(200, { items: [summaryOf(draft)], nextCursor: null }));
    stub('GET', `/v1/invoices/${INVOICE_ID}`, () => json(200, draft));
    stub('PATCH', `/v1/invoices/${INVOICE_ID}`, () => json(200, { ...draft, memo: 'Q1 retainer' }));
    stub('POST', `/v1/invoices/${INVOICE_ID}/approve`, () =>
      json(200, { ...draft, status: 'approved', documentNumber: 'INV-0001' }),
    );

    await openTheInvoice(user);

    await user.type(await screen.findByLabelText('Memo'), 'Q1 retainer');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => {
      expect(requestsTo('PATCH', `/v1/invoices/${INVOICE_ID}`)).toHaveLength(1);
    });

    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await confirmDialog(user, 'Approve');
    await screen.findByText('INV-0001');

    const patches = requestsTo('PATCH', `/v1/invoices/${INVOICE_ID}`);
    expect(patches.length).toBeGreaterThan(0);
    for (const patch of patches) {
      const body = await bodyOf(patch);
      expect(body).toBeTypeOf('object');
      expect(Object.keys(body as Record<string, unknown>)).not.toContain('status');
    }

    // And every write went out with a key, because the generated client refuses one
    // without.
    for (const request of [
      ...patches,
      ...requestsTo('POST', `/v1/invoices/${INVOICE_ID}/approve`),
    ]) {
      expect(request.headers.get('idempotency-key')).toBeTruthy();
    }

    expect(requestsTo('POST', `/v1/invoices/${INVOICE_ID}/approve`)).toHaveLength(1);
  });

  /**
   * The refusal that must not read as a dead end. The server's own message names the
   * count; the screen adds the reason and puts the un-apply control next to it, because
   * "remove the allocation first" is only actionable if the allocations are on screen.
   */
  it('renders the void-with-allocations refusal as something to act on', async () => {
    const user = userEvent.setup();
    const approved = invoice({
      status: 'part_paid',
      documentNumber: 'INV-0001',
      journalId: '77777777-7777-4777-8777-777777777777',
      allocations: [ALLOCATION],
      settlement: { allocated: '30000', outstanding: '90000' },
    });

    stubReferenceData();
    stub('GET', '/v1/invoices', () =>
      json(200, { items: [summaryOf(approved)], nextCursor: null }),
    );
    stub('GET', `/v1/invoices/${INVOICE_ID}`, () => json(200, approved));
    stub('POST', `/v1/invoices/${INVOICE_ID}/void`, () =>
      apiError(
        412,
        'precondition_failed',
        'This invoice has 1 allocation(s) against it. Remove them first: voiding reverses the ' +
          'journal, and an allocation left pointing at a voided document would make the ' +
          'subledger disagree with the control account by exactly the amount applied.',
        { precondition: 'document_has_allocations' },
      ),
    );

    await openTheInvoice(user);

    await user.click(await screen.findByRole('button', { name: 'Void' }));
    await confirmDialog(user, 'Void');

    const alert = await screen.findByRole('alert');
    // The server's own prose, preferred over the generic presentation for exactly the
    // codes where specificity is the value (`presentApiError`).
    expect(alert).toHaveTextContent(/Remove them first/);
    // The recovery, named on the screen rather than left to be inferred.
    expect(alert).toHaveTextContent(/Un-apply the allocations listed below/);

    // And the recovery is reachable, not merely described.
    expect(screen.getByRole('button', { name: 'Un-apply' })).toBeEnabled();
  });

  /**
   * D-39 as a shape: a credit note is its own series with its own list, and applying it is
   * a separate act from approving it. The tab is what makes that visible — the screen must
   * not present a credit as an invoice with a minus sign.
   */
  it('lists credit notes as their own series, not as negative invoices', async () => {
    const user = userEvent.setup();

    stubReferenceData();
    stub('GET', '/v1/invoices', () => json(200, { items: [], nextCursor: null }));
    stub('GET', '/v1/credit-notes', () =>
      json(200, {
        items: [
          {
            id: '88888888-8888-4888-8888-888888888888',
            documentNumber: 'CN-0001',
            reference: null,
            contactId: CUSTOMER_ID,
            issueDate: '2026-02-05',
            status: 'approved',
            totals: { net: '20000', tax: '4000', gross: '24000' },
            settlement: { allocated: '0', outstanding: '24000' },
            createdAt: '2026-02-05T09:00:00.000Z',
            updatedAt: '2026-02-05T09:00:00.000Z',
          },
        ],
        nextCursor: null,
      }),
    );

    renderScreen();

    await user.click(await screen.findByRole('tab', { name: 'Credit notes' }));

    expect(await screen.findByText('CN-0001')).toBeInTheDocument();
    // Read straight off `settlement.outstanding`, and labelled as what it means on a
    // credit note — the same arithmetic as an invoice's "still owed" (D-34, D-39).
    expect(screen.getByRole('columnheader', { name: 'Credit available' })).toBeInTheDocument();
    // Twice: the total and what is left of it, and they agree because nothing has been
    // applied. Both are formatted from cents by string manipulation (D-13) — `24000 / 100`
    // is where a rendered `239.99999999999997` would come from.
    expect(screen.getAllByText('240.00')).toHaveLength(2);
    // A credit note has no due date, so the column does not exist on this tab.
    expect(screen.queryByRole('columnheader', { name: 'Due' })).not.toBeInTheDocument();
  });
});
