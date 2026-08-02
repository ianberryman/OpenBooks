import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { StubRoute } from './test-support';
import { installApiStub, renderWithQueryClient } from './test-support';

/**
 * Loaded after `./test-support` — that module's own header explains why: it replaces
 * `globalThis.fetch`/`Request` at import time, and `openapi-fetch` captures both once,
 * inside `createClient`, during `src/api/client.ts`'s module evaluation. A static import of
 * either component ahead of the stub would build the API client against the real globals.
 */
const { PayoutSyncConfig } = await import('./payout-sync-config');
const { PayoutsReview } = await import('./payouts-review');

/**
 * `StubRoute['method']` is `'GET' | 'POST' | 'PATCH' | 'DELETE'` — `test-support.tsx` never
 * needed `PUT` before this screen. Widened locally rather than editing that shared file
 * (ADD-ONLY): `dispatch` in `test-support.tsx` matches a route by a plain string
 * `route.method !== request.method` comparison, so a `'PUT'` route works identically to any
 * other at runtime — only the exported type does not spell it.
 */
function putRoute(path: string, reply: StubRoute['reply']): StubRoute {
  return { method: 'PUT', path, reply } as unknown as StubRoute;
}

/**
 * Stripe payout sync (OB-237; ROADMAP D-237-1, D-237-2, D-237-6).
 *
 * Two things are worth a test:
 *
 * 1. **The config screen sends the whole mapping in one `PUT`, keyed by the account each
 *    category picker resolved to** — never a per-field write, because
 *    `UpdatePayoutSyncConfigRequest`'s own contract says the mapping is replaced wholesale.
 * 2. **Posting a `pending_review` payout carries one idempotency key to the dedicated
 *    `/post` route**, never a `PATCH` on the payout sync itself — there is no such route.
 */

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';
const REVENUE_ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
const FEE_ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';
const PAYOUT_SYNC_ID = '44444444-4444-4444-8444-444444444444';

const TIMESTAMPS = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };

function account(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    parentAccountId: null,
    description: null,
    cashBasisRole: null,
    isActive: true,
    ...TIMESTAMPS,
    ...overrides,
  };
}

const REVENUE_ACCOUNT = account({
  id: REVENUE_ACCOUNT_ID,
  code: '4000',
  name: 'Sales',
  type: 'revenue',
  normalBalance: 'credit',
});

const FEE_ACCOUNT = account({
  id: FEE_ACCOUNT_ID,
  code: '6100',
  name: 'Processor fees',
  type: 'expense',
  normalBalance: 'debit',
});

function accountsRoute(): StubRoute {
  return {
    method: 'GET',
    path: '/v1/accounts',
    reply: () => ({
      status: 200,
      body: { items: [REVENUE_ACCOUNT, FEE_ACCOUNT], nextCursor: null },
    }),
  };
}

function configRoute(overrides: Record<string, unknown> = {}): StubRoute {
  return {
    method: 'GET',
    path: `/v1/processing/connections/${CONNECTION_ID}/payout-sync/config`,
    reply: () => ({
      status: 200,
      body: {
        connectionId: CONNECTION_ID,
        syncMode: 'apply_payments',
        autoPost: false,
        entries: [],
        ...overrides,
      },
    }),
  };
}

function payoutSync(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: PAYOUT_SYNC_ID,
    connectionId: CONNECTION_ID,
    externalPayoutId: 'po_test_1',
    grossMinor: '10000',
    feeMinor: '300',
    netMinor: '9700',
    currency: 'usd',
    status: 'pending_review',
    breakdown: [{ reportingCategory: 'charge', amountMinor: '10000', count: 1 }],
    journalId: null,
    skipReason: null,
    occurredAt: '2026-07-01T12:00:00.000Z',
    postedAt: null,
    ...TIMESTAMPS,
    ...overrides,
  };
}

function listSyncsRoute(syncs: readonly Record<string, unknown>[]): StubRoute {
  return {
    method: 'GET',
    path: `/v1/processing/connections/${CONNECTION_ID}/payout-syncs`,
    reply: () => ({ status: 200, body: syncs }),
  };
}

/**
 * A mutable holder the `GET .../payout-syncs` stub reads on every call, so that
 * `usePostPayoutSync`/`useSkipPayoutSync`'s invalidate-then-refetch (`payout-sync-queries.
 * ts` has no server response to `setQueryData` from — `/post`/`/skip` return the one row,
 * not the list) picks up the write the way the real API would, instead of replaying a
 * frozen snapshot from before the mutation.
 */
function statefulListSyncsRoute(initial: readonly Record<string, unknown>[]): {
  readonly route: StubRoute;
  set: (syncs: readonly Record<string, unknown>[]) => void;
} {
  let current = initial;
  return {
    route: {
      method: 'GET',
      path: `/v1/processing/connections/${CONNECTION_ID}/payout-syncs`,
      reply: () => ({ status: 200, body: current }),
    },
    set: (syncs) => {
      current = syncs;
    },
  };
}

