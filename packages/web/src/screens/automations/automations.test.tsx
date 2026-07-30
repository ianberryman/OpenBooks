import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { StubRoute } from './test-support';
import { installApiStub, renderWithQueryClient } from './test-support';

/**
 * Automations (initiative Q; ROADMAP D-99, D-100, D-119).
 *
 * Three things are worth a test:
 *
 * 1. **The list reads trigger, action count and active state off the automation rather
 *    than deriving them** — the same reason `recurring-invoices.test.tsx`'s first test
 *    gives for a template.
 * 2. **A create carries one idempotency key and the exact body the contract describes** —
 *    a manual trigger and one complete `annotate` action, the form's default seed.
 * 3. **Activate is `POST …/activate`, never a `PATCH`** — the compose-vs-activate split
 *    (`UpdateAutomationRequest`'s own comment) is only real if the row control this screen
 *    offers actually reaches the separate route and not the general update.
 */
const { AutomationsScreen } = await import('../automations');

const AUTOMATION_ID = '55555555-5555-4555-8555-555555555555';

function automation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: AUTOMATION_ID,
    name: 'Flag stale drafts',
    isActive: false,
    trigger: { type: 'manual' },
    actions: [{ type: 'annotate', note: 'Checked for stale drafts.' }],
    lastFiredRunDate: null,
    ...overrides,
  };
}

function listRoute(automations: readonly Record<string, unknown>[]): StubRoute {
  return {
    method: 'GET',
    path: '/v1/automations',
    reply: () => ({ status: 200, body: { items: automations, nextCursor: null } }),
  };
}

describe('AutomationsScreen', () => {
  it('reads trigger, action count and active state off the automation rather than deriving them', async () => {
    installApiStub([
      listRoute([
        automation({
          trigger: { type: 'scheduled', cadence: 'weekly' },
          actions: [
            { type: 'annotate', note: 'One' },
            { type: 'agent_task', prompt: 'Summarize it', sourceKind: 'automation' },
          ],
          isActive: true,
        }),
      ]),
    ]);
    renderWithQueryClient(<AutomationsScreen />);

    expect(await screen.findByText('Flag stale drafts')).toBeInTheDocument();
    expect(screen.getByText('Scheduled · weekly')).toBeInTheDocument();
    expect(screen.getByText('2 actions')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('creates an automation with one idempotency key and the exact body the contract describes', async () => {
    const stub = installApiStub([
      listRoute([]),
      {
        method: 'POST',
        path: '/v1/automations',
        reply: ({ body }) => ({
          status: 201,
          body: { ...(body as object), id: AUTOMATION_ID, isActive: false, lastFiredRunDate: null },
        }),
      },
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<AutomationsScreen />);

    await user.click(await screen.findByRole('button', { name: 'New automation' }));

    const dialog = await screen.findByRole('dialog', { name: 'New automation' });
    await user.type(within(dialog).getByLabelText('Name'), 'Flag stale drafts');
    // The form seeds one blank `annotate` action — filling its note is enough to submit,
    // with no need to click "Add annotate" first.
    await user.type(within(dialog).getByLabelText('Note'), 'Checked for stale drafts.');

    await user.click(within(dialog).getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(stub.keysFor('POST', '/v1/automations')).toHaveLength(1);
    });
    const created = stub.calls.find((call) => call.method === 'POST');
    expect(created?.body).toEqual({
      name: 'Flag stale drafts',
      trigger: { type: 'manual' },
      actions: [{ type: 'annotate', note: 'Checked for stale drafts.' }],
    });
    expect(created?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('activates through the dedicated route, never the general update', async () => {
    const stub = installApiStub([
      listRoute([automation({ isActive: false })]),
      {
        method: 'POST',
        path: '/v1/automations/:automationId/activate',
        reply: () => ({ status: 200, body: automation({ isActive: true }) }),
      },
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<AutomationsScreen />);

    await user.click(await screen.findByRole('button', { name: 'Activate Flag stale drafts' }));

    await waitFor(() => {
      expect(stub.calls.some((call) => call.method === 'POST')).toBe(true);
    });
    const activated = stub.calls.find((call) => call.method === 'POST');
    expect(activated?.path).toBe(`/v1/automations/${AUTOMATION_ID}/activate`);
    expect(activated?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(stub.calls.some((call) => call.method === 'PATCH')).toBe(false);
  });
});
