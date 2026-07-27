import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Field, FieldLabel } from './field';
import type { SelectOption } from './select';
import { Select } from './select';

/**
 * Smoke coverage of the Radix Select wrapper. The keyboard model is Radix's and is tested
 * there; what belongs here is the two things the wrapper decides — that an unset selection
 * is `null` on the outside and absent on the inside (Radix warns on `''` and treats it as
 * "no value"), and that the trigger picks up the `Field` wiring even though it is not an
 * `<input>`.
 */
const TYPES: readonly SelectOption[] = [
  { value: 'asset', label: 'Asset' },
  { value: 'liability', label: 'Liability' },
  { value: 'equity', label: 'Equity' },
  { value: 'revenue', label: 'Revenue', disabled: true },
];

interface HarnessProps {
  readonly initialValue?: string | null;
  readonly onCommit?: (value: string) => void;
}

function Harness({ initialValue = null, onCommit }: HarnessProps): ReactElement {
  const [value, setValue] = useState<string | null>(initialValue);
  return (
    <Field hint="An account's type fixes which reports it appears on.">
      <FieldLabel>Account type</FieldLabel>
      <Select
        options={TYPES}
        value={value}
        onValueChange={(next) => {
          setValue(next);
          onCommit?.(next);
        }}
      />
    </Field>
  );
}

function trigger(): HTMLElement {
  return screen.getByRole('combobox', { name: 'Account type' });
}

describe('Select', () => {
  it('shows the placeholder for a null value and the label for a set one', () => {
    const { unmount } = render(<Harness />);
    expect(trigger()).toHaveTextContent('Select…');
    unmount();

    render(<Harness initialValue="equity" />);
    expect(trigger()).toHaveTextContent('Equity');
  });

  it('takes the Field wiring even though the trigger is not an input', () => {
    render(<Harness />);
    expect(trigger().id).not.toBe('');
    expect(trigger()).toHaveAccessibleDescription(
      "An account's type fixes which reports it appears on.",
    );
  });

  it('commits the chosen option', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn<(value: string) => void>();
    render(<Harness onCommit={onCommit} />);

    await user.click(trigger());
    await user.click(screen.getByRole('option', { name: 'Liability' }));

    expect(onCommit).toHaveBeenCalledExactlyOnceWith('liability');
    expect(trigger()).toHaveTextContent('Liability');
  });

  it('marks a disabled option disabled rather than merely styling it', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(trigger());

    expect(screen.getByRole('option', { name: 'Revenue' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('is a control that no Field needs to exist for', () => {
    render(
      <Select aria-label="Period status" options={TYPES} value={null} onValueChange={() => {}} />,
    );

    /**
     * `useFieldControl` is tolerant of there being no `Field` above it — a report toolbar's
     * filter is a real select carrying its own label. Requiring one would mean inventing
     * an empty `Field` around every such control.
     */
    const standalone = screen.getByRole('combobox', { name: 'Period status' });
    expect(standalone).not.toHaveAttribute('id');
    expect(standalone).not.toHaveAttribute('aria-describedby');
  });
});
