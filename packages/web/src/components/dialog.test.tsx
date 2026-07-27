import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';

import { Button } from './button';
import { Dialog, DialogClose, DialogContent, DialogTrigger } from './dialog';

/**
 * Smoke coverage of the Radix wrapper (D-24). Radix's own suite proves the focus trap; what
 * is unproven here is that *this* wrapper still hands Radix what it needs — a `Title` for
 * the accessible name, a `Description` when one is given, and a `Content` that is allowed
 * to take focus.
 *
 * The focus assertions are the ones worth having. A dialog whose focus never enters it
 * leaves the keyboard on the page behind, and a dialog that does not return focus on close
 * drops the user at the top of the document — both invisible to anyone testing with a
 * mouse, and both are wrapper-level mistakes rather than Radix ones.
 */
function Harness(): ReactElement {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button>New account</Button>
      </DialogTrigger>
      <DialogContent
        title="New account"
        description="Accounts cannot be deleted once they carry a journal line."
        footer={
          <DialogClose asChild>
            <Button variant="primary">Save</Button>
          </DialogClose>
        }
      >
        <label>
          Code
          <input />
        </label>
      </DialogContent>
    </Dialog>
  );
}

describe('Dialog', () => {
  it('is closed until the trigger is pressed', () => {
    render(<Harness />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('takes its accessible name and description from the props, not from a screen', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: 'New account' }));

    const dialog = screen.getByRole('dialog', { name: 'New account' });
    expect(dialog).toHaveAccessibleDescription(
      'Accounts cannot be deleted once they carry a journal line.',
    );
  });

  it('moves focus into the dialog on open and back to the trigger on close', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'New account' });

    await user.click(trigger);
    expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('closes from a DialogClose in the footer and still returns focus', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'New account' });

    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('omits the description entirely when none is given', async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger asChild>
          <Button>Open</Button>
        </DialogTrigger>
        <DialogContent title="Confirm">Body</DialogContent>
      </Dialog>,
    );

    await user.click(screen.getByRole('button', { name: 'Open' }));

    // Not an empty description: Radix wires `aria-describedby` from the presence of a
    // `Description`, and an empty one announces a pause where there is nothing to say.
    expect(screen.getByRole('dialog')).not.toHaveAttribute('aria-describedby');
  });
});
