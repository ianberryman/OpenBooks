import type { ReactElement, ReactNode } from 'react';

import { CONTROL_CLASSES, Field, FieldLabel, useFieldControl } from '../../components';
import { cx } from '../../lib/cx';

/**
 * The two controls `src/components` does not have, wired through `Field` rather than
 * around it.
 *
 * D-24 says a component arrives with the screen that needs it and not before, and neither
 * of these is this screen's to add to the shared surface — `contacts/contact-form.tsx`
 * reached the same point with a checkbox and a textarea and kept them local for the same
 * reason. What they must not do is invent a second way to label a control or to describe
 * one: both take their id and their `aria-describedby` from `useFieldControl`, so a `Field`
 * around them behaves exactly as it does around a `TextInput`.
 */

export function DateField({
  label,
  value,
  hint,
  error,
  onChange,
  className,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint?: string | undefined;
  readonly error?: string | undefined;
  readonly onChange: (value: string) => void;
  readonly className?: string | undefined;
}): ReactElement {
  return (
    <Field {...(hint === undefined ? {} : { hint })} {...(error === undefined ? {} : { error })}>
      <FieldLabel>{label}</FieldLabel>
      <DateControl value={value} onChange={onChange} className={className} />
    </Field>
  );
}

function DateControl({
  value,
  onChange,
  className,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly className?: string | undefined;
}): ReactElement {
  const control = useFieldControl();
  return (
    <input
      {...control}
      type="date"
      value={value}
      onChange={(event) => {
        onChange(event.target.value);
      }}
      className={cx(CONTROL_CLASSES, 'border-border font-mono tabular-nums', className)}
    />
  );
}

export function CheckboxField({
  label,
  hint,
  checked,
  onCheckedChange,
}: {
  readonly label: ReactNode;
  readonly hint?: string | undefined;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}): ReactElement {
  return (
    <Field className="gap-0" {...(hint === undefined ? {} : { hint })}>
      <div className="flex items-center gap-2">
        <CheckboxControl checked={checked} onCheckedChange={onCheckedChange} />
        <FieldLabel>{label}</FieldLabel>
      </div>
    </Field>
  );
}

function CheckboxControl({
  checked,
  onCheckedChange,
}: {
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}): ReactElement {
  const control = useFieldControl();
  return (
    <input
      {...control}
      type="checkbox"
      checked={checked}
      className="size-4 rounded-sm border border-border accent-accent"
      onChange={(event) => {
        onCheckedChange(event.target.checked);
      }}
    />
  );
}

/**
 * The view switcher: a group of buttons rather than a tablist.
 *
 * The same trade `screens/reports.tsx` documents — Radix ships no Tabs primitive here, and
 * a hand-rolled `role="tablist"` owes a roving-tabindex keyboard model that native buttons
 * already provide.
 */
export function ViewSwitch<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: T;
  readonly options: readonly { readonly id: T; readonly label: string }[];
  readonly onChange: (value: T) => void;
}): ReactElement {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          onClick={() => {
            onChange(option.id);
          }}
          className={cx(
            'rounded-md border px-3 py-1 text-base transition-colors',
            value === option.id
              ? 'border-border bg-surface-selected font-medium text-text'
              : 'border-transparent text-text-muted hover:bg-surface-hover hover:text-text',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
