import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The network is the only stub (spec §12). The screen, the query hooks, the generated
 * client and the component layer are all real; `globalThis.fetch` is replaced, and the base
 * URL is stubbed because jsdom leaves Node's `fetch` in place where `new Request('/v1/…')`
 * is an invalid URL. Both have to be in place before the client module is evaluated, hence
 * `vi.hoisted` — see `money-in.test.tsx`, the pattern this follows.
 */
const { fetchMock } = vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', 'http://openbooks.test');
  const fetchMock = vi.fn<(request: Request) => Promise<Response>>();
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock };
});

import { createQueryClient } from '../../query/client';
import { MatchingScreen } from './index';
import type { BankMatchProposal, BankStatementLine } from './queries';

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

const BANK = '11111111-1111-4111-8111-111111111111';
const BANK_LEDGER = '22222222-2222-4222-8222-222222222222';
const FEES = '33333333-3333-4333-8333-333333333333';
const CONTACT = '44444444-4444-4444-8444-444444444444';
const INVOICE = '55555555-5555-4555-8555-555555555555';
const JOURNAL = '66666666-6666-4666-8666-666666666666';

const LINE_POST = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LINE_LINK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LINE_ALLOCATE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function bankAccount(): unknown {
  return {
    id: BANK,
    accountId: BANK_LEDGER,
    createdAt: '2026-01-05T09:00:00.000Z',
    externalAccountId: null,
    feedSource: 'file',
    institutionName: 'Barclays',
    isActive: true,
    name: 'Barclays Current',
    updatedAt: '2026-01-05T09:00:00.000Z',
  };
}

function account(id: string, code: string, name: string, type: string): unknown {
  return {
    id,
    code,
    name,
    description: null,
    type,
    normalBalance: type === 'expense' ? 'debit' : 'debit',
    parentAccountId: null,
    isActive: true,
    createdAt: '2026-01-05T09:00:00.000Z',
    updatedAt: '2026-01-05T09:00:00.000Z',
  };
}

function line(
  overrides: Partial<BankStatementLine> & Pick<BankStatementLine, 'id'>,
): BankStatementLine {
  return {
    amount: '150000',
    bankAccountId: BANK,
    bankReference: null,
    clearing: null,
    counterparty: null,
    createdAt: '2026-03-02T09:00:00.000Z',
    description: 'Bank movement',
    fingerprint: `fp-${overrides.id}`,
    importId: '77777777-7777-4777-8777-777777777777',
    occurrenceIndex: 0,
    postedDate: '2026-03-02',
    valueDate: null,
    ...overrides,
  };
}

const UNCLEARED: readonly BankStatementLine[] = [
  line({
    id: LINE_POST,
    amount: '-4500',
    description: 'MONTHLY ACCOUNT FEE',
    postedDate: '2026-03-01',
  }),
  line({
    id: LINE_LINK,
    amount: '150000',
    description: 'FASTER PAYMENT IN',
    postedDate: '2026-03-02',
  }),
  line({
    id: LINE_ALLOCATE,
    amount: '50000',
    counterparty: 'ACME SUPPLIES',
    description: 'BACS CREDIT ACME',
    postedDate: '2026-03-03',
  }),
];

const PROPOSALS: Readonly<Record<string, readonly BankMatchProposal[]>> = {
  [LINE_POST]: [
    {
      kind: 'post_entry',
      id: 'p-post',
      lineId: LINE_POST,
      accountId: FEES,
      contactId: null,
      dimensionValueIds: [],
      rank: 1,
      reasons: [{ code: 'rule_match', amountDifference: null, dayDifference: null }],
      ruleId: '88888888-8888-4888-8888-888888888888',
    },
  ],
  [LINE_LINK]: [
    {
      kind: 'link_entry',
      id: 'p-link',
      lineId: LINE_LINK,
      journalId: JOURNAL,
      journalAmount: '150000',
      journalDate: '2026-03-01',
      journalMemo: 'Customer payment',
      rank: 1,
      reasons: [
        { code: 'amount_exact', amountDifference: '0', dayDifference: null },
        { code: 'date_close', amountDifference: null, dayDifference: -3 },
      ],
    },
  ],
  [LINE_ALLOCATE]: [
    {
      kind: 'allocate_document',
      id: 'p-allocate',
      lineId: LINE_ALLOCATE,
      contactId: CONTACT,
      contactName: 'Acme Supplies',
      documentNumber: 'INV-1004',
      outstanding: '50000',
      rank: 1,
      reasons: [{ code: 'counterparty_match', amountDifference: null, dayDifference: null }],
      targetId: INVOICE,
      targetType: 'invoice',
    },
  ],
};

