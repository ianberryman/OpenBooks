import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CallerIdentity } from '../auth/identity';
import { createQueryClient } from '../query/client';
import { OrgControls } from './org-switcher';
import { QueryScopeBoundary } from './query-scope';

/**
 * The org switch, which is the one control in this ticket that is a security boundary.
 *
 * `src/query/client.ts` states the rule: nothing in a query key mentions the org, because
 * the org was never a parameter — it was ambient. So on the far side of a switch every
 * cached entry is another tenant's rows sitting under a key the new org's screens read, and
 * the clear is what stops the UI rendering from memory what the database would have refused
 * to serve (A7, OB-013).
 *
 * Two claims are asserted, and the first is the one that distinguishes a real clear from the
 * plausible wrong answer. `invalidateQueries` marks entries stale and keeps them **resident**,
 * and TanStack's whole design is to render stale data immediately while refetching — so a
 * test that only watched an observed query eventually show the right rows would pass against
 * an implementation that renders the previous tenant's rows first. The unobserved key below
 * is therefore the discriminating assertion: it survives an invalidation and cannot survive a
 * clear.
 *
 * The second claim is that the clear reaches what is already on screen. It does not on its
 * own: `QueryCache.clear()` destroys each query without notifying the observers attached to
 * it, so a screen mounted before the switch goes on displaying what it last rendered. That
 * measurement is what `src/shell/query-scope.tsx` exists for, and the mounted screen here is
 * what would fail if the remount were dropped.
 */
vi.mock('../env', () => ({ API_BASE_URL: 'http://localhost' }));

const ORG_A = '00000000-0000-4000-8000-0000000000a1';
const ORG_B = '00000000-0000-4000-8000-0000000000b2';

const IDENTITY: CallerIdentity = {
  user: { id: 'u-1', email: 'ian@example.test', displayName: 'Ian' },
  activeOrgId: ORG_A,
  permissions: ['orgs.read', 'accounts.read'],
  memberships: [
    {
      org: { id: ORG_A, name: 'Northwind Books', slug: 'northwind-books', fiscalYearStartMonth: 1 },
      roleId: 'r-1',
      roleCode: 'owner',
    },
    {
      org: { id: ORG_B, name: 'Client Ltd', slug: 'client-ltd', fiscalYearStartMonth: 4 },
      roleId: 'r-2',
      roleCode: 'read_only',
    },
  ],
};

/** The server's notion of the active org, which is what `POST /v1/orgs/active` moves. */
let serverActiveOrg = ORG_A;
let tenantFetches = 0;

/**
 * A screen that was already mounted when the switch happened, holding org-scoped rows under
 * a key that says nothing about the org — which is every screen in this application.
 */
function TenantScreen(): ReactElement {
  const rows = useQuery({
    queryKey: ['tenant-rows'],
    queryFn: () => {
      tenantFetches += 1;
      return Promise.resolve(`rows for ${serverActiveOrg}`);
    },
  });
  return <p data-testid="rows">{rows.data ?? 'loading'}</p>;
}

function Harness({ queryClient }: { readonly queryClient: QueryClient }): ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <QueryScopeBoundary>
          <OrgControls identity={IDENTITY} />
          <TenantScreen />
        </QueryScopeBoundary>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

/**
 * `openapi-fetch` reads `globalThis.fetch` once, when `createClient` runs — which is at
 * import time of `src/api/client.ts`, since the client is a module singleton. A
 * `vi.stubGlobal` in a test body therefore reaches nothing, and the calls go to the real
 * `fetch`. `vi.hoisted` runs before the imports, which is early enough.
 */
const fetchMock = vi.hoisted(() => {
  const mock = vi.fn<typeof fetch>();
  globalThis.fetch = mock;
  return mock;
});

function stubFetch(respond: (method: string, path: string) => Response): void {
  fetchMock.mockImplementation((input) => {
    if (!(input instanceof Request)) throw new Error('the generated client sends a Request');
    return Promise.resolve(respond(input.method, new URL(input.url).pathname));
  });
}

function membershipResponse(orgId: string): Response {
  const membership = IDENTITY.memberships.find((candidate) => candidate.org.id === orgId);
  return new Response(JSON.stringify(membership), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  serverActiveOrg = ORG_A;
  tenantFetches = 0;
});

afterEach(() => {
  fetchMock.mockReset();
});

describe('the org switcher', () => {
  it('empties the query cache wholesale and makes the mounted screen re-ask', async () => {
    stubFetch((method, path) => {
      if (method === 'POST' && path === '/v1/orgs/active') {
        serverActiveOrg = ORG_B;
        return membershipResponse(ORG_B);
      }
      throw new Error(`unexpected ${method} ${path}`);
    });

    const queryClient = createQueryClient();
    // Fetched under org A and observed by nothing. An invalidation would leave it here.
    queryClient.setQueryData(['trial-balance'], { totalDebits: '150000' });

    const user = userEvent.setup();
    render(<Harness queryClient={queryClient} />);
    await screen.findByText(`rows for ${ORG_A}`);
    expect(tenantFetches).toBe(1);

    await user.click(screen.getByRole('combobox', { name: 'Active organization' }));
    await user.click(screen.getByRole('option', { name: 'Client Ltd' }));

    await screen.findByText(`rows for ${ORG_B}`);
    expect(queryClient.getQueryData(['trial-balance'])).toBeUndefined();
    expect(tenantFetches).toBe(2);
  });

  it('leaves the cache alone when the switch is refused', async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ error: { code: 'not_found', message: 'Not found.' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
    );

    const queryClient = createQueryClient();
    queryClient.setQueryData(['trial-balance'], { totalDebits: '150000' });

    const user = userEvent.setup();
    render(<Harness queryClient={queryClient} />);
    await screen.findByText(`rows for ${ORG_A}`);

    await user.click(screen.getByRole('combobox', { name: 'Active organization' }));
    await user.click(screen.getByRole('option', { name: 'Client Ltd' }));

    // A refused switch left the session pointed where it was, so the cached rows are still
    // this org's and discarding them would be a spurious refetch of everything on screen.
    await screen.findByText('Not found');
    await waitFor(() => {
      expect(queryClient.getQueryData(['trial-balance'])).toEqual({ totalDebits: '150000' });
    });
    expect(tenantFetches).toBe(1);
  });
});
