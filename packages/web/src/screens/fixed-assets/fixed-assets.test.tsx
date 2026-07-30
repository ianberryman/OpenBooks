import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { StubRoute } from './test-support';
import { installApiStub, renderWithQueryClient } from './test-support';

/**
 * Fixed assets (OB-163…OB-167; ROADMAP D-113…D-116).
 *
 * Three things are worth a test:
 *
 * 1. **The list reads what the server computed and says so plainly** — method, in-service
 *    date and status, none of it recomputed here (the schedule itself is a separate fetch,
 *    `schedule-view.tsx`'s own concern).
 * 2. **A registration carries one idempotency key, the exact body the contract describes,
 *    and the org's depreciation-account defaults when the user never touched those two
 *    pickers** — `CreateFixedAssetRequest`'s own words: absent falls back to the org
 *    default, and this form seeds the pickers from it rather than leaving them empty.
 * 3. **Disposal sends `proceedsAccountId` only when proceeds are actually greater than
 *    zero** — the server's own pairing rule, mirrored on the client so the field neither
 *    appears nor is required when proceeds are `"0"`.
 */
const { FixedAssetsScreen } = await import('../fixed-assets');

const TIMESTAMPS = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };

const ASSET_ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const ACCUM_ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
const EXPENSE_ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';
const GAIN_LOSS_ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';
const FIXED_ASSET_ID = '55555555-5555-4555-8555-555555555555';

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

const ASSET_ACCOUNT = account({
  id: ASSET_ACCOUNT_ID,
  code: '1500',
  name: 'Vehicles',
  type: 'asset',
  normalBalance: 'debit',
});

const ACCUM_ACCOUNT = account({
  id: ACCUM_ACCOUNT_ID,
  code: '1510',
  name: 'Accumulated depreciation — vehicles',
  type: 'asset',
  normalBalance: 'credit',
});

const EXPENSE_ACCOUNT = account({
  id: EXPENSE_ACCOUNT_ID,
  code: '6100',
  name: 'Depreciation expense',
  type: 'expense',
  normalBalance: 'debit',
});

const GAIN_LOSS_ACCOUNT = account({
  id: GAIN_LOSS_ACCOUNT_ID,
  code: '7100',
  name: 'Gain/loss on disposal',
  type: 'revenue',
  normalBalance: 'credit',
});

function fixedAsset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: FIXED_ASSET_ID,
    name: 'Delivery van',
    description: null,
    assetAccountId: ASSET_ACCOUNT_ID,
    accumulatedDepreciationAccountId: ACCUM_ACCOUNT_ID,
    depreciationExpenseAccountId: EXPENSE_ACCOUNT_ID,
    acquisitionCostMinor: '500000',
    salvageValueMinor: '0',
    method: 'straight_line',
    decliningRatePpm: null,
    usefulLifeMonths: 60,
    inServiceDate: '2026-01-01',
    status: 'active',
    disposedDate: null,
    disposalJournalId: null,
    ...TIMESTAMPS,
    ...overrides,
  };
}

/** The reference-data routes every render needs, regardless of what the test is about. */
function referenceRoutes(
  depreciationDefaults: Record<string, unknown> = {
    accumulatedDepreciationAccountId: ACCUM_ACCOUNT_ID,
    depreciationExpenseAccountId: EXPENSE_ACCOUNT_ID,
  },
): StubRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/accounts',
      reply: () => ({
        status: 200,
        body: {
          items: [ASSET_ACCOUNT, ACCUM_ACCOUNT, EXPENSE_ACCOUNT, GAIN_LOSS_ACCOUNT],
          nextCursor: null,
        },
      }),
    },
    {
      method: 'GET',
      path: '/v1/settings/depreciation-accounts',
      reply: () => ({ status: 200, body: depreciationDefaults }),
    },
  ];
}

function listRoute(assets: readonly Record<string, unknown>[]): StubRoute {
  return {
    method: 'GET',
    path: '/v1/fixed-assets',
    reply: () => ({ status: 200, body: { items: assets, nextCursor: null } }),
  };
}

