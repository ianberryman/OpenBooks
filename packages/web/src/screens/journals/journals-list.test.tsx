import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `<JournalsList>` in isolation (OB-236). The generated client is a module singleton
 * that captures `globalThis.fetch` when `src/api/client.ts` is evaluated, so the stub has
 * to be in place before the imports below run — `journal-entry.test.tsx`'s reason for
 * `vi.hoisted`.
 */
const { fetchMock } = vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', 'http://openbooks.test');
  const fetchMock = vi.fn<(request: Request) => Promise<Response>>();
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock };
});

import { createQueryClient } from '../../query/client';
import { JournalsList } from './journals-list';
import type { JournalSummary } from './queries';

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
const REVERSAL_JOURNAL_ID = '22222222-2222-4222-8222-222222222222';

function journal(overrides: Partial<JournalSummary> = {}): JournalSummary {
  return {
    journalId: JOURNAL_ID,
    sequenceNumber: '42',
    date: '2026-07-01',
    memo: 'Cash sale',
    source: 'manual',
    postedAt: '2026-07-01T12:00:00.000Z',
    actorType: 'user',
    actorId: 'user-1',
    reversesJournalId: null,
    ...overrides,
  };
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

function renderList(onOpen: (journalId: string) => void = () => {}): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <JournalsList onOpen={onOpen} />
    </QueryClientProvider>,
  );
}

describe('JournalsList', () => {
  it('lists posted journals by their entry number and opens the one clicked', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    stub('GET', '/v1/journals', () => json(200, { items: [journal()], nextCursor: null }));

    renderList(onOpen);

    const row = await screen.findByRole('button', { name: '42' });
    await user.click(row);

    expect(onOpen).toHaveBeenCalledWith(JOURNAL_ID);
  });

  it('shows a reversal distinctly from a manual entry', async () => {
    const reversal = journal({
      journalId: REVERSAL_JOURNAL_ID,
      source: 'reversal',
      reversesJournalId: JOURNAL_ID,
    });
    stub('GET', '/v1/journals', () => json(200, { items: [reversal], nextCursor: null }));

    renderList();

    expect(await screen.findByText('Reversal')).toBeInTheDocument();
  });

  it('says so when nothing has posted yet', async () => {
    stub('GET', '/v1/journals', () => json(200, { items: [], nextCursor: null }));

    renderList();

    expect(await screen.findByText('No journals have been posted yet.')).toBeInTheDocument();
  });

  it('flags a further page rather than silently listing only the first', async () => {
    stub('GET', '/v1/journals', () =>
      json(200, { items: [journal()], nextCursor: 'cursor-2' }),
    );

    renderList();

    await screen.findByRole('button', { name: '42' });
    expect(screen.getByText(/Showing the first page/)).toBeInTheDocument();
  });

  it('surfaces a failed load with a retry', async () => {
    stub('GET', '/v1/journals', () => apiError(500, 'internal_error', 'Something broke.'));

    renderList();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});
