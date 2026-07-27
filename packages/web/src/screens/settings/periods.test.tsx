import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StubReply, StubRoute } from './test-support';
import { installApiStub, renderWithQueryClient } from './test-support';

/**
 * Loaded after `./test-support`, never alongside it: the module replaces `globalThis.fetch`
 * and `globalThis.Request` at import time, and `src/api/client.ts` captures both when it
 * creates the singleton client. A static import of the component here would evaluate that
 * module first and every request in this file would fail to parse its own URL.
 */
const { FiscalPeriodsSection } = await import('./periods');

/**
 * Fiscal periods (OB-050; D-17).
 *
 * The case worth the harness is the **non-January org generating its first year**, because
 * it is where the two things this section exists for meet: an org with no periods can post
 * nothing at all, and "fiscal year 2025" for an April org means April 2025 to March 2026 —
 * an off-by-one that produces twelve periods in the wrong twelve months and is not visible
 * until an entry lands in a period nobody expected.
 *
 * The clock is fixed, because "the current fiscal year" is otherwise a different answer in
 * March than in April and the test would pass or fail by the calendar.
 */
const APRIL = 4;
const JANUARY = 1;

function identity(fiscalYearStartMonth: number): unknown {
  return {
    activeOrgId: 'org-1',
    permissions: ['periods.read', 'periods.write', 'periods.reopen'],
    user: { id: 'user-1', email: 'ada@example.com', displayName: 'Ada Lovelace' },
    memberships: [
      {
        org: { id: 'org-1', name: 'Acme', slug: 'acme', fiscalYearStartMonth },
        roleCode: 'owner',
        roleId: 'role-owner',
      },
    ],
  };
}

interface Period {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: 'open' | 'closed';
  closedAt: string | null;
  closedByUserId: string | null;
}

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function twelveMonths(fiscalYear: number, startMonth: number): Period[] {
  return Array.from({ length: 12 }, (_unused, offset) => {
    const absolute = startMonth - 1 + offset;
    const year = fiscalYear + Math.floor(absolute / 12);
    const month = (absolute % 12) + 1;
    const name = `${String(year)}-${String(month).padStart(2, '0')}`;
    const lastDay = MONTH_LENGTHS[month - 1] ?? 30;
    return {
      id: `period-${name}`,
      name,
      startDate: `${name}-01`,
      endDate: `${name}-${String(lastDay).padStart(2, '0')}`,
      status: 'open' as const,
      closedAt: null,
      closedByUserId: null,
    };
  });
}

/**
 * A stub that remembers, so that generating a year is followed by the list the invalidation
 * refetches rather than by the empty one the test started with — which is the half of the
 * flow a fixed response cannot exercise.
 */
function routes(startMonth: number, initial: readonly Period[] = []): StubRoute[] {
  const periods = [...initial];

  return [
    {
      method: 'GET',
      path: '/v1/auth/me',
      reply: () => ({ status: 200, body: identity(startMonth) }),
    },
    {
      method: 'GET',
      path: '/v1/fiscal-periods',
      reply: () => ({ status: 200, body: { periods } }),
    },
    {
      method: 'POST',
      path: '/v1/fiscal-years',
      reply: ({ body }): StubReply => {
        const { fiscalYear } = body as { fiscalYear: number };
        const generated = twelveMonths(fiscalYear, startMonth);
        periods.push(...generated);
        const first = generated[0];
        const last = generated[generated.length - 1];
        return {
          status: 201,
          body: {
            fiscalYear,
            startMonth,
            startDate: first?.startDate,
            endDate: last?.endDate,
            periods: generated,
          },
        };
      },
    },
    {
      method: 'POST',
      path: '/v1/fiscal-periods/:periodId/close',
      reply: ({ params }): StubReply => {
        const target = periods.find((period) => period.id === params['periodId']);
        if (target === undefined) return { status: 404 };
        target.status = 'closed';
        target.closedAt = '2026-02-15T10:00:00.000Z';
        return { status: 200, body: target };
      },
    },
  ];
}

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Only `Date` is faked. `setTimeout` stays real, because `user-event` and `waitFor` both
 * schedule on it and a frozen timer queue turns every interaction into a hang that reads
 * as an assertion failure somewhere else entirely.
 */
