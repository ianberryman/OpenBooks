import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PurchasesScreen } from '../purchases';
import type { Account, Bill, Contact, TaxRate, VendorCredit } from './queries';

/**
 * The purchases screen against a stubbed API (OB-069, harness from OB-058).
 *
 * jsdom is not a browser and nothing here is a claim about layout. What is answerable at
 * this level is the part of this screen that is a pure function of events and requests,
 * and on an AP screen that is the part which costs money to get wrong:
 *
 *  - the **identity of the key** on Approve, because a second key on a double-clicked
 *    Approve is a second journal against the payables control account;
 *  - the **duplicate-vendor-reference refusal** reading as a question with somewhere to
 *    go, rather than as a validation error whose reflex is to edit the number until the
 *    red box goes away — and that number is the vendor's, not ours to invent (D-36);
 *  - the **reference field naming whose number it holds**, which is the one mistake on
 *    this screen that nothing downstream complains about;
 *  - and that **nothing is priced in the browser** (D-35) or derived from allocations
 *    (D-34).
 *
 * The globals are replaced before the imports for `journal-entry.test.tsx`'s reason:
 * `openapi-fetch` captures `globalThis.fetch` and `globalThis.Request` when the client
 * singleton is created at module evaluation, so stubbing afterwards is too late.
 */
const harness = vi.hoisted(() => {
  const ORIGIN = 'http://localhost:3000';
  const NativeRequest = globalThis.Request;

  class RelativeRequest extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(typeof input === 'string' ? new URL(input, ORIGIN) : input, init);
    }
  }
  globalThis.Request = RelativeRequest;

  let handler: ((request: Request) => Promise<Response>) | null = null;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (handler === null) throw new Error('No API double is installed for this test.');
    return handler(input instanceof Request ? input : new Request(input, init));
  };

  return {
    install(next: (request: Request) => Promise<Response>): void {
      handler = next;
    },
  };
});

// --- Fixtures ---------------------------------------------------------------

const TIMESTAMP = '2026-07-01T00:00:00.000Z';

