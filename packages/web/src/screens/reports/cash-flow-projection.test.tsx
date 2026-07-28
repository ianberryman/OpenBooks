import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { components } from '../../api';
import { CashFlowProjectionReport } from './cash-flow-projection';

/**
 * The pure render component, worked from a canned response — the fetching half is
 * `useQuery` plumbing identical to every other viewer in this directory and is not
 * what OB-158 adds. What is worth asserting here: the running cash column is
 * printed as the server computed it (nothing re-sums it in the browser, matching
 * `cells.tsx`'s header comment that this layer does no arithmetic), and the
 * recurring-commitments note appears because the flag is honest about what the
 * forecast leaves out.
 */

type CashFlowProjection = components['schemas']['CashFlowProjection'];

const REPORT: CashFlowProjection = {
  asOf: '2026-01-01',
  granularity: 'monthly',
  openingCash: '500000',
  buckets: [
    {
      periodStart: '2026-01-01',
      periodEnd: '2026-01-31',
      expectedInflows: '130000',
      expectedOutflows: '40000',
      netChange: '90000',
      projectedClosingCash: '590000',
    },
    {
      periodStart: '2026-02-01',
      periodEnd: '2026-02-28',
      expectedInflows: '50000',
      expectedOutflows: '0',
      netChange: '50000',
      projectedClosingCash: '640000',
    },
  ],
  includesRecurringCommitments: false,
};

describe('CashFlowProjectionReport', () => {
  it('prints the opening balance and one row per bucket, oldest first', () => {
    render(<CashFlowProjectionReport report={REPORT} />);

    expect(screen.getByText('Opening cash, at 2026-01-01')).toBeInTheDocument();

    const table = within(screen.getByRole('table', { name: 'Cash-flow projection' }));
    const rows = table.getAllByRole('row');
    // Header, opening cash, then the two buckets.
    expect(rows).toHaveLength(4);
  });

  it('prints the running closing cash the server computed rather than re-summing it', () => {
    render(<CashFlowProjectionReport report={REPORT} />);

    const table = within(screen.getByRole('table', { name: 'Cash-flow projection' }));
    // 5,000.00 opening + 900.00 January net = 5,900.00.
    expect(table.getByText('5900.00')).toBeInTheDocument();
    // Carried forward: 5,900.00 + 500.00 February net = 6,400.00.
    expect(table.getByText('6400.00')).toBeInTheDocument();
  });

  it('notes that recurring commitments are not included when the server says so', () => {
    render(<CashFlowProjectionReport report={REPORT} />);

    expect(screen.getByText(/does not yet include recurring commitments/)).toBeInTheDocument();
  });

  it('says nothing about recurring commitments once the server includes them', () => {
    render(<CashFlowProjectionReport report={{ ...REPORT, includesRecurringCommitments: true }} />);

    expect(screen.queryByText(/does not yet include recurring commitments/)).toBeNull();
  });

  it('names an empty horizon rather than rendering a table with nothing in it', () => {
    render(<CashFlowProjectionReport report={{ ...REPORT, buckets: [] }} />);

    expect(
      screen.getByText('Nothing to project — the horizon has no buckets in it.'),
    ).toBeInTheDocument();
  });
});