function stubDirectories(): void {
  stub('GET', '/v1/bank-accounts', () => json(200, { items: [bankAccount()], nextCursor: null }));
  stub('GET', '/v1/accounts', () =>
    json(200, {
      items: [
        account(BANK_LEDGER, '1000', 'Barclays Current', 'asset'),
        account(FEES, '7000', 'Bank charges', 'expense'),
      ],
      nextCursor: null,
    }),
  );
}

function stubUncleared(lines: readonly BankStatementLine[] = UNCLEARED): void {
  stub('GET', '/v1/statement-lines', (_request, url) =>
    json(200, {
      items: url.searchParams.get('cleared') === 'false' ? lines : [],
      nextCursor: null,
    }),
  );
}

function stubProposals(): void {
  stub('POST', '/v1/bank-match-proposals', async (request) => {
    const body = (await request.clone().json()) as { lineIds: string[] };
    return json(200, {
      lines: body.lineIds.map((lineId) => ({
        lineId,
        proposals: PROPOSALS[lineId] ?? [],
      })),
    });
  });
}

function clearing(lineId: string, entryType: string): unknown {
  return {
    id: `clr-${lineId}`,
    lineId,
    entries: [
      {
        id: `clre-${lineId}`,
        entryType,
        clearedJournalId: JOURNAL,
        paymentId: null,
        accountId: null,
        targetType: null,
        targetId: null,
        amount: '0',
        createdAt: '2026-03-04T09:00:00.000Z',
      },
    ],
    clearedAmount: '0',
    clearedAt: '2026-03-04T09:00:00.000Z',
    clearedByUserId: '99999999-9999-4999-8999-999999999999',
    differenceAccountId: null,
    differenceAmount: '0',
    differenceJournalId: null,
    reconciliationSessionId: null,
  };
}

function renderScreen(): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MatchingScreen />
    </QueryClientProvider>,
  );
}

function requestsTo(method: string, pathname: string): Request[] {
  return fetchMock.mock.calls
    .map(([request]) => request)
    .filter((request) => request.method === method && new URL(request.url).pathname === pathname);
}

async function pickBankAccount(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole('combobox', { name: 'Bank account' }));
  await user.click(await screen.findByRole('option', { name: /Barclays Current/ }));
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

