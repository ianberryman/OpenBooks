import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { ComboboxOption } from './combobox';
import { Combobox } from './combobox';
import { Field, FieldLabel } from './field';

/**
 * The combobox is the one component in `src/components` that Radix does not supply, so it
 * is the one whose keyboard contract is ours to get wrong (D-24, and the OB-046 finding
 * that put OB-058 on the board). OB-051's account picker is this component; a wrong
 * `aria-activedescendant` or an off-by-one in the arrow keys surfaces there as a journal
 * line posted against an account the user did not choose, which is expensive to attribute
 * back to a component.
 *
 * The contract under test is WAI-ARIA APG, *editable* combobox with list autocomplete.
 * `user-event` rather than `fireEvent` throughout: filtering is driven by real `input`
 * events with the focus and key sequence a browser produces, and `fireEvent.change` sets
 * the value in one step that no keyboard can.
 */
const ACCOUNTS: readonly ComboboxOption[] = [
  { value: 'a-cash', label: 'Cash at bank', detail: '1-1000' },
  { value: 'a-ar', label: 'Accounts receivable', detail: '1-1100' },
  { value: 'a-ap', label: 'Accounts payable', detail: '2-2000' },
  { value: 'a-sales', label: 'Sales revenue', detail: '4-4000' },
  { value: 'a-cogs', label: 'Cost of goods sold', detail: '5-5000' },
];

interface HarnessProps {
  readonly options?: readonly ComboboxOption[];
  readonly initialValue?: string | null;
  readonly onCommit?: (value: string | null) => void;
}

function Harness({
  options = ACCOUNTS,
  initialValue = null,
  onCommit,
}: HarnessProps): ReactElement {
  const [value, setValue] = useState<string | null>(initialValue);
  return (
    <Combobox
      aria-label="Account"
      options={options}
      value={value}
      onValueChange={(next) => {
        setValue(next);
        onCommit?.(next);
      }}
    />
  );
}

function combobox(): HTMLElement {
  return screen.getByRole('combobox');
}

/**
 * The `aria-activedescendant` invariant, resolved the way a screen reader resolves it:
 * look the id up in the document. Asserting on the index the component happens to hold
 * would pass against a component that points at an option it has already filtered away,
 * which is precisely the failure the attribute exists to have.
 */
function activeDescendant(): HTMLElement {
  const id = combobox().getAttribute('aria-activedescendant');
  if (id === null) throw new Error('The combobox has no aria-activedescendant.');
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`aria-activedescendant is "${id}", which is not in the document.`);
  }
  return element;
}

function optionLabels(): string[] {
  return screen.getAllByRole('option').map((option) => option.textContent ?? '');
}

/**
 * Records whether each keydown was cancelled, listening on `document` rather than on the
 * input. React 19 delegates to the root container, so a listener on the input itself runs
 * *before* the component's handler and reports `defaultPrevented: false` for every key —
 * a green assertion about a contract that was never checked.
 */
function recordPreventedKeys(keys: readonly string[]): string[] {
  const prevented: string[] = [];
  const listener = (event: KeyboardEvent): void => {
    if (keys.includes(event.key) && event.defaultPrevented) prevented.push(event.key);
  };
  document.addEventListener('keydown', listener);
  onTestFinished(() => {
    document.removeEventListener('keydown', listener);
  });
  return prevented;
}

