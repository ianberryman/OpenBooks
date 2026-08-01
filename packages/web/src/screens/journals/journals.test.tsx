import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route as RouterRoute, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * OB-236's web half: the posted-journals list and its deep-linked detail route.
 *
 * `sales.test.tsx`'s harness — the generated client is a module singleton that captures
 * `globalThis.fetch` and `globalThis.Request` when `src/api/client.ts` is evaluated, so
 * both stubs are in place before the imports below run (`vi.hoisted`).
 *
 * Three things are worth a test here, beyond `journals-list.test.tsx`'s coverage of the
 * list on its own:
 *
 * 1. **A row opens the journal at its own URL**, and the detail route renders the same
 *    `<PostedEntry>` the journal-entry screen posts into — not a second read-only view.
 * 2. **Reverse is gated on `journals.reverse` (D-25)**, advisory only: present with the
 *    permission, absent without it, on the very same journal.
 * 3. **Reversing lands on the reversal's own URL**, because a reversal is a distinct
 *    posted journal with its own id (D-02) — not the original re-rendered in place.
 */
const { fetchMock } = vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', 'http://openbooks.test');
  const fetchMock = vi.fn<(request: Request) => Promise<Response>>();
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock };
});

import { createQueryClient } from '../../query/client';
import { JournalsScreen } from '../journals';

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

function apiError(status: number, code: string, message: string): Response {
  return json(status, { error: { code, message } });
}

const JOURNAL_ID = '11111111-1111-4111-8111-111111111111';
const REVERSAL_ID = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';
const TIMESTAMP = '2026-07-01T00:00:00.000Z';

function account(): Record<string, unknown> {
  return {
    id: ACCOUNT_ID,
    code: '1-1000',
    name: 'Cash at bank',
    description: null,
    cashBasisRole: null,
    isActive: true,
    normalBalance: 'debit',
    parentAccountId: null,
    type: 'asset',
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function postedJournal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    journalId: JOURNAL_ID,
    orgId: 'org-1',
    date: '2026-07-01',
    memo: 'Cash sale',
    actorId: 'user-1',
    actorType: 'user',
    invocationMode: null,
    postedAt: TIMESTAMP,
    reversesJournalId: null,
    reversedByJournalId: null,
    lines: [
      {
        lineId: 'jl-1',
        accountId: ACCOUNT_ID,
        side: 'debit',
        amount: '150000',
        contactId: null,
        memo: null,
        dimensionValueIds: [],
      },
      {
        lineId: 'jl-2',
        accountId: ACCOUNT_ID,
        side: 'credit',
        amount: '150000',
        contactId: null,
        memo: null,
        dimensionValueIds: [],
      },
    ],
    ...overrides,
  };
}

function journalSummary(): Record<string, unknown> {
  return {
    journalId: JOURNAL_ID,
    sequenceNumber: '42',
    date: '2026-07-01',
    memo: 'Cash sale',
    source: 'manual',
    postedAt: TIMESTAMP,
    actorType: 'user',
    actorId: 'user-1',
    reversesJournalId: null,
    reversedByJournalId: null,
  };
}

function stubReferenceData(): void {
  stub('GET', '/v1/accounts', () => json(200, { items: [account()], nextCursor: null }));
  stub('GET', '/v1/contacts', () => json(200, { items: [], nextCursor: null }));
  stub('GET', '/v1/dimensions', () => json(200, { items: [], nextCursor: null }));
}

function stubIdentity(permissions: readonly string[]): void {
  stub('GET', '/v1/auth/me', () =>
    json(200, {
      activeOrgId: 'org-1',
      memberships: [],
      permissions,
      user: { id: 'user-1', email: 'owner@example.com', displayName: 'Owner' },
    }),
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

/**
 * Mounted exactly as `App.tsx` will mount it — a `path="/journals/*"` route — so the
 * screen's own relative `<Routes>` resolve under `/journals`, the same nesting
 * `sales.test.tsx` uses.
 */
function renderScreen(initialPath = '/journals'): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <RouterRoute path="/journals/*" element={<JournalsScreen />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('JournalsScreen', () => {
  it('opens a journal from the list at its own URL and renders the posted entry', async () => {
    const user = userEvent.setup();
    stubIdentity(['journals.read', 'journals.reverse']);
    stubReferenceData();
    stub('GET', '/v1/journals', () => json(200, { items: [journalSummary()], nextCursor: null }));
    stub('GET', `/v1/journals/${JOURNAL_ID}`, () => json(200, postedJournal()));

    renderScreen();

    await user.click(await screen.findByRole('button', { name: '42' }));

    const entry = await screen.findByRole('region', { name: 'Posted journal entry' });
    expect(within(entry).getByText('Cash sale')).toBeInTheDocument();
  });

  it('shows Reverse entry when the caller holds journals.reverse', async () => {
    stubIdentity(['journals.read', 'journals.reverse']);
    stubReferenceData();
    stub('GET', `/v1/journals/${JOURNAL_ID}`, () => json(200, postedJournal()));

    renderScreen(`/journals/${JOURNAL_ID}`);

    expect(await screen.findByRole('button', { name: 'Reverse entry' })).toBeInTheDocument();
  });

  /**
   * The gate is advisory (D-25) — the service still enforces `journals.reverse` — but a
   * caller who cannot post a reversal should not be offered a button that only ends in a
   * refusal.
   */
  it('hides Reverse entry without journals.reverse, on the same journal', async () => {
    stubIdentity(['journals.read']);
    stubReferenceData();
    stub('GET', `/v1/journals/${JOURNAL_ID}`, () => json(200, postedJournal()));

    renderScreen(`/journals/${JOURNAL_ID}`);

    await screen.findByRole('region', { name: 'Posted journal entry' });
    expect(screen.queryByRole('button', { name: 'Reverse entry' })).toBeNull();
  });

  it('lands on the reversal’s own URL, not the original re-rendered', async () => {
    const user = userEvent.setup();
    stubIdentity(['journals.read', 'journals.reverse']);
    stubReferenceData();
    stub('GET', `/v1/journals/${JOURNAL_ID}`, () => json(200, postedJournal()));
    stub('GET', `/v1/journals/${REVERSAL_ID}`, () =>
      json(200, postedJournal({ journalId: REVERSAL_ID, reversesJournalId: JOURNAL_ID })),
    );
    stub('POST', `/v1/journals/${JOURNAL_ID}/reverse`, () =>
      json(201, postedJournal({ journalId: REVERSAL_ID, reversesJournalId: JOURNAL_ID })),
    );

    renderScreen(`/journals/${JOURNAL_ID}`);

    await user.click(await screen.findByRole('button', { name: 'Reverse entry' }));
    await user.click(await screen.findByRole('button', { name: 'Post reversal' }));

    expect(await screen.findByText(/This entry reverses another/)).toBeInTheDocument();
    expect(screen.getByText(REVERSAL_ID)).toBeInTheDocument();
  });

  it('shows a friendly message and a way back for a journal that does not exist', async () => {
    stubIdentity(['journals.read', 'journals.reverse']);
    stubReferenceData();
    stub('GET', `/v1/journals/${JOURNAL_ID}`, () => apiError(404, 'not_found', 'Not found.'));

    renderScreen(`/journals/${JOURNAL_ID}`);

    expect(await screen.findByText('This journal was not found.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to journals' })).toBeInTheDocument();
  });
});
