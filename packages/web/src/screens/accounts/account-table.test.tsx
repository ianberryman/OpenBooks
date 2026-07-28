import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { AccountTable } from './account-table';
import { account } from './fixtures';
import { buildAccountTree } from './tree';

/**
 * The hierarchy carries meaning, and indentation is the only thing that shows it. So the
 * assertions here are about the parent stated in *text*: a chart nested by padding alone
 * reads as a flat list to anyone who cannot see it, and "what does this roll up into" is
 * the question the tree exists to answer.
 */
const ASSETS = account({ id: 'a', code: '1000', name: 'Assets' });
const CASH = account({ id: 'b', code: '1100', name: 'Cash', parentAccountId: 'a' });

function noop(): void {}

function row(name: string): HTMLElement {
  // The column-header row can match a search term a header cell contains — 'Cash'
  // is in the 'Cash basis' column heading — so a data-row lookup must skip the row
  // that carries `columnheader` cells rather than assume the account name is unique
  // across every row including the header.
  const matches = screen
    .getAllByRole('row', { name: new RegExp(name) })
    .filter((candidate) => within(candidate).queryAllByRole('columnheader').length === 0);
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one data row matching ${name}, found ${String(matches.length)}.`,
    );
  }
  return matches[0] as HTMLElement;
}

describe('AccountTable', () => {
  it('states each child’s parent in text as well as in the indentation', () => {
    render(
      <AccountTable
        rows={buildAccountTree([ASSETS, CASH])}
        busyAccountId={null}
        onEdit={noop}
        onRemove={noop}
        onSetActive={noop}
      />,
    );

    expect(within(row('Cash')).getByText('Rolls up into 1000')).toBeInTheDocument();
    expect(within(row('Assets')).queryByText(/Rolls up into/)).toBeNull();
  });

  it('says so when a parent is on a page that has not been fetched', () => {
    render(
      <AccountTable
        rows={buildAccountTree([CASH])}
        busyAccountId={null}
        onEdit={noop}
        onRemove={noop}
        onSetActive={noop}
      />,
    );

    expect(screen.getByText(/not on the pages loaded yet/i)).toBeInTheDocument();
  });

  it('keeps deactivation and deletion as separate row controls', async () => {
    const user = userEvent.setup();
    const onSetActive = vi.fn();
    const onRemove = vi.fn();

    render(
      <AccountTable
        rows={buildAccountTree([ASSETS])}
        busyAccountId={null}
        onEdit={noop}
        onRemove={onRemove}
        onSetActive={onSetActive}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Deactivate' }));
    // Deactivation is reversible and idempotent, so it commits from the row; deletion is
    // not, so its control only opens the dialog that explains the difference.
    expect(onSetActive).toHaveBeenCalledWith(ASSETS, false);
    expect(onRemove).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Delete…' }));
    expect(onRemove).toHaveBeenCalledWith(ASSETS);
  });

  it('offers reactivation, not deactivation, for an inactive account', async () => {
    const user = userEvent.setup();
    const onSetActive = vi.fn();
    const inactive = account({ id: 'z', code: '9000', name: 'Suspense', isActive: false });

    render(
      <AccountTable
        rows={buildAccountTree([inactive])}
        busyAccountId={null}
        onEdit={noop}
        onRemove={noop}
        onSetActive={onSetActive}
      />,
    );

    expect(within(row('Suspense')).getByText('Inactive')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deactivate' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Reactivate' }));
    expect(onSetActive).toHaveBeenCalledWith(inactive, true);
  });

  it('shows each account’s cash-basis classification, unclassified included', () => {
    const cash = account({ id: 'c', code: '1000', name: 'Bank', cashBasisRole: 'cash' });
    const unclassified = account({ id: 'u', code: '2000', name: 'Prepaid rent' });

    render(
      <AccountTable
        rows={buildAccountTree([cash, unclassified])}
        busyAccountId={null}
        onEdit={noop}
        onRemove={noop}
        onSetActive={noop}
      />,
    );

    expect(within(row('Bank')).getByText('Cash or cash equivalent')).toBeInTheDocument();
    expect(within(row('Prepaid rent')).getByText('Unclassified')).toBeInTheDocument();
  });
});
