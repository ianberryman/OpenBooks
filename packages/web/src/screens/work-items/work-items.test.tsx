import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { StubRoute } from './test-support';
import { installApiStub, renderWithQueryClient } from './test-support';

/**
 * The work queue (Q4…Q7; ROADMAP D-118).
 *
 * Three things are worth a test:
 *
 * 1. **A row reads prompt, status, attempts, flagged and provenance off the item, and
 *    offers "Review proposal" exactly when `proposedDraftId` is set** — the one signal
 *    that a human has something to act on for this item at all.
 * 2. **Cancel is offered only for `queued`/`leased` items, never a `proposed`, `failed` or
 *    `cancelled` one** — there is nothing left in the queue to withdraw once an item has
 *    left it.
 * 3. **Cancel sends one idempotency key to the dedicated route.**
 */
const { WorkQueueScreen } = await import('../work-items');

const QUEUED_ID = '66666666-6666-4666-8666-666666666666';
const PROPOSED_ID = '77777777-7777-4777-8777-777777777777';
const DRAFT_ID = '88888888-8888-4888-8888-888888888888';

function workItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: QUEUED_ID,
    automationId: null,
    sourceKind: 'automation',
    sourceRef: null,
    prompt: 'Summarize this quarter’s AR aging.',
    context: {},
    status: 'queued',
    attempts: 0,
    flagged: false,
    proposedDraftId: null,
    agentModel: null,
    leasedBy: null,
    leaseExpiresAt: null,
    submittedAt: null,
    lastError: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function listRoute(items: readonly Record<string, unknown>[]): StubRoute {
  return {
    method: 'GET',
    path: '/v1/work-items',
    reply: () => ({ status: 200, body: { items, nextCursor: null } }),
  };
}

describe('WorkQueueScreen', () => {
  it('reads status, attempts, flagged and provenance off the item and links a proposed draft', async () => {
    installApiStub([
      listRoute([
        workItem({
          attempts: 2,
          flagged: true,
          agentModel: 'test-model',
          status: 'proposed',
          proposedDraftId: DRAFT_ID,
          id: PROPOSED_ID,
        }),
      ]),
    ]);
    renderWithQueryClient(<WorkQueueScreen />);

    expect(await screen.findByText('Summarize this quarter’s AR aging.')).toBeInTheDocument();
    expect(screen.getByText('proposed')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('Yes')).toBeInTheDocument();
    expect(screen.getByText('test-model')).toBeInTheDocument();

    // No per-item route exists into the review queue, so the link goes to the queue as a
    // whole (`list.tsx`'s own note).
    const link = screen.getByRole('link', { name: 'Review proposal' });
    expect(link).toHaveAttribute('href', '/agent-proposals');
  });

  it('offers Cancel only while an item is still queued or leased', async () => {
    installApiStub([
      listRoute([
        workItem({ id: QUEUED_ID, status: 'queued' }),
        workItem({ id: PROPOSED_ID, status: 'proposed', proposedDraftId: DRAFT_ID }),
      ]),
    ]);
    renderWithQueryClient(<WorkQueueScreen />);

    // Both stub rows carry the factory's default prompt, so wait on all of them.
    await screen.findAllByText('Summarize this quarter’s AR aging.');
    // Only the queued row's cancel control renders — one "Cancel work item …" button, not
    // two — since the proposed row has left the part of its lifecycle Cancel withdraws it
    // from.
    expect(screen.getAllByRole('button', { name: /Cancel work item/ })).toHaveLength(1);
  });

  it('cancels a queued item with one idempotency key against the dedicated route', async () => {
    const stub = installApiStub([
      listRoute([workItem({ id: QUEUED_ID, status: 'queued' })]),
      {
        method: 'POST',
        path: '/v1/work-items/:workItemId/cancel',
        reply: () => ({ status: 200, body: workItem({ id: QUEUED_ID, status: 'cancelled' }) }),
      },
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<WorkQueueScreen />);

    await user.click(await screen.findByRole('button', { name: `Cancel work item ${QUEUED_ID}` }));

    await waitFor(() => {
      expect(stub.keysFor('POST', `/v1/work-items/${QUEUED_ID}/cancel`)).toHaveLength(1);
    });
  });
});