describe('FixedAssetsScreen', () => {
  it('reads method, in-service date and status off the asset rather than deriving them', async () => {
    installApiStub([...referenceRoutes(), listRoute([fixedAsset()])]);
    renderWithQueryClient(<FixedAssetsScreen />);

    expect(await screen.findByText('Delivery van')).toBeInTheDocument();
    expect(screen.getByText('Vehicles')).toBeInTheDocument();
    expect(screen.getByText('Straight-line')).toBeInTheDocument();
    expect(screen.getByText('2026-01-01')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('shows a disposed asset with no dispose or edit action, never one still offered', async () => {
    installApiStub([...referenceRoutes(), listRoute([fixedAsset({ status: 'disposed' })])]);
    renderWithQueryClient(<FixedAssetsScreen />);

    expect(await screen.findByText('Delivery van')).toBeInTheDocument();
    expect(screen.getByText('Disposed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Dispose Delivery van/ })).not.toBeInTheDocument();
  });

  it(
    'registers an asset with one idempotency key, the exact body the contract describes, ' +
      "and the org's depreciation-account defaults for the two pickers nobody touched",
    async () => {
      const stub = installApiStub([
        ...referenceRoutes(),
        listRoute([]),
        {
          method: 'POST',
          path: '/v1/fixed-assets',
          reply: ({ body }) => ({
            status: 201,
            body: {
              ...(body as object),
              id: FIXED_ASSET_ID,
              status: 'active',
              disposedDate: null,
              disposalJournalId: null,
              ...TIMESTAMPS,
            },
          }),
        },
      ]);
      const user = userEvent.setup();
      renderWithQueryClient(<FixedAssetsScreen />);

      const registerButton = await screen.findByRole('button', { name: 'Register asset' });
      await waitFor(() => {
        expect(registerButton).toBeEnabled();
      });
      await user.click(registerButton);

      const dialog = await screen.findByRole('dialog', { name: 'Register fixed asset' });

      await user.type(within(dialog).getByLabelText('Name'), 'Delivery van');

      // Option lists open in their own Radix popover portal, appended alongside the
      // dialog's rather than nested inside it — `recurring-invoices.test.tsx`'s own reason
      // for picking an option off the unscoped `screen`.
      await user.click(within(dialog).getByRole('combobox', { name: 'Asset account' }));
      await user.click(await screen.findByText('Vehicles'));

      await user.type(within(dialog).getByLabelText('Acquisition cost'), '5000');

      fireEvent.change(within(dialog).getByLabelText('In-service date'), {
        target: { value: '2026-01-01' },
      });

      await user.type(within(dialog).getByLabelText('Useful life (months)'), '60');

      await user.click(within(dialog).getByRole('button', { name: 'Register' }));

      await waitFor(() => {
        expect(stub.keysFor('POST', '/v1/fixed-assets')).toHaveLength(1);
      });
      const created = stub.calls.find((call) => call.method === 'POST');
      expect(created?.body).toEqual({
        name: 'Delivery van',
        description: null,
        assetAccountId: ASSET_ACCOUNT_ID,
        // Neither picker was touched — both travel as the org's own defaults, exactly as
        // `registerFixedAsset` would have resolved them itself had the fields been absent.
        accumulatedDepreciationAccountId: ACCUM_ACCOUNT_ID,
        depreciationExpenseAccountId: EXPENSE_ACCOUNT_ID,
        acquisitionCostMinor: '500000',
        salvageValueMinor: '0',
        method: 'straight_line',
        decliningRatePpm: null,
        usefulLifeMonths: 60,
        inServiceDate: '2026-01-01',
      });
      expect(created?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    },
  );

  it('disposes without a proceeds account when proceeds are "0", and with one when they are not', async () => {
    const stub = installApiStub([
      ...referenceRoutes(),
      listRoute([fixedAsset()]),
      {
        method: 'POST',
        path: '/v1/fixed-assets/:fixedAssetId/dispose',
        reply: ({ body }) => ({
          status: 200,
          body: {
            ...fixedAsset(),
            status: 'disposed',
            disposedDate: (body as { date: string }).date,
            disposalJournalId: '66666666-6666-4666-8666-666666666666',
          },
        }),
      },
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<FixedAssetsScreen />);

    await user.click(await screen.findByRole('button', { name: 'Dispose Delivery van' }));

    const dialog = await screen.findByRole('dialog', { name: 'Dispose of Delivery van?' });

    fireEvent.change(within(dialog).getByLabelText('Disposal date'), {
      target: { value: '2026-06-30' },
    });

    // Proceeds default to "0" (the common, scrapped case) and no proceeds-account field is
    // shown at all while that holds — the server's own pairing rule, mirrored client-side.
    expect(within(dialog).queryByLabelText('Proceeds account')).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole('combobox', { name: 'Gain / loss account' }));
    await user.click(await screen.findByText('Gain/loss on disposal'));

    await user.click(within(dialog).getByRole('button', { name: 'Dispose' }));

    await waitFor(() => {
      expect(stub.keysFor('POST', '/v1/fixed-assets/:fixedAssetId/dispose')).toHaveLength(1);
    });
    const disposed = stub.calls.find((call) => call.method === 'POST');
    expect(disposed?.body).toEqual({
      date: '2026-06-30',
      proceedsMinor: '0',
      gainLossAccountId: GAIN_LOSS_ACCOUNT_ID,
    });
  });
});