describe('PayoutSyncConfig', () => {
  it('switches to summary-sales mode, maps two categories, and saves the whole mapping in one PUT', async () => {
    const user = userEvent.setup();
    const stub = installApiStub([
      accountsRoute(),
      configRoute(),
      putRoute(`/v1/processing/connections/${CONNECTION_ID}/payout-sync/config`, ({ body }) => ({
        status: 200,
        body,
      })),
    ]);
    renderWithQueryClient(<PayoutSyncConfig connectionId={CONNECTION_ID} />);

    expect(await screen.findByRole('button', { name: 'Save' })).toBeDisabled();

    await user.click(screen.getByRole('combobox', { name: 'Sync mode' }));
    await user.click(await screen.findByRole('option', { name: 'Summary sales' }));

    await user.click(screen.getByRole('combobox', { name: 'Charges' }));
    await user.click(await screen.findByRole('option', { name: /Sales/ }));

    await user.click(screen.getByRole('combobox', { name: 'Processor fees' }));
    await user.click(await screen.findByRole('option', { name: /Processor fees/ }));

    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(stub.calls.some((call) => call.method === 'PUT')).toBe(true);
    });
    const put = stub.calls.find((call) => call.method === 'PUT');
    expect(put?.body).toEqual({
      syncMode: 'summary_sales',
      autoPost: false,
      entries: [
        { reportingCategory: 'charge', accountId: REVENUE_ACCOUNT_ID },
        { reportingCategory: 'fee', accountId: FEE_ACCOUNT_ID },
      ],
    });
    expect(put?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);

    expect(await screen.findByText(/Saved\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('disables auto-post until summary-sales mode is chosen', async () => {
    installApiStub([accountsRoute(), configRoute()]);
    renderWithQueryClient(<PayoutSyncConfig connectionId={CONNECTION_ID} />);

    const autoPost = await screen.findByRole('checkbox', {
      name: "Post each payout's summary journal automatically",
    });
    expect(autoPost).toBeDisabled();
  });
});

describe('PayoutsReview', () => {
  it('shows "No payouts to review yet." when the queue is empty', async () => {
    installApiStub([listSyncsRoute([])]);
    renderWithQueryClient(<PayoutsReview connectionId={CONNECTION_ID} />);

    expect(await screen.findByText('No payouts to review yet.')).toBeInTheDocument();
  });

  it('posts a pending_review payout through the dedicated /post route with one idempotency key', async () => {
    const user = userEvent.setup();
    const list = statefulListSyncsRoute([payoutSync()]);
    const stub = installApiStub([
      list.route,
      {
        method: 'POST',
        path: `/v1/processing/payout-syncs/${PAYOUT_SYNC_ID}/post`,
        reply: () => {
          const posted = payoutSync({
            status: 'posted',
            postedAt: '2026-07-02T00:00:00.000Z',
            journalId: 'j1',
          });
          list.set([posted]);
          return { status: 200, body: posted };
        },
      },
    ]);
    renderWithQueryClient(<PayoutsReview connectionId={CONNECTION_ID} />);

    expect(await screen.findByText('$100.00')).toBeInTheDocument();
    expect(screen.getByText('Pending review')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Post' }));

    await waitFor(() => {
      expect(stub.calls.some((call) => call.method === 'POST')).toBe(true);
    });
    const posted = stub.calls.find((call) => call.method === 'POST');
    expect(posted?.path).toBe(`/v1/processing/payout-syncs/${PAYOUT_SYNC_ID}/post`);
    expect(posted?.body).toBeUndefined();
    expect(posted?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);

    expect(await screen.findByText('Posted')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Post' })).not.toBeInTheDocument();
  });

  it('skips a pending_review payout through the dedicated /skip route, never a PATCH', async () => {
    const user = userEvent.setup();
    const list = statefulListSyncsRoute([payoutSync()]);
    const stub = installApiStub([
      list.route,
      {
        method: 'POST',
        path: `/v1/processing/payout-syncs/${PAYOUT_SYNC_ID}/skip`,
        reply: () => {
          const skipped = payoutSync({ status: 'skipped', skipReason: null });
          list.set([skipped]);
          return { status: 200, body: skipped };
        },
      },
    ]);
    renderWithQueryClient(<PayoutsReview connectionId={CONNECTION_ID} />);

    await user.click(await screen.findByRole('button', { name: 'Skip' }));

    await waitFor(() => {
      expect(stub.calls.some((call) => call.method === 'POST')).toBe(true);
    });
    const skipped = stub.calls.find((call) => call.method === 'POST');
    expect(skipped?.path).toBe(`/v1/processing/payout-syncs/${PAYOUT_SYNC_ID}/skip`);
    expect(skipped?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(stub.calls.some((call) => call.method === 'PATCH')).toBe(false);

    expect(await screen.findByText('No reason given')).toBeInTheDocument();
  });
});
