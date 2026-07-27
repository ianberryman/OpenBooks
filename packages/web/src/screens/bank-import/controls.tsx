import type { ReactElement, ReactNode } from 'react';

import { Field, FieldLabel, useFieldControl } from '../../components';

/**
 * The one control `src/components` does not have, kept local to this screen.
 *
 * D-24 says a component arrives with the screen that needs it and not before, and a
 * checkbox is not this screen's to promote to the shared surface — `money-in/controls.tsx`
 * and `contacts/contact-form.tsx` reached the same point and kept their own. What it must
 * not do is invent a second way to label or describe a control: it takes its id and its
 * `aria-describedby` from `useFieldControl`, so a `Field` around it behaves exactly as it
 * does around a `TextInput`.
 */
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
