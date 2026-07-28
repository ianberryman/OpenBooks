import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement, ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type * as ApiModule from '../../api';
import { ReportsScreen } from '../reports';
import { UnusedControlNotice } from './controls';
import { initialFilterState } from './filters';

/**
 * The screen itself, and the one guarantee the shared controls carry that no single viewer
 * can: a control the reader has set which this report does not accept is **said**, not
 * dropped.
 *
 * The four endpoints take different subsets of one filter state — the trial balance takes
 * an upper bound and nothing else — and a reader who filtered by department and then
 * switched to it would otherwise be comparing a slice against the whole with nothing on
 * screen to say so.
 */

const DEPT = '11111111-1111-4111-8111-111111111111';

describe('UnusedControlNotice', () => {
  it('says nothing when every control reaches the report', () => {
    render(
      <UnusedControlNotice
        state={initialFilterState('2026-06-30')}
        capabilities={{ dates: 'range', dimensions: true, groupBy: true }}
      />,
    );

    expect(screen.queryByText(/does not take/)).toBeNull();
  });

  it('names the filters a report will ignore rather than dropping them silently', () => {
    render(
      <UnusedControlNotice
        state={{
          ...initialFilterState('2026-06-30'),
          from: '2026-01-01',
          groupBy: DEPT,
          axes: [{ dimensionId: DEPT, valueIds: ['sales'], includeUnassigned: false }],
        }}
        capabilities={{ dates: 'asOf', dimensions: false, groupBy: false }}
      />,
    );

    expect(
      screen.getByText(/does not take the dimension filters or the slice axis or the start date/),
    ).toBeInTheDocument();
  });

  it('does not warn about an axis a report can slice by', () => {
    render(
      <UnusedControlNotice
        state={{ ...initialFilterState('2026-06-30'), groupBy: DEPT }}
        capabilities={{ dates: 'asOf', dimensions: true, groupBy: true }}
      />,
    );

    expect(screen.queryByText(/does not take/)).toBeNull();
  });
});

/**
 * A mount of the whole screen against a stubbed client. Not a substitute for OB-055's
 * browser run — what it proves is that the exported component mounts, that the four viewers
 * are reachable, and that each asks its own endpoint.
 *
 * The module is mocked rather than `globalThis.fetch`, because `createApiClient` captures
 * `fetch` when the module singleton is built — a stub installed afterwards is never
 * consulted, and the symptom is a transport error rather than a missing stub.
 */
vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  const responses = new Map<string, unknown>([
    ['/v1/dimensions', { items: [], nextCursor: null }],
    [
      '/v1/reports/trial-balance',
      {
        asOf: '2026-06-30',
        rows: [
          {
            accountId: 'bank',
            code: '1000',
            name: 'Bank',
            type: 'asset',
            normalBalance: 'debit',
            debits: '500000',
            credits: '0',
            balance: '500000',
          },
        ],
        totalDebits: '500000',
        totalCredits: '500000',
        difference: '0',
      },
    ],
    [
      '/v1/reports/profit-and-loss',
      {
        basis: 'accrual',
        groupBy: null,
        range: { from: null, to: '2026-06-30' },
        review: [],
        groups: [
          {
            key: null,
            revenue: { rows: [], total: '0' },
            expenses: { rows: [], total: '0' },
            netIncome: '0',
          },
        ],
        totals: { revenue: '0', expenses: '0', netIncome: '0' },
      },
    ],
  ]);

  return {
    ...actual,
    api: {
      GET: (path: string) =>
        Promise.resolve({
          data: responses.get(path) ?? { items: [], nextCursor: null },
          response: new Response(null, { status: 200 }),
        }),
    },
  };
});

function Providers({ children }: { readonly children: ReactNode }): ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('ReportsScreen', () => {
  it('opens on the trial balance and reaches the other three', async () => {
    const user = userEvent.setup();
    render(
      <Providers>
        <ReportsScreen />
      </Providers>,
    );

    expect(await screen.findByRole('table', { name: 'Trial balance' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Profit and loss' }));
    expect(await screen.findByRole('heading', { name: 'Profit and loss' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'General ledger' }));
    expect(
      await screen.findByText(/Choose an account, or open one from any line/),
    ).toBeInTheDocument();
  });

  /** The trial balance is M1's endpoint: one upper bound, no range. */
  it('offers only the controls the current report accepts', async () => {
    const user = userEvent.setup();
    render(
      <Providers>
        <ReportsScreen />
      </Providers>,
    );

    expect(screen.getByText('As at')).toBeInTheDocument();
    expect(screen.queryByText('From')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Profit and loss' }));
    expect(screen.getByText('From')).toBeInTheDocument();
    expect(screen.getByText('To')).toBeInTheDocument();
  });
});
