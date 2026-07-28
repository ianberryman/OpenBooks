import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { CashBasisNudge } from './classification-nudge';
import { account } from './fixtures';

function noop(): void {}

describe('CashBasisNudge', () => {
  it('renders nothing when every loaded account is classified', () => {
    const { container } = render(
      <CashBasisNudge accounts={[account({ cashBasisRole: 'cash' })]} onClassify={noop} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for an unclassified account that is inactive', () => {
    // An inactive account cannot be posted to again, so it will never appear in a future
    // report either way — nudging about it would be busywork with nothing it could change.
    const { container } = render(
      <CashBasisNudge
        accounts={[account({ cashBasisRole: null, isActive: false })]}
        onClassify={noop}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('names an unclassified account and opens its editor on request', async () => {
    const user = userEvent.setup();
    const onClassify = vi.fn();
    const unclassified = account({ id: 'a', code: '2100', name: 'Deposits held' });

    render(<CashBasisNudge accounts={[unclassified]} onClassify={onClassify} />);

    expect(screen.getByText(/1 account is not yet classified/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '2100 — Deposits held' }));
    expect(onClassify).toHaveBeenCalledWith(unclassified);
  });

  it('can be dismissed', async () => {
    const user = userEvent.setup();
    const unclassified = account({ cashBasisRole: null });

    const { container } = render(<CashBasisNudge accounts={[unclassified]} onClassify={noop} />);

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(container).toBeEmptyDOMElement();
  });

  it('names accounts up to a limit and counts the rest', () => {
    const accounts = Array.from({ length: 8 }, (_, index) =>
      account({
        id: `acc-${String(index)}`,
        code: String(1000 + index),
        name: `Account ${String(index)}`,
      }),
    );

    render(<CashBasisNudge accounts={accounts} onClassify={noop} />);

    expect(screen.getByText(/8 accounts are not yet classified/i)).toBeInTheDocument();
    expect(screen.getByText(/and 2 more/i)).toBeInTheDocument();
  });
});