describe('Combobox — closed state', () => {
  it('is a collapsed combobox with list autocomplete and no popup', () => {
    render(<Harness />);

    expect(combobox()).toHaveAttribute('aria-expanded', 'false');
    expect(combobox()).toHaveAttribute('aria-autocomplete', 'list');
    // An `aria-controls` pointing at a listbox that is not rendered is a dangling
    // reference; the attribute is present only while the popup is.
    expect(combobox()).not.toHaveAttribute('aria-controls');
    expect(combobox()).not.toHaveAttribute('aria-activedescendant');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('shows the selected label rather than the value', () => {
    render(<Harness initialValue="a-ap" />);
    expect(combobox()).toHaveValue('Accounts payable');
  });
});

describe('Combobox — open and close', () => {
  it('opens on click and points aria-controls at the rendered listbox', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(combobox());

    const listbox = screen.getByRole('listbox');
    expect(combobox()).toHaveAttribute('aria-expanded', 'true');
    expect(combobox()).toHaveAttribute('aria-controls', listbox.id);
    expect(optionLabels()).toHaveLength(ACCOUNTS.length);
  });

  it('opens on ArrowDown and on ArrowUp without moving DOM focus off the input', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.tab();
    expect(combobox()).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    /**
     * The whole reason this is the `aria-activedescendant` pattern: moving real focus into
     * the list takes it out of the text field and the next keystroke goes nowhere. If this
     * assertion ever fails the component has stopped being an editable combobox.
     */
    expect(combobox()).toHaveFocus();
  });

  it('closes on Escape and keeps the value it already had', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn<(value: string | null) => void>();
    render(<Harness initialValue="a-ap" onCommit={onCommit} />);

    await user.click(combobox());
    // The box is an editable text field holding the committed label, so typing appends to
    // it. Clearing first is what a user does; it is not a workaround for the component.
    await user.clear(combobox());
    await user.keyboard('rev');
    expect(optionLabels()).toEqual(['Sales revenue4-4000']);

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(combobox()).toHaveAttribute('aria-expanded', 'false');
    // The typed query is discarded, not committed: the box goes back to showing the
    // account the user already had rather than the text they were mid-way through.
    expect(combobox()).toHaveValue('Accounts payable');
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('commits nothing on Tab, however far the highlight has moved', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn<(value: string | null) => void>();
    render(<Harness onCommit={onCommit} />);

    await user.click(combobox());
    await user.keyboard('{ArrowDown}{ArrowDown}');
    await user.tab();

    // A highlight is not a choice. Committing one on the way out of the field posts an
    // entry against an account the user never looked at.
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('Combobox — arrow keys', () => {
  it('moves down and up through the visible options', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(combobox());
    expect(activeDescendant()).toHaveTextContent('Cash at bank');

    await user.keyboard('{ArrowDown}');
    expect(activeDescendant()).toHaveTextContent('Accounts receivable');

    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(activeDescendant()).toHaveTextContent('Sales revenue');

    await user.keyboard('{ArrowUp}');
    expect(activeDescendant()).toHaveTextContent('Accounts payable');
  });

  /**
   * Wrapping, not clamping — asserted in both directions because the two halves are
   * separate arithmetic and a component can plausibly wrap one way and clamp the other.
   */
  it('wraps from the last option to the first and from the first to the last', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(combobox());
    await user.keyboard('{ArrowUp}');
    expect(activeDescendant()).toHaveTextContent('Cost of goods sold');

    await user.keyboard('{ArrowDown}');
    expect(activeDescendant()).toHaveTextContent('Cash at bank');

    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}');
    expect(activeDescendant()).toHaveTextContent('Cash at bank');
  });

  /**
   * APG defines Home and End on an *editable* combobox as text-cursor movement, not option
   * movement, and this component leaves them to the browser. The assertion is that they
   * are not intercepted: an implementation that quietly moved the highlight on Home would
   * strand a user who was trying to get back to the start of what they had typed.
   */
  it('leaves Home and End to the text cursor', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const prevented = recordPreventedKeys(['ArrowDown', 'Home', 'End']);

    await user.click(combobox());
    await user.keyboard('{ArrowDown}{Home}');
    expect(activeDescendant()).toHaveTextContent('Accounts receivable');

    await user.keyboard('{End}');
    expect(activeDescendant()).toHaveTextContent('Accounts receivable');
    expect(prevented).toEqual(['ArrowDown']);
  });

  /**
   * The highlight is held as an index, and `options` is a prop — OB-051 fetches the chart
   * of accounts, so the list can shrink beneath an index that was in range when it was
   * set. What must not happen is the two readers of that index diverging: the row that
   * looks highlighted and the row `aria-activedescendant` names have to be one row, or the
   * component is correct for sighted users and wrong for everyone else.
   */
  it('keeps the highlight and the announced option on one row when the list shrinks', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Harness />);

    await user.click(combobox());
    await user.keyboard('{ArrowUp}');
    expect(activeDescendant()).toHaveTextContent('Cost of goods sold');

    rerender(<Harness options={ACCOUNTS.slice(0, 2)} />);

    const highlighted = screen
      .getAllByRole('option')
      .filter((option) => option.classList.contains('bg-surface-hover'));
    expect(highlighted).toHaveLength(1);
    expect(activeDescendant()).toBe(highlighted[0]);
  });

  it('does nothing on arrow keys when nothing matches', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(combobox());
    await user.keyboard('zzz');
    expect(screen.getByText('No matches.')).toBeInTheDocument();
    expect(screen.queryAllByRole('option')).toHaveLength(0);

    await user.keyboard('{ArrowDown}{ArrowUp}');
    expect(combobox()).not.toHaveAttribute('aria-activedescendant');
  });
});