const EXPENSE: Account = {
  id: 'acc-office',
  code: '6-1000',
  name: 'Office supplies',
  description: null,
  isActive: true,
  normalBalance: 'debit',
  parentAccountId: null,
  type: 'expense',
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const VENDOR: Contact = {
  id: 'contact-acme',
  code: 'ACME',
  displayName: 'Acme Supplies',
  email: null,
  isActive: true,
  isCustomer: false,
  isVendor: true,
  legalName: null,
  notes: null,
  phone: null,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const PURCHASE_TAX: TaxRate = {
  id: 'rate-vat',
  name: 'VAT 20%',
  percentage: '20',
  accountId: 'acc-vat',
  appliesTo: 'purchases',
  isActive: true,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const BILL_ID = 'bill-0001';
/** The **vendor's** number, and the string the whole D-36 argument is about. */
const VENDOR_INVOICE_NUMBER = 'INV-1001';

function draftBill(): Bill {
  return {
    id: BILL_ID,
    // Null until approval: a number reserved by a draft that was then discarded would
    // leave a gap, and a gap is indistinguishable from a deletion (D-36).
    documentNumber: null,
    reference: VENDOR_INVOICE_NUMBER,
    contactId: VENDOR.id,
    issueDate: '2026-07-01',
    dueDate: '2026-07-31',
    taxMode: 'exclusive',
    status: 'draft',
    memo: null,
    lines: [
      {
        lineId: '1',
        lineNumber: 1,
        description: 'Paper',
        quantity: '1',
        unitAmount: '150000',
        accountId: EXPENSE.id,
        taxRateId: null,
        taxRatePercentage: null,
        netAmount: '150000',
        taxAmount: '0',
        grossAmount: '150000',
        dimensionValueIds: [],
      },
    ],
    totals: { net: '150000', tax: '0', gross: '150000' },
    taxSummary: [{ taxRateId: null, taxRateName: null, percentage: null, net: '150000', tax: '0' }],
    settlement: { allocated: '0', outstanding: '150000' },
    allocations: [],
    journalId: null,
    voidJournalId: null,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function approvedBill(): Bill {
  return {
    ...draftBill(),
    documentNumber: '1',
    status: 'approved',
    journalId: 'journal-0001',
  };
}

const CREDIT_ID = 'vc-0001';

/**
 * A vendor credit is a **document, not a negative bill** (D-39): its own number series,
 * its own journal, positive lines, and no due date — nothing about one falls due.
 */
function approvedVendorCredit(): VendorCredit {
  return {
    id: CREDIT_ID,
    documentNumber: '7',
    reference: 'CN-55',
    contactId: VENDOR.id,
    issueDate: '2026-07-05',
    taxMode: 'exclusive',
    status: 'approved',
    memo: null,
    lines: [
      {
        lineId: '11',
        lineNumber: 1,
        description: 'Returned paper',
        quantity: '1',
        unitAmount: '50000',
        accountId: EXPENSE.id,
        taxRateId: null,
        taxRatePercentage: null,
        netAmount: '50000',
        taxAmount: '0',
        grossAmount: '50000',
        dimensionValueIds: [],
      },
    ],
    totals: { net: '50000', tax: '0', gross: '50000' },
    taxSummary: [{ taxRateId: null, taxRateName: null, percentage: null, net: '50000', tax: '0' }],
    settlement: { allocated: '0', outstanding: '50000' },
    allocations: [],
    journalId: 'journal-0002',
    voidJournalId: null,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

// --- The API double ---------------------------------------------------------

interface RecordedCall {
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly idempotencyKey: string | null;
  readonly body: unknown;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function apiError(code: string, message: string, details?: unknown): unknown {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}

const DUPLICATE_MESSAGE =
  "This vendor's invoice number is already on approved bill 1. Entering the same vendor " +
  'invoice twice is how a supplier gets paid twice, and neither total would look wrong.';

function duplicateRefusal(): Response {
  return json(
    412,
    apiError('precondition_failed', DUPLICATE_MESSAGE, {
      precondition: 'duplicate_vendor_reference',
    }),
  );
}

function page(items: readonly unknown[]): Response {
  return json(200, { items, nextCursor: null });
}

function parseJson(text: string): unknown {
  return text === '' ? null : (JSON.parse(text) as unknown);
}

interface ApiDouble {
  readonly calls: readonly RecordedCall[];
  readonly handle: (request: Request) => Promise<Response>;
  setApproveResponse: (respond: () => Response | Promise<Response>) => void;
  setBill: (bill: Bill) => void;
  setVendorCredits: (credits: readonly VendorCredit[]) => void;
}

function createApiDouble(): ApiDouble {
  const calls: RecordedCall[] = [];
  let bill = draftBill();
  let vendorCredits: readonly VendorCredit[] = [];
  let approveResponse: () => Response | Promise<Response> = () => json(200, approvedBill());

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const body = parseJson(await request.text());
    calls.push({
      method,
      path: url.pathname,
      query: url.search,
      idempotencyKey: request.headers.get('idempotency-key'),
      body,
    });

    const { pathname } = url;

    if (method === 'GET' && pathname === '/v1/accounts') return page([EXPENSE]);
    if (method === 'GET' && pathname === '/v1/contacts') return page([VENDOR]);
    if (method === 'GET' && pathname === '/v1/tax-rates') return page([PURCHASE_TAX]);
    if (method === 'GET' && pathname === '/v1/vendor-credits') {
      return page(
        vendorCredits.map(({ lines: _lines, allocations: _allocations, ...summary }) => summary),
      );
    }
    if (method === 'GET' && pathname === `/v1/vendor-credits/${CREDIT_ID}`) {
      const credit = vendorCredits.find((row) => row.id === CREDIT_ID);
      if (credit !== undefined) return json(200, credit);
    }
    if (method === 'POST' && pathname === `/v1/vendor-credits/${CREDIT_ID}/allocations`) {
      return json(201, { allocations: [] });
    }

    if (method === 'GET' && pathname === '/v1/bills') {
      const { lines: _lines, allocations: _allocations, ...summary } = bill;
      return page([summary]);
    }
    if (pathname === `/v1/bills/${BILL_ID}`) {
      if (method === 'GET') return json(200, bill);
      if (method === 'PATCH') {
        const patch = typeof body === 'object' && body !== null ? body : {};
        bill = { ...bill, ...patch, lines: bill.lines };
        return json(200, bill);
      }
      if (method === 'DELETE') return new Response(null, { status: 204 });
    }
    if (method === 'POST' && pathname === `/v1/bills/${BILL_ID}/approve`) {
      return approveResponse();
    }

    return json(404, apiError('not_found', `No route for ${method} ${pathname}.`));
  }

  return {
    calls,
    handle,
    setApproveResponse(respond) {
      approveResponse = respond;
    },
    setBill(next) {
      bill = next;
    },
    setVendorCredits(next) {
      vendorCredits = next;
    },
  };
}

// --- Harness ----------------------------------------------------------------

let server: ApiDouble;

beforeEach(() => {
  server = createApiDouble();
  harness.install(server.handle);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderScreen(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <PurchasesScreen />
    </QueryClientProvider>,
  );
}

/** Opens the one stored bill from the list and waits for the editor. */
async function openBill(user: UserEvent): Promise<void> {
  renderScreen();
  await user.click(await screen.findByRole('button', { name: /^(Draft|1)$/ }));
  await screen.findByRole('region', { name: 'Bill editor' });
}

/** Switches to the vendor-credit tab and opens the one stored credit. */
async function openVendorCredit(user: UserEvent): Promise<void> {
  renderScreen();
  await user.click(await screen.findByRole('button', { name: 'Vendor credits' }));
  await user.click(await screen.findByRole('button', { name: '7' }));
  await screen.findByRole('region', { name: 'Vendor credit editor' });
}

function approveCalls(): readonly RecordedCall[] {
  return server.calls.filter((call) => call.path.endsWith('/approve'));
}

function approveButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Approve bill' });
}

// --- Tests ------------------------------------------------------------------

describe('the reference field', () => {
  /**
   * D-36: on a bill the free-text reference holds **the vendor's own invoice number** —
   * "we did not issue it, and our sequence number is only our internal handle". A field
   * labelled "Reference" beside a document number labelled "Number" gives a user no way to
   * tell which is which, and typing ours into the vendor's box records the wrong thing
   * while every total, every journal and the trial balance stay correct. Nothing
   * downstream will ever complain, so the label is the whole of the defence.
   */
  it('names whose number it holds, and shows ours under a different name', async () => {
    const user = userEvent.setup();
    await openBill(user);

    const vendorNumber = screen.getByLabelText('Vendor’s invoice number');
    expect(vendorNumber).toHaveValue(VENDOR_INVOICE_NUMBER);
    expect(vendorNumber).toHaveAccessibleDescription(/not ours/i);

    // Our own handle is present, labelled as ours, and is not a field anyone types into.
    expect(screen.getByText('Our bill number')).toBeInTheDocument();
    expect(screen.getByText('Not assigned until approval')).toBeInTheDocument();

    // No bare "Reference", which is the label that makes the two indistinguishable.
    expect(screen.queryByLabelText('Reference')).toBeNull();
  });

  it('offers the list filter as the vendor’s number too, not as ours', async () => {
    renderScreen();
    const filter = await screen.findByLabelText('Vendor’s invoice number');
    expect(filter).toHaveAccessibleDescription(/printed/i);
  });
});

describe('approving', () => {
  /**
   * One key minted per document, not per click. `approveBill` fingerprints `{ billId }`
   * alone, so the second attempt is the *same* request with the *same* key — which is how
   * the server tells a retry from a second approval. A key minted inside the click handler
   * would pass every other test in this file and post two journals, against the payables
   * control account, the first time a user pressed the button twice.
   */
  it('sends one idempotency key across repeated clicks', async () => {
    const user = userEvent.setup();
    await openBill(user);

    server.setApproveResponse(() =>
      json(500, apiError('internal_error', 'The request could not be completed.')),
    );
    await user.click(approveButton());
    await screen.findByText('Something went wrong');

    server.setApproveResponse(() => json(200, approvedBill()));
    await user.click(approveButton());
    await screen.findByRole('button', { name: 'Void bill' });

    const approvals = approveCalls();
    expect(approvals).toHaveLength(2);
    expect(approvals[0]?.idempotencyKey).toEqual(expect.any(String));
    expect(approvals[0]?.idempotencyKey).toBe(approvals[1]?.idempotencyKey);
  });

  /**
   * D-38: status is derived from the journal columns and the allocations, and the API
   * refuses a client writing it. Approving is its own `POST`, and an unchanged draft is
   * approved without being re-saved first.
   */
  it('posts to /approve and patches no status', async () => {
    const user = userEvent.setup();
    await openBill(user);

    await user.click(approveButton());
    await screen.findByRole('button', { name: 'Void bill' });

    expect(approveCalls()).toHaveLength(1);
    expect(server.calls.filter((call) => call.method === 'PATCH')).toHaveLength(0);
    for (const call of server.calls) {
      expect(JSON.stringify(call.body ?? {})).not.toContain('"status"');
    }
  });

  it('leaves an approved bill with no way to edit it', async () => {
    const user = userEvent.setup();
    server.setBill(approvedBill());
    await openBill(user);

    const editor = screen.getByRole('region', { name: 'Bill editor' });
    expect(within(editor).getByRole('button', { name: 'Void bill' })).toBeInTheDocument();

    for (const forbidden of [/save draft/i, /discard/i, /add line/i, /approve/i]) {
      expect(screen.queryByRole('button', { name: forbidden })).toBeNull();
    }
    expect(within(editor).queryAllByRole('textbox')).toHaveLength(0);
    expect(within(editor).queryAllByRole('combobox')).toHaveLength(0);
  });
});

describe('the duplicate vendor reference refusal', () => {
  async function refuse(user: UserEvent): Promise<void> {
    await openBill(user);
    server.setApproveResponse(duplicateRefusal);
    await user.click(approveButton());
    await screen.findByRole('alert');
  }

  /**
   * The refusal that costs money if it is missing, presented as the question it actually
   * is. It fires only at approval — never while a draft is being typed — so what arrives
   * is not a malformed field but the system saying *we appear to already have this*, which
   * only the person holding the paper can settle.
   */
  it('reads as a question with the vendor’s number in it, not as a validation error', async () => {
    const user = userEvent.setup();
    await refuse(user);

    const panel = screen.getByRole('alert');
    expect(
      within(panel).getByText(/Have you already entered this Acme Supplies invoice\?/),
    ).toBeInTheDocument();
    expect(within(panel).getByText(VENDOR_INVOICE_NUMBER)).toBeInTheDocument();
    // The server's own message, which names the colliding bill.
    expect(within(panel).getByText(DUPLICATE_MESSAGE)).toBeInTheDocument();

    // Not the generic precondition banner: that title would make this read as a state
    // error with nothing to do about it.
    expect(screen.queryByText('Not possible right now')).toBeNull();
  });

  /** The legitimate paths, both visible: find the other bill, or correct the number. */
  it('offers a way to the bill it collided with, and a way to correct the number', async () => {
    const user = userEvent.setup();
    await refuse(user);

    const panel = screen.getByRole('alert');
    expect(within(panel).getByText(/void it/i)).toBeInTheDocument();
    expect(
      within(panel).getByRole('button', { name: 'Correct the vendor’s number' }),
    ).toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: 'Show the bill with this number' }));

    // The recovery is a real query: `GET /v1/bills` takes a `reference` filter precisely so
    // that "have we already entered this" can be answered with the vendor's number (D-36).
    await waitFor(() => {
      expect(
        server.calls.some(
          (call) =>
            call.method === 'GET' &&
            call.path === '/v1/bills' &&
            call.query.includes(`reference=${VENDOR_INVOICE_NUMBER}`) &&
            call.query.includes(`contactId=${VENDOR.id}`),
        ),
      ).toBe(true);
    });
  });

  /**
   * The check ignores drafts on purpose (D-38): a check that fired while someone was
   * typing is a check they learn to work around. Saving is not approving, and nothing
   * about the reference is questioned here.
   */
  it('does not fire while the draft is being edited', async () => {
    const user = userEvent.setup();
    await openBill(user);

    await user.type(screen.getByLabelText('Vendor’s invoice number'), '-A');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() => {
      expect(server.calls.some((call) => call.method === 'PATCH')).toBe(true);
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(approveCalls()).toHaveLength(0);
  });
});

describe('the figures on screen', () => {
  /**
   * D-35: tax is computed per line and rounded per line, by one implementation, and the
   * document total is the sum of rounded lines. A browser-side estimate would be a second
   * implementation of that rounding, and the first thing it would disagree about is a
   * printed total — so an edited document shows no total at all until the server has
   * priced it.
   */
  it('blanks the totals while the document is dirty rather than estimating them', async () => {
    const user = userEvent.setup();
    await openBill(user);

    // Net and Total, both 1500.00 on an untaxed document.
    const totals = screen.getByRole('status');
    expect(within(totals).getAllByText('1500.00')).toHaveLength(2);

    await user.clear(screen.getByRole('textbox', { name: 'Unit price, line 1' }));
    await user.type(screen.getByRole('textbox', { name: 'Unit price, line 1' }), '20');

    expect(within(screen.getByRole('status')).getByText(/Not priced yet/)).toBeInTheDocument();
    expect(within(screen.getByRole('status')).queryByText('2000.00')).toBeNull();
  });

  /**
   * D-34: a subledger holds no balance. What is outstanding is the server's, computed on
   * read, and this screen shows the figure it was given even when the allocations on the
   * document would let it arrive at another one.
   */
  it('shows the server’s outstanding rather than one derived from allocations', async () => {
    const user = userEvent.setup();
    server.setBill({
      ...approvedBill(),
      status: 'part_paid',
      allocations: [
        {
          id: 'alloc-1',
          amount: '50000',
          date: '2026-07-10',
          sourceId: 'vc-1',
          sourceNumber: '7',
          sourceType: 'vendor_credit',
          targetId: BILL_ID,
          targetNumber: '1',
          targetType: 'bill',
          createdAt: TIMESTAMP,
        },
      ],
      // Deliberately not `150000 - 50000`: the assertion is that the screen reports what
      // the server computed, not what the allocation list adds up to.
      settlement: { allocated: '50000', outstanding: '90000' },
    });
    await openBill(user);

    const editor = screen.getByRole('region', { name: 'Bill editor' });
    expect(within(editor).getByText('Still owed')).toBeInTheDocument();
    expect(within(editor).getByText('900.00')).toBeInTheDocument();
    expect(within(editor).queryByText('1000.00')).toBeNull();
  });
});

describe('a vendor credit', () => {
  /**
   * D-39: a credit is a document in its own right, not an invoice with negative lines.
   * On screen that shows up as its own series, its own editor, and the absence of a due
   * date — modelling it the other way would need aging to special-case the sign.
   */
  it('is its own document, with its own number series and no due date', async () => {
    const user = userEvent.setup();
    server.setVendorCredits([approvedVendorCredit()]);
    await openVendorCredit(user);

    const editor = screen.getByRole('region', { name: 'Vendor credit editor' });
    expect(within(editor).getByText('Our credit number')).toBeInTheDocument();
    expect(within(editor).getByText('7')).toBeInTheDocument();
    expect(within(editor).getByText('Credit still available')).toBeInTheDocument();
    expect(screen.queryByText('Due date')).toBeNull();
  });

  /**
   * Approving a credit makes it available; reducing a particular bill is a **separate
   * fact**, written through the same allocation mechanism a payment uses (D-39, D-37). The
   * amounts offered are the server's own `outstanding` figures on both sides — nothing here
   * subtracts allocations to arrive at one (D-34).
   */
  it('applies to a bill through the allocation route, carrying one key', async () => {
    const user = userEvent.setup();
    server.setBill(approvedBill());
    server.setVendorCredits([approvedVendorCredit()]);
    await openVendorCredit(user);

    await user.click(screen.getByRole('button', { name: 'Apply to bills' }));
    await user.click(await screen.findByRole('button', { name: 'Use the smaller of the two' }));
    await user.click(screen.getByRole('button', { name: 'Apply credit' }));

    await waitFor(() => {
      expect(server.calls.some((call) => call.path.endsWith('/allocations'))).toBe(true);
    });

    const applied = server.calls.filter((call) => call.path.endsWith('/allocations'));
    expect(applied).toHaveLength(1);
    expect(applied[0]?.idempotencyKey).toEqual(expect.any(String));
    // The lesser of the bill's 1500.00 and the credit's 500.00, in cents (D-13).
    expect(applied[0]?.body).toEqual({
      allocations: [{ targetId: BILL_ID, targetType: 'bill', amount: '50000' }],
    });
  });
});
