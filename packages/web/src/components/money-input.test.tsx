import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { MoneyFormatError, toMinorUnits } from '../money/format';
import { Field, FieldLabel } from './field';
import { MoneyInput } from './money-input';

/**
 * `MoneyInput` is the only place in the browser where a typed amount becomes a wire
 * amount, and the wire amount is a **cents-only string** (D-13). What these tests are
 * really asserting is a negative: that nothing here is `Number(text) * 100` or
 * `cents / 100`. Both are inexact in ways that produce a journal line one cent short and
 * still balanced, because the other side was computed the same way.
 *
 * `src/money/format.test.ts` covers the conversion itself. This file covers the part a
 * unit test of a pure function cannot reach: what the component holds, emits, and shows
 * while someone is typing into it.
 */
interface HarnessProps {
  readonly initialValue?: string | null;
  readonly onCommit?: (value: string | null) => void;
}

function Harness({ initialValue = null, onCommit }: HarnessProps): ReactElement {
  const [value, setValue] = useState<string | null>(initialValue);
  return (
    <MoneyInput
      aria-label="Debit"
      value={value}
      onValueChange={(next) => {
        setValue(next);
        onCommit?.(next);
      }}
    />
  );
}

function amount(): HTMLElement {
  return screen.getByRole('textbox', { name: 'Debit' });
}

describe('MoneyInput — the wire value', () => {
  it('renders a cents string as a decimal and never as a number', () => {
    render(<Harness initialValue="150000" />);
    expect(amount()).toHaveValue('1500.00');
  });

  /**
   * The D-13 assertion, at the component rather than the function. `Number('9007199254740993')`
   * is 9007199254740992 and `/100` on it is inexact again; a component that reached for
   * either would render this one wrong and every small amount right, so only a large value
   * catches it.
   */
  it('is exact above 2^53 in both directions', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn<(value: string | null) => void>();
    render(<Harness initialValue="9007199254740993" onCommit={onCommit} />);

    expect(amount()).toHaveValue('90071992547409.93');

    await user.clear(amount());
    await user.type(amount(), '92233720368547758.07');
    expect(onCommit).toHaveBeenLastCalledWith('9223372036854775807');
  });

  it('emits minor units on every keystroke that parses', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn<(value: string | null) => void>();
    render(<Harness onCommit={onCommit} />);

    await user.type(amount(), '19.99');

    // One emission per keystroke, each one a canonical cents string: `1`, `19`, `19.`,
    // `19.9`, `19.99`. The intermediate values matter as much as the last — a caller that
    // reads the amount mid-typing must never see a decimal or a partly-scaled number.
    expect(onCommit.mock.calls).toEqual([['100'], ['1900'], ['1900'], ['1990'], ['1999']]);
  });

  it('emits null for an empty field rather than a zero', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn<(value: string | null) => void>();
    render(<Harness initialValue="1999" onCommit={onCommit} />);

    await user.clear(amount());

    // `null`, not `'0'`. An empty amount line is not a zero-amount one, and a journal line
    // posted for zero is a line the user never asked for.
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(null);
    expect(amount()).toHaveValue('');
  });
});

describe('MoneyInput — while it is being typed into', () => {
  /**
   * Normalizing on each keystroke would rewrite `"5"` to `"5.00"` and leave the caret
   * behind the decimals, so the next digit lands two places from where the user aimed it.
   */
  it('leaves the draft text alone until blur', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.type(amount(), '5');
    expect(amount()).toHaveValue('5');

    await user.tab();
    expect(amount()).toHaveValue('5.00');
  });

  it('accepts the partial forms typing passes through', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn<(value: string | null) => void>();
    render(<Harness onCommit={onCommit} />);

    await user.type(amount(), '1.');
    expect(amount()).toHaveValue('1.');
    expect(amount()).not.toHaveAttribute('aria-invalid');
    expect(onCommit).toHaveBeenLastCalledWith('100');
  });

  it('is a text field with a decimal keypad, never a number field', () => {
    render(<Harness />);
    /**
     * `type="number"` discards what it cannot parse — reading `.value` after a paste of
     * `"1,500.00"` gives `""`, with no event to notice it by — and it changes the amount
     * on a scroll wheel. On a value that becomes a posted journal line, neither is
     * survivable, so the type is asserted rather than left to a code review.
     */
    expect(amount()).toHaveAttribute('type', 'text');
    expect(amount()).toHaveAttribute('inputmode', 'decimal');
  });
});

describe('MoneyInput — excess precision', () => {
  /** The asymmetry D-13 names: the ledger has one rounding point, and it is not a field. */
  it('throws in the conversion rather than rounding', () => {
    expect(() => toMinorUnits('1.005')).toThrow(MoneyFormatError);
    expect(() => toMinorUnits('0.001')).toThrow(MoneyFormatError);
  });

  it('refuses a third decimal, reports it, and emits no amount', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn<(value: string | null) => void>();
    render(<Harness onCommit={onCommit} />);

    await user.type(amount(), '1.005');

    expect(amount()).toHaveAttribute('aria-invalid', 'true');
    // The third decimal makes the amount unrepresentable, so the caller is told there is
    // no amount. `'101'` would be a silent round; `'1005'` would be a scale confusion.
    // Neither may ever have been emitted, not merely be absent from the last call.
    expect(onCommit).toHaveBeenLastCalledWith(null);
    expect(onCommit.mock.calls).not.toContainEqual(['101']);
    expect(onCommit.mock.calls).not.toContainEqual(['1005']);
  });

  /**
   * The text survives the blur unchanged. Rewriting it to `1.01` would be a rounding
   * decision made silently on the user's behalf — and worse, an invisible one: the entry
   * would balance, post, and differ from what was typed by a cent nobody can trace.
   */
  it('keeps the rejected text on blur instead of correcting it', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.type(amount(), '1.005');
    await user.tab();

    expect(amount()).toHaveValue('1.005');
    expect(amount()).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('MoneyInput — inside a Field', () => {
  it('takes the field wiring without the screen writing an id', () => {
    render(
      <Field error="Debits and credits must balance." hint="Cents, to two places.">
        <FieldLabel>Debit</FieldLabel>
        <MoneyInput value="150000" onValueChange={() => {}} />
      </Field>,
    );

    const input = screen.getByRole('textbox', { name: 'Debit' });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription(
      'Debits and credits must balance. Cents, to two places.',
    );
  });

  /**
   * The field is valid and the text is not. Losing the control's own invalidity to the
   * field's would leave `1.005` looking accepted right up to the point the form is posted.
   */
  it('reports its own invalid text even when the Field is not in error', async () => {
    const user = userEvent.setup();
    render(
      <Field>
        <FieldLabel>Debit</FieldLabel>
        <Harness />
      </Field>,
    );

    const input = screen.getByRole('textbox', { name: 'Debit' });
    expect(input).not.toHaveAttribute('aria-invalid');

    await user.type(input, '0.001');
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });
});