function freezeClock(iso: string): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
}

function rowContaining(text: string): HTMLElement {
  const row = screen.getByText(text).closest('tr');
  if (row === null) throw new Error(`No table row contains ${text}.`);
  return row;
}

describe('FiscalPeriodsSection', () => {
  it('tells a brand-new org it can record nothing until a year is generated', async () => {
    freezeClock('2026-02-15T09:00:00.000Z');
    installApiStub(routes(APRIL));
    renderWithQueryClient(<FiscalPeriodsSection />);

    expect(await screen.findByText(/cannot record anything yet/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing creates one on your behalf/i)).toBeInTheDocument();
  });

  it('defaults an April-start org to the fiscal year February 2026 actually falls in', async () => {
    freezeClock('2026-02-15T09:00:00.000Z');
    installApiStub(routes(APRIL));
    renderWithQueryClient(<FiscalPeriodsSection />);

    /**
     * February 2026 is inside the year that began in April **2025**, not 2026. The label
     * spells the span out because there is nothing else on the screen to infer it from.
     */
    const yearPicker = await screen.findByRole('combobox', { name: 'Fiscal year to generate' });
    await waitFor(() => {
      expect(yearPicker).toHaveTextContent('FY 2025 · Apr 2025 – Mar 2026');
    });
  });

  it('defaults a January-start org to the calendar year, and says so', async () => {
    freezeClock('2026-02-15T09:00:00.000Z');
    installApiStub(routes(JANUARY));
    renderWithQueryClient(<FiscalPeriodsSection />);

    const yearPicker = await screen.findByRole('combobox', { name: 'Fiscal year to generate' });
    await waitFor(() => {
      expect(yearPicker).toHaveTextContent('FY 2026 · Jan – Dec 2026');
    });
  });

  it('generates the twelve months of the April year, with one idempotency key', async () => {
    freezeClock('2026-02-15T09:00:00.000Z');
    const stub = installApiStub(routes(APRIL));
    const user = userEvent.setup();
    renderWithQueryClient(<FiscalPeriodsSection />);

    await screen.findByText(/cannot record anything yet/i);
    await user.click(screen.getByRole('button', { name: 'Generate 12 periods' }));

    await waitFor(() => {
      expect(screen.getByText('2025-04')).toBeInTheDocument();
    });

    // The first period is April 2025 and the last is March 2026 — the whole point of the
    // start month being the org's rather than the request's.
    expect(screen.getByText('2026-03')).toBeInTheDocument();
    expect(screen.queryByText('2026-04')).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'FY 2025 · Apr 2025 – Mar 2026' }),
    ).toBeInTheDocument();

    const generateCalls = stub.calls.filter((call) => call.path === '/v1/fiscal-years');
    expect(generateCalls).toHaveLength(1);
    expect(generateCalls[0]?.body).toEqual({ fiscalYear: 2025 });
    // Minted at the press and carried in the mutation's variables (spec §12): a write with
    // no key does not reach the network at all — the client throws first.
    expect(generateCalls[0]?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);

    // Once generated, the year is offered no more.
    expect(screen.queryByText(/cannot record anything yet/i)).not.toBeInTheDocument();
  });

  it('closes a period and shows it closed', async () => {
    freezeClock('2026-02-15T09:00:00.000Z');
    const stub = installApiStub(routes(APRIL, twelveMonths(2025, APRIL)));
    const user = userEvent.setup();
    renderWithQueryClient(<FiscalPeriodsSection />);

    await screen.findByText('2025-04');
    await user.click(within(rowContaining('2025-04')).getByRole('button', { name: 'Close' }));

    await waitFor(() => {
      expect(within(rowContaining('2025-04')).getByText('Closed')).toBeInTheDocument();
    });
    expect(stub.keysFor('POST', '/v1/fiscal-periods/:periodId/close')).toHaveLength(1);
  });
});
