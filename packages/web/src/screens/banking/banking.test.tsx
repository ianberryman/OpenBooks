import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The banking section's routing, and the one bug it exists to prevent.
 *
 * The tabs are `NavLink`s and this wrapper mounts under the `/banking/*` splat, so a
 * relative `to` would resolve against the current URL and append — clicking Import from
 * `/banking/match` would land on `/banking/match/import`, which no child route matches, so
 * the `*` catch-all would redirect again and the URL would grow without bound (an OOM the
 * E2E caught). Absolute paths resolve the same from every sub-route; this test clicks a tab
 * from a sub-route and asserts the path is replaced, not appended.
 *
 * Only `fetch` is stubbed — a catch-all empty response so the mounted sub-screen's own
 * queries resolve to nothing rather than erroring; the assertion is on the URL, not content.
 */
const { fetchMock } = vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', 'http://openbooks.test');
  const fetchMock = vi.fn<(request: Request) => Promise<Response>>();
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock };
});

import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import { createQueryClient } from '../../query/client';
import { BankingScreen } from '.';

function empty(): Response {
  return new Response(JSON.stringify({ items: [], nextCursor: null }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function CurrentPath(): ReactElement {
  return <output data-testid="path">{useLocation().pathname}</output>;
}

function renderAt(path: string): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <CurrentPath />
        <Routes>
          <Route path="/banking/*" element={<BankingScreen />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('the banking section routing', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(() => Promise.resolve(empty()));
  });

  it('clicking a tab replaces the sub-route, it does not append to it', async () => {
    renderAt('/banking/match');
    expect(screen.getByTestId('path')).toHaveTextContent('/banking/match');

    await userEvent.click(screen.getByRole('link', { name: 'Import' }));

    // The bug produced `/banking/match/import`; the fix lands exactly on `/banking/import`.
    expect(screen.getByTestId('path')).toHaveTextContent('/banking/import');
  });

  it('an unknown sub-route redirects to match, without looping', () => {
    renderAt('/banking/nonsense');
    expect(screen.getByTestId('path')).toHaveTextContent('/banking/match');
  });
});
