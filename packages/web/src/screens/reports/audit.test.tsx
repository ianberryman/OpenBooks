import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as ApiModule from '../../api';

/**
 * The audit trail (initiative P, OB-196).
 *
 * Worth asserting: an adjusting entry is flagged and a standard one is not (D-98's whole
 * point), a second page appends onto the first rather than replacing it (D-21, matching
 * `money-in/payments.tsx`'s "Load more"), and — the case this view exists to handle
 * gracefully — a `reports.read`-only caller who cannot read `/v1/reports/audit` sees a
 * plain access notice rather than the red `ErrorBanner` every other refusal gets, without
 * losing the tab's own toolbar.
 *
 * The module is mocked rather than `globalThis.fetch`, following `screen.test.tsx`'s
 * reasoning: `createApiClient` captures `fetch` at import time, so a stub installed on the
 * global afterwards is never consulted.
 */

const { state } = vi.hoisted(() => ({ state: { auditDenied: false, membersDenied: false } }));

afterEach(() => {
  state.auditDenied = false;
  state.membersDenied = false;
});

const ADA = { userId: 'user-1', displayName: 'Ada Lovelace' };

const ADJUSTING_ENTRY = {
  id: 'journal-1',
  kind: 'journal' as const,
  action: 'posted',
  occurredAt: '2026-03-15T14:00:00.000Z',
  actor: { type: 'user' as const, id: ADA.userId, name: ADA.displayName },
  summary: 'Adjusting entry No. 128',
  reference: '128',
  source: 'adjusting',
};

const STANDARD_ENTRY = {
  id: 'journal-2',
  kind: 'journal' as const,
  action: 'posted',
  occurredAt: '2026-03-14T09:00:00.000Z',
  actor: { type: 'user' as const, id: ADA.userId, name: ADA.displayName },
  summary: 'Entry No. 127',
  reference: '127',
  source: 'manual',
};

const CLOSE_ENTRY = {
  id: 'close-1',
  kind: 'period-close' as const,
  action: 'closed',
  occurredAt: '2026-03-01T00:00:00.000Z',
  actor: { type: 'user' as const, id: ADA.userId, name: ADA.displayName },
  summary: 'Closed 2026-02',
  reference: '2026-02',
  source: null,
};

function okResult(data: unknown): { data: unknown; response: Response } {
  return { data, response: new Response(null, { status: 200 }) };
}

function deniedResult(): { error: unknown; response: Response } {
  return {
    error: { error: { code: 'permission_denied', message: 'Missing audit.read.' } },
    response: new Response(null, { status: 403 }),
  };
}

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    api: {
      GET: (path: string, options?: { params?: { query?: Record<string, unknown> } }) => {
        const query = options?.params?.query ?? {};

        if (path === '/v1/reports/audit') {
          if (state.auditDenied) return Promise.resolve(deniedResult());
          if (query['cursor'] === undefined) {
            return Promise.resolve(
              okResult({ entries: [ADJUSTING_ENTRY, STANDARD_ENTRY], nextCursor: 'page-2' }),
            );
          }
          return Promise.resolve(okResult({ entries: [CLOSE_ENTRY], nextCursor: null }));
        }

        if (path === '/v1/members') {
          if (state.membersDenied) return Promise.resolve(deniedResult());
          return Promise.resolve(
            okResult({
              members: [
                {
                  ...ADA,
                  email: 'ada@example.com',
                  isActive: true,
                  roleId: 'role-owner',
                  roleCode: 'owner',
                  roleName: 'Owner',
                  invitedByUserId: null,
                  createdAt: '2026-01-01T00:00:00.000Z',
                  updatedAt: '2026-01-01T00:00:00.000Z',
                },
              ],
            }),
          );
        }

        return Promise.resolve(okResult({ items: [], nextCursor: null }));
      },
    },
  };
});

const { AuditView } = await import('./audit');

function Providers({ children }: { readonly children: ReactNode }): ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('AuditView', () => {
  it('flags an adjusting entry and leaves a standard one unmarked', async () => {
    render(
      <Providers>
        <AuditView />
      </Providers>,
    );

    const adjustingRow = (await screen.findByText('Adjusting entry No. 128')).closest('tr');
    expect(adjustingRow).not.toBeNull();
    expect(adjustingRow?.textContent).toContain('Adjusting');

    const standardRow = screen.getByText('Entry No. 127').closest('tr');
    expect(standardRow?.textContent).not.toContain('Adjusting');
    expect(standardRow?.textContent).not.toContain('Reclassifying');
  });

  it('appends the next page onto the first rather than replacing it', async () => {
    const user = userEvent.setup();
    render(
      <Providers>
        <AuditView />
      </Providers>,
    );

    await screen.findByText('Adjusting entry No. 128');
    await user.click(screen.getByRole('button', { name: 'Load more' }));

    await waitFor(() => {
      expect(screen.getByText('Closed 2026-02')).toBeInTheDocument();
    });
    // Both pages are on screen at once — a "Load more" list, not a replaced page.
    expect(screen.getByText('Adjusting entry No. 128')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('shows a plain access notice, not an error banner, when audit.read is missing', async () => {
    state.auditDenied = true;
    render(
      <Providers>
        <AuditView />
      </Providers>,
    );

    expect(await screen.findByText(/needs its own/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // The toolbar — including the actor picker — still renders around the notice.
    expect(screen.getByRole('combobox', { name: 'Actor' })).toBeInTheDocument();
  });

  it('still renders the trail when only the actor picker lacks its permission', async () => {
    state.membersDenied = true;
    render(
      <Providers>
        <AuditView />
      </Providers>,
    );

    expect(await screen.findByText('Adjusting entry No. 128')).toBeInTheDocument();
    // The picker offers only the "everyone" sentinel — no crash, no error banner for it.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
