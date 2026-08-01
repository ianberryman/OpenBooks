import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import type { Ten99Run } from '@openbooks/shared-types';

import { Ten99RunsList } from './runs-list';

/**
 * The Runs tab (OB-228 Wave-1 Stream D). `./queries` mocked at the hook boundary, the
 * `customer-statements.test.tsx` seam. What is worth asserting: the status pill reads the
 * server's `status` rather than deriving one, the form count pluralises, and clicking a
 * run's year navigates to its detail route (`/ten99/runs/:runId` — this stream's expected
 * mount, per `ten99-center.tsx`'s header comment).
 */

const mocks = vi.hoisted(() => ({ useTen99Runs: vi.fn() }));

vi.mock('./queries', () => ({ useTen99Runs: mocks.useTen99Runs }));

function run(partial: Partial<Ten99Run>): Ten99Run {
  return {
    id: 'run-1',
    taxYear: 2025,
    status: 'generated',
    efileProvider: null,
    efileRef: null,
    thresholdMinor: '60000',
    generatedByUserId: 'user-1',
    createdAt: '2026-01-15T00:00:00.000Z',
    forms: [],
    ...partial,
  };
}

function renderList(): void {
  render(
    <MemoryRouter initialEntries={['/ten99']}>
      <Routes>
        <Route path="/ten99" element={<Ten99RunsList />} />
        <Route path="/ten99/runs/:runId" element={<div>Run detail page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Ten99RunsList', () => {
  it('shows the empty state when no run has been generated', () => {
    mocks.useTen99Runs.mockReturnValue({
      isPending: false,
      data: { runs: [] },
      error: null,
      refetch: () => {},
    });

    renderList();

    expect(screen.getByText(/No 1099 filing run has been generated yet/)).toBeInTheDocument();
  });

  it("renders the run's status pill, tax year and pluralised form count", () => {
    mocks.useTen99Runs.mockReturnValue({
      isPending: false,
      data: { runs: [run({ status: 'accepted', forms: [{ id: 'f1' }, { id: 'f2' }] as never })] },
      error: null,
      refetch: () => {},
    });

    renderList();

    expect(screen.getByText('2025')).toBeInTheDocument();
    expect(screen.getByText('Accepted')).toBeInTheDocument();
    expect(screen.getByText('2 forms')).toBeInTheDocument();
  });

  it('navigates to the run detail route when the year is clicked', async () => {
    const user = userEvent.setup();
    mocks.useTen99Runs.mockReturnValue({
      isPending: false,
      data: { runs: [run({ id: 'run-42' })] },
      error: null,
      refetch: () => {},
    });

    renderList();

    await user.click(screen.getByRole('button', { name: '2025' }));
    expect(screen.getByText('Run detail page')).toBeInTheDocument();
  });
});
