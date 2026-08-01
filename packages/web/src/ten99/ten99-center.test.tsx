import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { Ten99CenterScreen } from './ten99-center';

/**
 * The 1099 Center's own routing and tab switch (OB-228 Wave-1 Stream D).
 *
 * The three tab/route bodies (`Ten99Worksheet`, `Ten99RunsList`, `Ten99RunDetail`) are
 * mocked out — each already has its own suite — so this file asserts only what belongs to
 * the container: the tax-year default (the prior calendar year, since a 1099 is almost
 * always filed for a year already closed), the tab switch, and that `/ten99/runs/:runId`
 * renders the detail with the id off the URL rather than from local state.
 */

const mocks = vi.hoisted(() => ({
  Ten99Worksheet: vi.fn(),
  Ten99RunsList: vi.fn(),
  Ten99RunDetail: vi.fn(),
}));

vi.mock('./worksheet', () => ({
  Ten99Worksheet: (props: { readonly taxYear: number }) => {
    mocks.Ten99Worksheet(props);
    return <div data-testid="worksheet">Worksheet for {props.taxYear}</div>;
  },
}));

vi.mock('./runs-list', () => ({
  Ten99RunsList: () => {
    mocks.Ten99RunsList();
    return <div data-testid="runs-list">Runs list</div>;
  },
}));

vi.mock('./run-detail', () => ({
  Ten99RunDetail: (props: { readonly runId: string; readonly onBack: () => void }) => {
    mocks.Ten99RunDetail(props);
    return <div data-testid="run-detail">Run {props.runId}</div>;
  },
}));

function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/ten99/*" element={<Ten99CenterScreen />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Ten99CenterScreen', () => {
  it('defaults the worksheet to the prior calendar year', () => {
    renderAt('/ten99');

    const priorYear = new Date().getFullYear() - 1;
    expect(screen.getByTestId('worksheet')).toHaveTextContent(`Worksheet for ${priorYear}`);
  });

  it('switches to the runs list when the Runs tab is clicked', async () => {
    const user = userEvent.setup();
    renderAt('/ten99');

    expect(screen.getByTestId('worksheet')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Runs' }));

    expect(screen.queryByTestId('worksheet')).toBeNull();
    expect(screen.getByTestId('runs-list')).toBeInTheDocument();
  });

  it('renders the run detail with the id taken from the URL', () => {
    renderAt('/ten99/runs/run-42');

    expect(screen.getByTestId('run-detail')).toHaveTextContent('Run run-42');
    expect(mocks.Ten99RunDetail).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-42' }));
  });
});
