import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The generated client captures `globalThis.fetch` and its base URL when `src/api/client.ts`
 * is evaluated, so both stubs must be in place *before* the imports below run — hence
 * `vi.hoisted`. The base URL is stubbed because jsdom leaves Node's `fetch` in place and
 * `new Request('/v1/…')` there is an invalid URL.
 *
 * Nothing else is mocked. The screen, the query hooks, the generated client and the
 * component layer are all real; what is replaced is the network, the one boundary this
 * package owns (spec §12).
 */
const { fetchMock } = vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', 'http://openbooks.test');
  const fetchMock = vi.fn<(request: Request) => Promise<Response>>();
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock };
});

import { createQueryClient } from '../../query/client';
import { ReconciliationScreen } from './reconciliation';
import type {
  BankAccount,
  ReconciliationReport,
  ReconciliationSession,
  ReconciliationSessionSummary,
} from './queries';

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

const BANK_ACC = '11111111-1111-4111-8111-111111111111';
const LEDGER = '22222222-2222-4222-8222-222222222222';
const SESSION = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';

function bankAccount(): BankAccount {
  return {
    id: BANK_ACC,
    accountId: LEDGER,
    externalAccountId: null,
    feedSource: 'file',
    institutionName: 'Barclays',
    isActive: true,
    name: 'Barclays Current',
    createdAt: '2026-01-05T09:00:00.000Z',
    updatedAt: '2026-01-05T09:00:00.000Z',
  };
}

/**
 * An unpresented-cheque session by default: the difference is zero — the account reconciles
 * and can be finalised — while the uncleared amount is the cheque the bank has not shown. The
 * two figures are deliberately different, because a screen that ran them together is the bug
 * these tests exist to catch.
 */
function session(overrides: Partial<ReconciliationSession> = {}): ReconciliationSession {
  return {
    id: SESSION,
    bankAccountId: BANK_ACC,
    startDate: '2026-03-01',
    endDate: '2026-03-31',
    state: 'open',
    clearedLineCount: 4,
    unclearedLineCount: 1,
    balances: {
      openingBalance: '0',
      clearedBalance: '100000',
      statementClosingBalance: '100000',
      difference: '0',
      bookBalance: '50000',
      unclearedAmount: '-50000',
    },
    events: [
      {
        id: 'e1111111-1111-4111-8111-111111111111',
        sessionId: SESSION,
        actorUserId: USER,
        occurredAt: '2026-04-01T10:00:00.000Z',
        type: 'opened',
        reason: null,
        statementClosingBalance: null,
      },
    ],
    finalisedAt: null,
    createdAt: '2026-04-01T10:00:00.000Z',
    updatedAt: '2026-04-01T10:00:00.000Z',
    ...overrides,
  };
}

function finalisedSession(): ReconciliationSession {
  return session({
    state: 'finalised',
    finalisedAt: '2026-04-02T09:00:00.000Z',
    events: [
      {
        id: 'e1111111-1111-4111-8111-111111111111',
        sessionId: SESSION,
        actorUserId: USER,
        occurredAt: '2026-04-01T10:00:00.000Z',
        type: 'opened',
        reason: null,
        statementClosingBalance: null,
      },
      {
        id: 'e2222222-2222-4222-8222-222222222222',
        sessionId: SESSION,
        actorUserId: USER,
        occurredAt: '2026-04-02T09:00:00.000Z',
        type: 'finalised',
        reason: null,
        statementClosingBalance: '100000',
      },
    ],
  });
}

function summaryOf(full: ReconciliationSession): ReconciliationSessionSummary {
  return {
    id: full.id,
    bankAccountId: full.bankAccountId,
    startDate: full.startDate,
    endDate: full.endDate,
    state: full.state,
    clearedLineCount: full.clearedLineCount,
    unclearedLineCount: full.unclearedLineCount,
    balances: full.balances,
    finalisedAt: full.finalisedAt,
    createdAt: full.createdAt,
    updatedAt: full.updatedAt,
  };
}

function report(): ReconciliationReport {
  return {
    sessionId: SESSION,
    bankAccountId: BANK_ACC,
    startDate: '2026-03-01',
    endDate: '2026-03-31',
    state: 'open',
    balances: session().balances,
    // Sums to unclearedAmount (-50000) exactly (D-50).
    reconcilingItems: [
      {
        journalId: '55555555-5555-4555-8555-555555555555',
        amount: '-50000',
        date: '2026-03-28',
        description: 'Cheque 1041 to Acme',
        reference: 'CHQ-1041',
      },
    ],
    // The other half — shown, but outside unclearedAmount.
    unclearedStatementLines: [
      {
        lineId: '66666666-6666-4666-8666-666666666666',
        amount: '25000',
        date: '2026-03-30',
        description: 'Faster payment in',
        reference: 'FP-9987',
      },
    ],
  };
}

