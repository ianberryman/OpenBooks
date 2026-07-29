import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { StubRoute } from './test-support';
import { installApiStub, renderWithQueryClient } from './test-support';

/**
 * Dunning (OB-132).
 *
 * Three things are worth a test. **The list tells an active policy from a paused one and
 * says how many stages each carries** without the operator opening it — the same reason
 * `dimensions.tsx` puts the axis count on the heading row rather than behind a click.
 * **The create form opens on a ladder that already has something in it** (one blank stage),
 * because a form that started empty could not be saved until a stage was added by hand, and
 * the "Stages" list would look like an omission rather than a starting point. **A create
 * carries one idempotency key and sends the ladder with `stageNumber` derived from row
 * order** — the same property `dimensions.test.tsx` proves for `code`, applied to the field
 * this screen owns instead: `stageNumber` is never something the user types.
 */
const { DunningScreen } = await import('../dunning');

interface StageFixture {
  stageNumber: number;
  offsetDays: number;
  subject: string;
  body: string;
  lateFeeMinor: string | null;
}

interface PolicyFixture {
  id: string;
  name: string;
  isActive: boolean;
  stages: StageFixture[];
}

function stage(stageNumber: number, offsetDays: number): StageFixture {
  return {
    stageNumber,
    offsetDays,
    subject: `Reminder ${String(stageNumber)}`,
    body: `This is stage ${String(stageNumber)}.`,
    lateFeeMinor: null,
  };
}

function policy(
  id: string,
  name: string,
  isActive: boolean,
  stages: StageFixture[],
): PolicyFixture {
  return { id, name, isActive, stages };
}

const EMPTY_AGING = {
  status: 200,
  body: {
    asOf: '2026-07-28',
    ledger: 'receivable',
    rows: [],
    totals: {
      current: '0',
      days1To30: '0',
      days31To60: '0',
      days61To90: '0',
      days90Plus: '0',
      total: '0',
    },
  },
};

function baseRoutes(policies: readonly PolicyFixture[]): StubRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/dunning-policies',
      reply: () => ({ status: 200, body: { items: policies, nextCursor: null } }),
    },
    {
      method: 'GET',
      path: '/v1/reports/aging',
      reply: () => EMPTY_AGING,
    },
  ];
}

describe('DunningScreen', () => {
  it('shows each policy’s stage count and whether it is active or paused', async () => {
    const policies = [
      policy('policy-standard', 'Standard 7/30/60', true, [
        stage(1, 7),
        stage(2, 30),
        stage(3, 60),
      ]),
      policy('policy-gentle', 'Gentle nudge', false, [stage(1, 14)]),
    ];
    installApiStub(baseRoutes(policies));
    renderWithQueryClient(<DunningScreen />);

    expect(await screen.findByText('Standard 7/30/60')).toBeInTheDocument();
    expect(screen.getByText('3 stages')).toBeInTheDocument();
    expect(screen.getByText('Gentle nudge')).toBeInTheDocument();
    expect(screen.getByText('1 stage')).toBeInTheDocument();

    const activeRow = screen.getByText('Standard 7/30/60').closest('tr');
    const pausedRow = screen.getByText('Gentle nudge').closest('tr');
    expect(activeRow).not.toBeNull();
    expect(pausedRow).not.toBeNull();
    expect(within(activeRow as HTMLElement).getByText('Active')).toBeInTheDocument();
    expect(within(pausedRow as HTMLElement).getByText('Paused')).toBeInTheDocument();
  });

  it('opens the create form on a ladder that already has one stage', async () => {
    installApiStub(baseRoutes([]));
    const user = userEvent.setup();
    renderWithQueryClient(<DunningScreen />);

    await user.click(await screen.findByRole('button', { name: 'New policy' }));

    const dialog = await screen.findByRole('dialog', { name: 'New policy' });
    expect(within(dialog).getByText('Stage 1')).toBeInTheDocument();
    expect(within(dialog).queryByText('Stage 2')).toBeNull();
    expect(within(dialog).getByLabelText('Name')).toHaveValue('');
    expect(within(dialog).getByLabelText('Send offset')).toHaveValue('7');
  });

  it('creates a policy with one idempotency key and a derived stageNumber', async () => {
    const stub = installApiStub([
      {
        method: 'POST',
        path: '/v1/dunning-policies',
        reply: ({ body }) => ({
          status: 201,
          body: { id: 'policy-new', isActive: true, ...(body as object) },
        }),
      },
      ...baseRoutes([]),
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<DunningScreen />);

    await user.click(await screen.findByRole('button', { name: 'New policy' }));
    const dialog = await screen.findByRole('dialog', { name: 'New policy' });

    await user.type(within(dialog).getByLabelText('Name'), 'Standard');
    await user.type(within(dialog).getByLabelText('Subject'), 'Your invoice is overdue');
    await user.type(
      within(dialog).getByLabelText('Body'),
      'Please pay at your earliest convenience.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Create policy' }));

    await waitFor(() => {
      expect(stub.keysFor('POST', '/v1/dunning-policies')).toHaveLength(1);
    });
    const key = stub.keysFor('POST', '/v1/dunning-policies')[0];
    expect(key).toMatch(/^[0-9a-f-]{36}$/);

    expect(stub.calls.find((call) => call.method === 'POST')?.body).toEqual({
      name: 'Standard',
      stages: [
        {
          stageNumber: 1,
          offsetDays: 7,
          subject: 'Your invoice is overdue',
          body: 'Please pay at your earliest convenience.',
          lateFeeMinor: null,
        },
      ],
    });
  });
});