describe('MatchingScreen', () => {
  /**
   * The page renders its lines with the server's ranked proposals and the reasons behind
   * them — the client's own wording for the tokens (D-43) — and asks for them in a single
   * batch over the visible page's ids (E10), never one request per line.
   */
  it('renders uncleared lines with proposals and reasons, and batches the proposal request', async () => {
    const user = userEvent.setup();
    stubDirectories();
    stubUncleared();
    stubProposals();

    renderScreen();
    await pickBankAccount(user);

    // The reasons, in the client's words, resolved from the tokens and their numbers.
    expect(await screen.findByText('matched a rule')).toBeInTheDocument();
    expect(screen.getByText('exact amount')).toBeInTheDocument();
    expect(screen.getByText('3 days earlier')).toBeInTheDocument();
    expect(screen.getByText('same counterparty')).toBeInTheDocument();

    // The allocate proposal names its document and contact without a second fetch.
    expect(screen.getByText(/INV-1004 · Acme Supplies/)).toBeInTheDocument();

    // No score and no percentage — rank is the ordering, not a number (D-48).
    expect(screen.queryByText(/%/)).toBeNull();

    // One batch for the three visible lines, carrying all three ids.
    const batched = requestsTo('POST', '/v1/bank-match-proposals');
    expect(batched).toHaveLength(1);
    const body = (await batched[0]?.clone().json()) as { lineIds: string[] };
    expect(body.lineIds).toEqual(expect.arrayContaining([LINE_POST, LINE_LINK, LINE_ALLOCATE]));
    expect(body.lineIds).toHaveLength(3);
  });

  /**
   * Accept maps a proposal's `kind` onto the clearing `method` one-to-one, and the proposal
   * already carries the target — so the body is exactly what each kind needs and nothing it
   * does not.
   */
  it('issues the right clearing body for each proposal kind', async () => {
    const user = userEvent.setup();
    stubDirectories();
    stubUncleared();
    stubProposals();
    stub('POST', `/v1/statement-lines/${LINE_POST}/clearing`, () =>
      json(201, clearing(LINE_POST, 'post_entry')),
    );
    stub('POST', `/v1/statement-lines/${LINE_LINK}/clearing`, () =>
      json(201, clearing(LINE_LINK, 'link_entry')),
    );
    stub('POST', `/v1/statement-lines/${LINE_ALLOCATE}/clearing`, () =>
      json(201, clearing(LINE_ALLOCATE, 'allocate_document')),
    );

    renderScreen();
    await pickBankAccount(user);
    await screen.findByText('matched a rule');

    async function acceptTopOf(lineId: string, description: string): Promise<unknown> {
      const group = screen.getByRole('group', { name: new RegExp(description) });
      await user.click(within(group).getByRole('button', { name: /^Accept:/ }));
      const [posted] = requestsTo('POST', `/v1/statement-lines/${lineId}/clearing`);
      expect(posted).toBeDefined();
      expect(posted?.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
      return posted?.clone().json();
    }

    expect(await acceptTopOf(LINE_POST, 'MONTHLY ACCOUNT FEE')).toEqual({
      entries: [{ method: 'post_entry', accountId: FEES }],
    });
    expect(await acceptTopOf(LINE_LINK, 'FASTER PAYMENT IN')).toEqual({
      entries: [{ method: 'link_entry', journalId: JOURNAL }],
    });
    expect(await acceptTopOf(LINE_ALLOCATE, 'BACS CREDIT ACME')).toEqual({
      entries: [{ method: 'allocate_document', targetType: 'invoice', targetId: INVOICE }],
    });
  });

  /**
   * Correcting overrides the proposal: a `post_entry` to an account the user chose, the one
   * override the API can honour on any line — a line clears once (`uq_blc_line`), so a split
   * across accounts is not expressible and is not offered.
   */
  it('corrects a line to a chosen account with a post_entry', async () => {
    const user = userEvent.setup();
    stubDirectories();
    stubUncleared();
    stubProposals();
    stub('POST', `/v1/statement-lines/${LINE_LINK}/clearing`, () =>
      json(201, clearing(LINE_LINK, 'post_entry')),
    );

    renderScreen();
    await pickBankAccount(user);
    await screen.findByText('matched a rule');

    const group = screen.getByRole('group', { name: /FASTER PAYMENT IN/ });
    await user.click(within(group).getByRole('button', { name: 'Correct' }));

    const dialog = await screen.findByRole('dialog', { name: 'Correct this line' });
    await user.click(within(dialog).getByRole('combobox', { name: 'Code to account' }));
    await user.click(await screen.findByRole('option', { name: /Bank charges/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Code line' }));

    const [posted] = requestsTo('POST', `/v1/statement-lines/${LINE_LINK}/clearing`);
    expect(posted).toBeDefined();
    expect(await posted?.clone().json()).toEqual({
      entries: [{ method: 'post_entry', accountId: FEES }],
    });
  });

  /**
   * The list holds the focus and Enter accepts the focused line's top proposal — the
   * keystroke the whole screen is built around (the focused line defaults to the first).
   */
  it('accepts the focused line’s top proposal on Enter', async () => {
    const user = userEvent.setup();
    stubDirectories();
    stubUncleared();
    stubProposals();
    stub('POST', `/v1/statement-lines/${LINE_POST}/clearing`, () =>
      json(201, clearing(LINE_POST, 'post_entry')),
    );

    renderScreen();
    await pickBankAccount(user);
    await screen.findByText('matched a rule');

    const list = screen.getByRole('list', { name: 'Uncleared statement lines' });
    list.focus();
    await user.keyboard('{Enter}');

    const [posted] = requestsTo('POST', `/v1/statement-lines/${LINE_POST}/clearing`);
    expect(posted).toBeDefined();
    expect(await posted?.clone().json()).toEqual({
      entries: [{ method: 'post_entry', accountId: FEES }],
    });
  });

  /**
   * A clear refused for a state reason (`412` with a precondition token) arrives as the human
   * sentence this screen maps the token to, not the server's minor-units prose — the
   * `sales/refusal.tsx` pattern applied to banking's tokens.
   */
  it('shows the mapped message when a clear is refused', async () => {
    const user = userEvent.setup();
    stubDirectories();
    stubUncleared();
    stubProposals();
    stub('POST', `/v1/statement-lines/${LINE_POST}/clearing`, () =>
      apiError(412, 'precondition_failed', 'The period 2026-03 is closed.', {
        precondition: 'period_closed',
      }),
    );

    renderScreen();
    await pickBankAccount(user);
    await screen.findByText('matched a rule');

    const group = screen.getByRole('group', { name: /MONTHLY ACCOUNT FEE/ });
    await user.click(within(group).getByRole('button', { name: /^Accept:/ }));

    const refusal = await screen.findByRole('alert');
    expect(refusal).toHaveTextContent('closed accounting period');
  });
});

/**
 * The multi-entry editor (OB-140; ROADMAP I2, I3, I4, I7, D-80, D-81, D-106).
 *
 * Two things are worth proving here and nowhere else in this file: several `allocate_document`
 * entries against different contacts plus a `post_entry`, all in one clear, balancing to the
 * line (lockbox, I3, and split-coding, I7, are the same mechanism); and a discount suggestion
 * turning into its own entry with one click, never on its own (D-43).
 */
describe('MatchingScreen — multi-entry clearing', () => {
  function contactRecord(id: string, code: string, displayName: string): unknown {
    return {
      id,
      code,
      displayName,
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
  }

  function invoiceRecord(
    id: string,
    contactId: string,
    documentNumber: string,
    outstanding: string,
  ): unknown {
    return {
      id,
      contactId,
      documentNumber,
      reference: null,
      issueDate: '2026-02-01',
      dueDate: '2026-03-15',
      status: 'approved',
      totals: { subtotal: outstanding, tax: '0', total: outstanding, taxSummary: [] },
      settlement: { allocated: '0', outstanding },
      createdAt: '2026-02-01T09:00:00.000Z',
      updatedAt: '2026-02-01T09:00:00.000Z',
    };
  }

  function stubContacts(contacts: readonly unknown[]): void {
    stub('GET', '/v1/contacts', () => json(200, { items: contacts, nextCursor: null }));
  }

  function stubInvoicesByContact(byContact: Readonly<Record<string, readonly unknown[]>>): void {
    stub('GET', '/v1/invoices', (_request, url) => {
      const status = url.searchParams.get('status');
      if (status !== 'approved') return json(200, { items: [], nextCursor: null });
      const contactId = url.searchParams.get('contactId') ?? '';
      return json(200, { items: byContact[contactId] ?? [], nextCursor: null });
    });
  }

  function stubNoDiscountSuggestion(): void {
    stub('GET', '/v1/payment-terms/discount-suggestion', () => new Response(null, { status: 204 }));
  }

  function stubDiscountSuggestion(body: unknown): void {
    stub('GET', '/v1/payment-terms/discount-suggestion', () => json(200, body));
  }

  const LOCKBOX_LINE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const BETA = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const INVOICE_A = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const INVOICE_B = '10101010-1010-4101-8101-101010101010';
  const DISCOUNT_ACCOUNT = '20202020-2020-4202-8202-202020202020';

  /**
   * Lockbox (I3) and split-coding (I7) are one mechanism: two `allocate_document` entries
   * against two different contacts' invoices, plus a `post_entry` for a bank charge folded
   * into the same deposit — three entries, one clear, summing exactly to the line (E4).
   */
  it('builds a 3-entry clear across two contacts and an account, balancing to the line', async () => {
    const user = userEvent.setup();

    stubDirectories();
    stubUncleared([
      line({
        id: LOCKBOX_LINE,
        amount: '50000',
        description: 'LOCKBOX DEPOSIT',
        postedDate: '2026-03-05',
      }),
    ]);
    stubProposals();
    stubContacts([
      contactRecord(CONTACT, 'C-100', 'Acme Supplies'),
      contactRecord(BETA, 'C-200', 'Beta Traders'),
    ]);
    stubInvoicesByContact({
      [CONTACT]: [invoiceRecord(INVOICE_A, CONTACT, 'INV-3001', '20000')],
      [BETA]: [invoiceRecord(INVOICE_B, BETA, 'INV-3002', '25000')],
    });
    stubNoDiscountSuggestion();
    stub('POST', `/v1/statement-lines/${LOCKBOX_LINE}/clearing`, () =>
      json(201, clearing(LOCKBOX_LINE, 'allocate_document')),
    );

    renderScreen();
    await pickBankAccount(user);
    await screen.findByText('LOCKBOX DEPOSIT');

    const lineGroup = screen.getByRole('group', { name: /LOCKBOX DEPOSIT/ });
    await user.click(within(lineGroup).getByRole('button', { name: 'Multiple entries' }));

    const dialog = await screen.findByRole('dialog', { name: 'Multiple entries' });

    // Entry 1: settle Acme's invoice — the amount fills in from what it has outstanding.
    const entry1 = within(dialog).getByRole('group', { name: 'Entry 1: Settle a document' });
    await user.click(within(entry1).getByRole('combobox', { name: 'Contact' }));
    await user.click(await screen.findByRole('option', { name: /Acme Supplies/ }));
    await user.click(within(entry1).getByRole('combobox', { name: 'Invoice' }));
    await user.click(await screen.findByRole('option', { name: /INV-3001/ }));

    // Entry 2: add a second target — a different contact's invoice (the lockbox, I3).
    await user.click(within(dialog).getByRole('button', { name: 'Add: settle a document' }));
    const entry2 = within(dialog).getByRole('group', { name: 'Entry 2: Settle a document' });
    await user.click(within(entry2).getByRole('combobox', { name: 'Contact' }));
    await user.click(await screen.findByRole('option', { name: /Beta Traders/ }));
    await user.click(within(entry2).getByRole('combobox', { name: 'Invoice' }));
    await user.click(await screen.findByRole('option', { name: /INV-3002/ }));

    // Entry 3: the remaining 50.00 coded to an account — the split-coding case (I7).
    await user.click(within(dialog).getByRole('button', { name: 'Add: code to an account' }));
    const entry3 = within(dialog).getByRole('group', { name: 'Entry 3: Code to an account' });
    await user.click(within(entry3).getByRole('combobox', { name: 'Account' }));
    await user.click(await screen.findByRole('option', { name: /Bank charges/ }));
    await user.type(within(entry3).getByRole('textbox', { name: 'Amount' }), '50');

    expect(await within(dialog).findByText(/Balanced/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Clear line' }));

    const [posted] = requestsTo('POST', `/v1/statement-lines/${LOCKBOX_LINE}/clearing`);
    expect(posted).toBeDefined();
    expect(await posted?.clone().json()).toEqual({
      entries: [
        {
          method: 'allocate_document',
          targetId: INVOICE_A,
          targetType: 'invoice',
          amount: '20000',
        },
        {
          method: 'allocate_document',
          targetId: INVOICE_B,
          targetType: 'invoice',
          amount: '25000',
        },
        { method: 'post_entry', accountId: FEES, amount: '5000' },
      ],
    });
  });

  /**
   * The discount suggestion (OB-138) is offered, never added on its own (D-43): it appears
   * once a document is named, and "Add suggested discount" is the one click that turns it
   * into a real `discount` entry — excluded from the balance sum (D-106), so the clear still
   * reaches zero with the cash entry alone.
   */
  it('adds a suggested early-pay discount as its own entry, never on its own', async () => {
    const user = userEvent.setup();

    stubDirectories();
    stubUncleared([
      line({
        id: LOCKBOX_LINE,
        amount: '47000',
        description: 'LOCKBOX DEPOSIT',
        postedDate: '2026-03-05',
      }),
    ]);
    stubProposals();
    stubContacts([contactRecord(CONTACT, 'C-100', 'Acme Supplies')]);
    stubInvoicesByContact({
      [CONTACT]: [invoiceRecord(INVOICE_A, CONTACT, 'INV-3001', '47000')],
    });
    stubDiscountSuggestion({
      targetId: INVOICE_A,
      discountAmountMinor: '3000',
      deadline: '2026-03-10',
      accountId: DISCOUNT_ACCOUNT,
    });
    stub('POST', `/v1/statement-lines/${LOCKBOX_LINE}/clearing`, () =>
      json(201, clearing(LOCKBOX_LINE, 'discount')),
    );

    renderScreen();
    await pickBankAccount(user);
    await screen.findByText('LOCKBOX DEPOSIT');

    const lineGroup = screen.getByRole('group', { name: /LOCKBOX DEPOSIT/ });
    await user.click(within(lineGroup).getByRole('button', { name: 'Multiple entries' }));

    const dialog = await screen.findByRole('dialog', { name: 'Multiple entries' });
    const entry1 = within(dialog).getByRole('group', { name: 'Entry 1: Settle a document' });
    await user.click(within(entry1).getByRole('combobox', { name: 'Contact' }));
    await user.click(await screen.findByRole('option', { name: /Acme Supplies/ }));
    await user.click(within(entry1).getByRole('combobox', { name: 'Invoice' }));
    await user.click(await screen.findByRole('option', { name: /INV-3001/ }));

    // Never auto-added: the suggestion is offered, not applied, until this click.
    const hint = await within(dialog).findByText(/Eligible for an early-pay discount/);
    expect(hint).toHaveTextContent('$30.00');
    expect(hint).toHaveTextContent('2026-03-10');
    expect(await within(dialog).findByText(/Balanced/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Add suggested discount' }));

    // A second entry now exists — the discount — and the clear is still balanced: it is
    // excluded from the sum the line must add up to (D-106).
    expect(
      within(dialog).getByRole('group', { name: 'Entry 2: Early-pay discount' }),
    ).toBeInTheDocument();
    expect(await within(dialog).findByText(/Balanced/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Clear line' }));

    const [posted] = requestsTo('POST', `/v1/statement-lines/${LOCKBOX_LINE}/clearing`);
    expect(posted).toBeDefined();
    expect(await posted?.clone().json()).toEqual({
      entries: [
        {
          method: 'allocate_document',
          targetId: INVOICE_A,
          targetType: 'invoice',
          amount: '47000',
        },
        {
          method: 'discount',
          accountId: DISCOUNT_ACCOUNT,
          amount: '3000',
          targetId: INVOICE_A,
          targetType: 'invoice',
        },
      ],
    });
  });
});
