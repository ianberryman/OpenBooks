import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';

import { Button } from './button';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

/**
 * Smoke coverage of the shared floating surface. Its positioning is jsdom's blind spot —
 * every box is zero — so nothing here asserts geometry; OB-055's real browser does. What is
 * checkable is the part the combobox leans on: the panel appears and disappears on the
 * expected interactions, and dismissal returns the keyboard to where it came from.
 */
function Harness(): ReactElement {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button>Filters</Button>
      </PopoverTrigger>
      <PopoverContent>
        <Button>Clear all</Button>
      </PopoverContent>
    </Popover>
  );
}

describe('Popover', () => {
  it('toggles from the trigger and reports its state on it', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Filters' });

    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'Clear all' })).toBeNull();

    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Clear all' })).toBeInTheDocument();

    await user.click(trigger);
    expect(screen.queryByRole('button', { name: 'Clear all' })).toBeNull();
  });

  it('closes on Escape and puts the keyboard back on the trigger', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Filters' });

    await user.click(trigger);
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('button', { name: 'Clear all' })).toBeNull();
    expect(trigger).toHaveFocus();
  });
});
