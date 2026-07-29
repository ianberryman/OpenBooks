import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { StubRoute } from './test-support';
import { installApiStub, renderWithQueryClient } from './test-support';

/**
 * The agent review queue (OB-105; OB-060, OB-103 — ROADMAP D-19, D-60).
 *
 * Three things are worth a test: the list shows pending proposals by their header alone,
 * the review dialog fetches and renders lines from `GET /v1/journal-drafts/{draftId}`
 * (see `queries.ts` for why that route and not one under `/v1/agent-proposals`), and
 * approve/reject each post to their own route with one idempotency key.
 */
const { AgentProposalsScreen } = await import('../agent-proposals');

const DRAFT_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';

const ACCOUNT = {
  id: ACCOUNT_ID,
  code: '4000',
  name: 'Consulting revenue',
  type: 'revenue',
  normalBalance: 'credit',
  parentAccountId: null,
  description: null,
  cashBasisRole: null,
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function proposalSummary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: DRAFT_ID,
    createdByUserId: '33333333-3333-4333-8333-333333333333',
    entryDate: '2026-01-15',
    memo: 'Monthly accrual',
    reference: null,
    createdAt: '2026-01-15T00:00:00.000Z',
    updatedAt: '2026-01-15T00:00:00.000Z',
    ...overrides,
  };
}

function draftDetail(): Record<string, unknown> {
  return {
    ...proposalSummary(),
    lines: [
      {
        lineId: 'line-1',
        lineNumber: 1,
        accountId: ACCOUNT_ID,
        contactId: null,
        amount: '100000',
        side: 'debit',
        memo: null,
        dimensionValueIds: [],
      },
    ],
  };
}

function accountsRoute(): StubRoute {
  return {
    method: 'GET',
    path: '/v1/accounts',
    reply: () => ({ status: 200, body: { items: [ACCOUNT], nextCursor: null } }),
  };
}

function listRoute(proposals: readonly Record<string, unknown>[]): StubRoute {
  return {
    method: 'GET',
    path: '/v1/agent-proposals',
    reply: () => ({ status: 200, body: { items: proposals, nextCursor: null } }),
  };
}

describe('AgentProposalsScreen', () => {
  it('lists pending proposals by their header, with no lines fetched up front', async () => {
    installApiStub([accountsRoute(), listRoute([proposalSummary()])]);
    renderWithQueryClient(<AgentProposalsScreen />);

    expect(await screen.findByText('Monthly accrual')).toBeInTheDocument();
    expect(screen.getByText('2026-01-15')).toBeInTheDocument();
  });

  it('reviews a proposal by fetching its lines from the journal-drafts route', async () => {
    installApiStub([
      accountsRoute(),
      listRoute([proposalSummary()]),
      {
        method: 'GET',
        path: '/v1/journal-drafts/:draftId',
        reply: () => ({ status: 200, body: draftDetail() }),
      },
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<AgentProposalsScreen />);

    await user.click(await screen.findByRole('button', { name: 'Review' }));

    const dialog = await screen.findByRole('dialog', { name: 'Review proposal' });
    expect(await within(dialog).findByText('4000 · Consulting revenue')).toBeInTheDocument();
    expect(within(dialog).getByText('1000.00')).toBeInTheDocument();
  });

  it('approves through the approve route with one idempotency key', async () => {
    const stub = installApiStub([
      accountsRoute(),
      listRoute([proposalSummary()]),
      {
        method: 'GET',
        path: '/v1/journal-drafts/:draftId',
        reply: () => ({ status: 200, body: draftDetail() }),
      },
      {
        method: 'POST',
        path: '/v1/agent-proposals/:draftId/approve',
        reply: () => ({
          status: 201,
          body: {
            id: '44444444-4444-4444-8444-444444444444',
            sequenceNumber: 1,
            entryDate: '2026-01-15',
            reference: null,
            memo: 'Monthly accrual',
            reversesJournalId: null,
            postedByUserId: '55555555-5555-4555-8555-555555555555',
            createdAt: '2026-01-15T00:00:00.000Z',
            lines: [],
          },
        }),
      },
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<AgentProposalsScreen />);

    await user.click(await screen.findByRole('button', { name: 'Review' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review proposal' });
    await within(dialog).findByText('4000 · Consulting revenue');

    await user.click(within(dialog).getByRole('button', { name: 'Approve and post' }));

    await waitFor(() => {
      expect(stub.keysFor('POST', '/v1/agent-proposals/:draftId/approve')).toHaveLength(1);
    });
    const approved = stub.calls.find((call) => call.method === 'POST');
    expect(approved?.path).toBe(`/v1/agent-proposals/${DRAFT_ID}/approve`);
  });

  it('rejects through the reject route, discarding rather than posting', async () => {
    const stub = installApiStub([
      accountsRoute(),
      listRoute([proposalSummary()]),
      {
        method: 'GET',
        path: '/v1/journal-drafts/:draftId',
        reply: () => ({ status: 200, body: draftDetail() }),
      },
      {
        method: 'POST',
        path: '/v1/agent-proposals/:draftId/reject',
        reply: () => ({ status: 204 }),
      },
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<AgentProposalsScreen />);

    await user.click(await screen.findByRole('button', { name: 'Review' }));
    const dialog = await screen.findByRole('dialog', { name: 'Review proposal' });
    await within(dialog).findByText('4000 · Consulting revenue');

    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));

    await waitFor(() => {
      expect(stub.keysFor('POST', '/v1/agent-proposals/:draftId/reject')).toHaveLength(1);
    });
    const rejected = stub.calls.find(
      (call) => call.method === 'POST' && call.path.endsWith('/reject'),
    );
    expect(rejected?.path).toBe(`/v1/agent-proposals/${DRAFT_ID}/reject`);
    expect(stub.calls.some((call) => call.path.endsWith('/approve'))).toBe(false);
  });
});