describe('Combobox — typeahead', () => {
  it('filters on a substring of the label, not a prefix', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(combobox());
    await user.keyboard('payable');

    expect(optionLabels()).toEqual(['Accounts payable2-2000']);
  });

  it('filters on the detail as well, so an account code finds its account', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(combobox());
    await user.keyboard('4-40');

    expect(optionLabels()).toEqual(['Sales revenue4-4000']);
  });

  it('ignores diacritics in both the query and the option', async () => {
    const user = userEvent.setup();
    render(<Harness options={[{ value: 'a-fx', label: 'Réévaluation de change' }]} />);

    await user.click(combobox());
    await user.keyboard('reeval');

    expect(optionLabels()).toEqual(['Réévaluation de change']);
  });

  /**
   * The invariant `aria-activedescendant` exists to hold, checked after every keystroke of
   * a sequence that narrows the list from five options to one and then widens it again.
   * A component that filters without resetting the highlight points at an id that is no
   * longer rendered, and a screen reader announces nothing at all — silently, and only for
   * the users who cannot see the highlight that is still correct on screen.
   */
  it('never names an option that is not rendered', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(combobox());
    for (const key of ['{ArrowDown}', '{ArrowDown}', '{ArrowDown}', '{ArrowDown}']) {
      await user.keyboard(key);
    }

    for (const character of 'cash') {
      await user.keyboard(character);
      expect(activeDescendant()).toBeInTheDocument();
      expect(activeDescendant()).toHaveAttribute('role', 'option');
    }

    for (let index = 0; index < 4; index += 1) {
      await user.keyboard('{Backspace}');
      expect(activeDescendant()).toHaveAttribute('role', 'option');
    }
  });
});

describe('Combobox — committing', () => {
  it('commits the highlighted option on Enter and closes', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn<(value: string | null) => void>();
    render(<Harness onCommit={onCommit} />);

    await user.click(combobox());
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');

    expect(onCommit).toHaveBeenCalledExactlyOnceWith('a-ap');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(combobox()).toHaveValue('Accounts payable');
  });

  /**
   * A mouse and a keyboard must agree, and it is worth an explicit test because they run
   * through different code: pointer selection goes through `onPointerDown` (`onClick` is
   * too late — the mousedown blurs the input and dismisses the popup first), keyboard
   * selection through the `Enter` branch. Two paths to one commit is two chances to
   * commit different things.
   */
  it('produces the same committed value by mouse as by keyboard', async () => {
    const user = userEvent.setup();

    const byKeyboard = vi.fn<(value: string | null) => void>();
    const { unmount } = render(<Harness onCommit={byKeyboard} />);
    await user.click(combobox());
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{Enter}');
    const keyboardValue = combobox().getAttribute('value') ?? combobox().textContent;
    unmount();

    const byMouse = vi.fn<(value: string | null) => void>();
    render(<Harness onCommit={byMouse} />);
    await user.click(combobox());
    await user.click(screen.getByText('Sales revenue'));

    expect(byMouse.mock.calls).toEqual(byKeyboard.mock.calls);
    expect(keyboardValue).toBe(combobox().getAttribute('value'));
    expect(combobox()).toHaveValue('Sales revenue');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('refuses to commit a disabled option by either route', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn<(value: string | null) => void>();
    render(
      <Harness
        options={[
          { value: 'a-archived', label: 'Suspense (archived)', disabled: true },
          { value: 'a-cash', label: 'Cash at bank' },
        ]}
        onCommit={onCommit}
      />,
    );

    await user.click(combobox());
    await user.keyboard('{Enter}');
    expect(onCommit).not.toHaveBeenCalled();

    await user.click(screen.getByText('Suspense (archived)'));
    expect(onCommit).not.toHaveBeenCalled();
  });

  /**
   * Enter is swallowed only while the popup is open. A journal entry is saved from the
   * keyboard, and a combobox that eats every Enter makes the form unsubmittable from the
   * field the user is most likely to be standing in.
   */
  it('leaves Enter to the surrounding form when the popup is closed', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const prevented = recordPreventedKeys(['Enter']);

    await user.tab();
    await user.keyboard('{Enter}');
    expect(prevented).toEqual([]);

    await user.keyboard('{ArrowDown}{Enter}');
    expect(prevented).toEqual(['Enter']);
  });

  it('reopens on the option that is already selected', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn<(value: string | null) => void>();
    render(<Harness initialValue="a-sales" onCommit={onCommit} />);

    await user.click(combobox());

    /**
     * Reopening on the first option instead would make Enter — the most reflexive key in
     * the sequence "open the picker, look, change my mind" — silently replace a chosen
     * account with whatever sorts first in the chart.
     */
    expect(activeDescendant()).toHaveTextContent('Sales revenue');

    await user.keyboard('{Enter}');
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('a-sales');
  });
});

describe('Combobox — inside a Field', () => {
  it('takes its id and description wiring from the Field, not from the screen', () => {
    render(
      <Field error="Choose an account." hint="Start typing a name or a code.">
        <FieldLabel>Debit account</FieldLabel>
        <Combobox value={null} onValueChange={() => {}} options={ACCOUNTS} />
      </Field>,
    );

    const input = screen.getByRole('combobox', { name: 'Debit account' });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Choose an account. Start typing a name or a code.');
  });
});