function stubBankAccounts(): void {
  stub('GET', '/v1/bank-accounts', () => json(200, { items: [bankAccount()], nextCursor: null }));
}

function renderScreen(): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <ReconciliationScreen />
    </QueryClientProvider>,
  );
}

function requestsTo(method: string, pathname: string): Request[] {
  return fetchMock.mock.calls
    .map(([request]) => request)
    .filter((request) => request.method === method && new URL(request.url).pathname === pathname);
}

/** Selects the one bank account and opens its one session's detail panel. */
async function openSessionDetail(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole('combobox', { name: 'Bank account' }));
  await user.click(await screen.findByRole('option', { name: /Barclays Current/ }));
  await user.click(
    await screen.findByRole('button', { name: 'Open the reconciliation to 2026-03-31' }),
  );
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

describe('ReconciliationScreen — opening', () => {
  /**
   * Opening asks for the three things on a paper statement — account, end date, closing
   * balance — and sends exactly those. `startDate` is derived, not guessed, so the body must
   * not carry one: a value disagreeing with the server's derived start is
   * `reconciliation_session_overlaps`.
   */
  it('posts the account, end date and closing balance, and no startDate', async () => {
    const user = userEvent.setup();
    const opened = session();
    let listed: readonly ReconciliationSessionSummary[] = [];

    stubBankAccounts();
    stub('GET', '/v1/reconciliation-sessions', () =>
      json(200, { items: listed, nextCursor: null }),
    );
    stub('POST', '/v1/reconciliation-sessions', () => {
      listed = [summaryOf(opened)];
      return json(201, opened);
    });
    stub('GET', `/v1/reconciliation-sessions/${SESSION}`, () => json(200, opened));

    renderScreen();

    await user.click(await screen.findByRole('combobox', { name: 'Bank account' }));
    await user.click(await screen.findByRole('option', { name: /Barclays Current/ }));

    await user.click(screen.getByRole('button', { name: 'Open reconciliation' }));
    const dialog = await screen.findByRole('dialog', { name: 'Open a reconciliation' });

    await user.type(within(dialog).getByLabelText('Statement end date'), '2026-03-31');
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Statement closing balance' }),
      '1000',
    );

    await user.click(within(dialog).getByRole('button', { name: 'Open reconciliation' }));

    const [posted] = requestsTo('POST', '/v1/reconciliation-sessions');
    expect(posted).toBeDefined();
    const body = (await posted?.clone().json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      bankAccountId: BANK_ACC,
      endDate: '2026-03-31',
      // Cents, never a decimal and never a JSON number (D-13).
      statementClosingBalance: '100000',
    });
    expect(Object.keys(body)).not.toContain('startDate');
    // Every write carries a key.
    expect(posted?.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('ReconciliationScreen — the session detail', () => {
  /**
   * The distinction the screen exists to make legible (D-50): the difference is what E5
   * tests and it is zero here, so finalising is possible; the uncleared amount is a
   * reconciling difference — an unpresented cheque — and it is non-zero and shown alongside,
   * never as the reason the account does not balance.
   */
  it('shows cleared, statement, a zero difference and a non-zero uncleared amount, with finalise enabled', async () => {
    const user = userEvent.setup();

    stubBankAccounts();
    stub('GET', '/v1/reconciliation-sessions', () =>
      json(200, { items: [summaryOf(session())], nextCursor: null }),
    );
    stub('GET', `/v1/reconciliation-sessions/${SESSION}`, () => json(200, session()));

    renderScreen();
    await openSessionDetail(user);

    const test = await screen.findByRole('region', { name: 'The reconciliation' });
    // The two figures being compared, and the verdict.
    expect(test).toHaveTextContent('1000.00'); // cleared and statement both
    expect(test).toHaveTextContent('Balanced');

    const differences = screen.getByRole('region', { name: 'Reconciling differences' });
    // The unpresented cheque, signed, shown as an expected difference — not netted into the
    // verdict above.
    expect(differences).toHaveTextContent('-500.00');
    expect(differences).toHaveTextContent('1 uncleared line');

    // Zero difference, so the assertion is allowed — the server still decides, but the
    // control is not disabled.
    expect(screen.getByRole('button', { name: 'Finalise reconciliation' })).toBeEnabled();
  });

  /**
   * Finalisation is server-asserted (D-50). The button is enabled because the difference the
   * screen holds is zero, but the balances are computed on read and the figure that decides
   * is the server's — so the call is made, and when it refuses the mismatch is surfaced as
   * the mapped refusal rather than swallowed.
   */
  it('surfaces the balance-mismatch refusal from the server', async () => {
    const user = userEvent.setup();

    stubBankAccounts();
    stub('GET', '/v1/reconciliation-sessions', () =>
      json(200, { items: [summaryOf(session())], nextCursor: null }),
    );
    stub('GET', `/v1/reconciliation-sessions/${SESSION}`, () => json(200, session()));
    stub('POST', `/v1/reconciliation-sessions/${SESSION}/finalise`, () =>
      apiError(
        412,
        'precondition_failed',
        'Cleared balance 100000 does not equal statement closing balance 90000.',
        { precondition: 'reconciliation_session_balance_mismatch' },
      ),
    );

    renderScreen();
    await openSessionDetail(user);

    await user.click(await screen.findByRole('button', { name: 'Finalise reconciliation' }));

    const refusal = await screen.findByRole('alert');
    expect(refusal).toHaveTextContent('The books and the bank do not agree yet');
    // An unpresented cheque is named as the thing this is not.
    expect(refusal).toHaveTextContent(/reconciling difference/);
  });

  /**
   * Reopening requires a reason (E6) — who and when are known without asking, why is not — so
   * the confirm is blocked until one is given and the reason is what goes in the body.
   */
  it('requires a reason to reopen and posts it', async () => {
    const user = userEvent.setup();
    const finalised = finalisedSession();

    stubBankAccounts();
    stub('GET', '/v1/reconciliation-sessions', () =>
      json(200, { items: [summaryOf(finalised)], nextCursor: null }),
    );
    stub('GET', `/v1/reconciliation-sessions/${SESSION}`, () => json(200, finalised));
    stub('POST', `/v1/reconciliation-sessions/${SESSION}/reopen`, () =>
      json(200, session({ state: 'open' })),
    );

    renderScreen();
    await openSessionDetail(user);

    await user.click(await screen.findByRole('button', { name: 'Reopen…' }));

    // Nothing typed: the confirm is refused client-side, but the reason is not invented.
    const confirm = screen.getByRole('button', { name: 'Reopen' });
    expect(confirm).toBeDisabled();

    await user.type(
      screen.getByRole('textbox', { name: 'Reason' }),
      'Bank corrected a duplicated line',
    );
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    const [posted] = requestsTo('POST', `/v1/reconciliation-sessions/${SESSION}/reopen`);
    expect(posted).toBeDefined();
    const body = (await posted?.clone().json()) as Record<string, unknown>;
    expect(body).toEqual({ reason: 'Bank corrected a duplicated line' });
    expect(posted?.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
  });

  /**
   * The report is the printable "why don't the books and the bank agree" view. Its two lists
   * are kept apart: the reconciling items sum to the uncleared amount exactly (D-50), and the
   * uncleared statement lines are the other half — shown, but outside that sum.
   */
  it('renders both reconciling lists and ties the items to the uncleared amount', async () => {
    const user = userEvent.setup();

    stubBankAccounts();
    stub('GET', '/v1/reconciliation-sessions', () =>
      json(200, { items: [summaryOf(session())], nextCursor: null }),
    );
    stub('GET', `/v1/reconciliation-sessions/${SESSION}`, () => json(200, session()));
    stub('GET', `/v1/reconciliation-sessions/${SESSION}/report`, () => json(200, report()));

    renderScreen();
    await openSessionDetail(user);
    await user.click(await screen.findByRole('button', { name: 'Report' }));

    const items = await screen.findByRole('region', { name: 'Reconciling items' });
    expect(items).toHaveTextContent('Cheque 1041 to Acme');
    expect(items).toHaveTextContent('2026-03-28');
    expect(items).toHaveTextContent('-500.00');
    // The tie: the items sum to the uncleared amount.
    expect(items).toHaveTextContent(/sum to the uncleared amount/);

    const lines = screen.getByRole('region', { name: 'Uncleared statement lines' });
    expect(lines).toHaveTextContent('Faster payment in');
    expect(lines).toHaveTextContent('2026-03-30');
    // Positive, signed so its direction reads.
    expect(lines).toHaveTextContent('+250.00');
  });
});
