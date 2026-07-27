import { QueryClientProvider } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppRoutes } from './App';
import { IDENTITY_QUERY_KEY } from './auth/identity';
import type { CallerIdentity } from './auth/identity';
import { createQueryClient } from './query/client';
import { QueryScopeBoundary } from './shell/query-scope';
import { ThemeProvider } from './theme/theme';

/**
 * What the guard does with the three answers `GET /v1/auth/me` can give.
 *
 * The last case is the one worth stating plainly: a destination the navigation hides is still
 * a destination. D-25 makes the permission set advisory — it exists so the shell does not
 * offer actions that always fail — and the test below asserts that hiding a link denies
 * nothing, because the moment a route table starts refusing on permission, someone will read
 * it as the gate and a service check will go missing behind it.
 */
vi.mock('./env', () => ({ API_BASE_URL: 'http://localhost' }));

const fetchMock = vi.hoisted(() => {
  // `openapi-fetch` captures `globalThis.fetch` when the client singleton is constructed at
  // import time, so this has to happen before the imports run. See the same note in
  // `src/shell/org-switcher.test.tsx`.
  const mock = vi.fn<typeof fetch>();
  globalThis.fetch = mock;
  return mock;
});

/**
 * jsdom implements no media queries, and `ThemeProvider` reads one to decide whether to
 * follow a dark system preference. Stubbed here rather than in `src/test/setup.ts`, which
 * belongs to OB-058 and which five other screens are landing against concurrently; it is the
 * right long-term home for it.
 */
window.matchMedia = (media: string): MediaQueryList => ({
  media,
  matches: false,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
});

const ORG_ID = '00000000-0000-4000-8000-0000000000a1';

function identity(overrides: Partial<CallerIdentity>): CallerIdentity {
  return {
    user: { id: 'u-1', email: 'ian@example.test', displayName: 'Ian' },
    activeOrgId: ORG_ID,
    permissions: [],
    memberships: [
      {
        org: { id: ORG_ID, name: 'Northwind Books', slug: 'northwind', fiscalYearStartMonth: 1 },
        roleId: 'r-1',
        roleCode: 'owner',
      },
    ],
    ...overrides,
  };
}

function respondWith(status: number, body: unknown): void {
  fetchMock.mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

function signedOut(): void {
  respondWith(401, { error: { code: 'unauthenticated', message: 'Sign in to continue.' } });
}

function signedInAs(caller: CallerIdentity): void {
  respondWith(200, caller);
}

/** Renders the path the guard settled on, so a redirect is asserted rather than inferred. */
function LocationProbe(): ReactElement {
  return <p data-testid="path">{useLocation().pathname}</p>;
}

function renderAt(path: string, queryClient: QueryClient = createQueryClient()): void {
  render(
    <QueryClientProvider client={queryClient}>
      {/* The shell's theme toggle is above every route, including the auth screen — a login
          form is rendered in whichever theme the user needs to read it. */}
      <ThemeProvider>
        <MemoryRouter initialEntries={[path]}>
          <QueryScopeBoundary>
            <AppRoutes />
            <LocationProbe />
          </QueryScopeBoundary>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  fetchMock.mockReset();
});

describe('the route guard', () => {
  it('sends an unauthenticated visitor to the auth screen, from wherever they arrived', async () => {
    signedOut();
    renderAt('/reports');

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByTestId('path').textContent).toBe('/auth');
  });

  it('sends a signed-in caller with no active organization to org selection', async () => {
    signedInAs(identity({ activeOrgId: null, memberships: [] }));
    renderAt('/accounts');

    expect(
      await screen.findByRole('heading', { name: 'Choose an organization' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('path').textContent).toBe('/select-org');
  });

  it('keeps a caller with an active organization out of the auth screen', async () => {
    signedInAs(identity({ permissions: ['accounts.read'] }));
    renderAt('/auth');

    expect(await screen.findByRole('link', { name: 'Accounts' })).toBeInTheDocument();
    // Two hops, both `replace`: `/auth` is not a route for this caller, so the catch-all
    // sends them to `/`, which is where the landing choice is made.
    await waitFor(() => {
      expect(screen.getByTestId('path').textContent).toBe('/accounts');
    });
    expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument();
  });

  it('lands on the first destination the caller can use', async () => {
    signedInAs(identity({ permissions: ['reports.read'] }));
    renderAt('/');

    expect(await screen.findByRole('link', { name: 'Reports' })).toBeInTheDocument();
    expect(screen.getByTestId('path').textContent).toBe('/reports');
  });

  it('hides what the caller may not do without making the route refuse them (D-25)', async () => {
    signedInAs(identity({ permissions: ['accounts.read'] }));
    renderAt('/reports');

    expect(await screen.findByRole('link', { name: 'Accounts' })).toBeInTheDocument();
    // Hidden in the navigation…
    expect(screen.queryByRole('link', { name: 'Reports' })).not.toBeInTheDocument();
    // …and still reachable, which is what keeps the service the only gate. The screen
    // itself is another ticket's; what is asserted here is that no redirect happened.
    expect(screen.getByTestId('path').textContent).toBe('/reports');
  });

  it('offers a retry rather than a login form when the identity cannot be read', async () => {
    respondWith(503, { error: { code: 'internal_error', message: 'Nothing was saved.' } });

    // The backoff on a 5xx belongs to `src/query/client.ts` and is asserted there, not here.
    // Switched off for this case so that three of the five seconds this test is allowed are
    // not spent waiting for two retries whose outcome is already known.
    const queryClient = createQueryClient();
    queryClient.setQueryDefaults(IDENTITY_QUERY_KEY, { retry: false });
    renderAt('/accounts', queryClient);

    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument();
  });
});
