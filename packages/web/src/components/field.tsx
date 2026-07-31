import * as LabelPrimitive from '@radix-ui/react-label';
import type { InputHTMLAttributes, ReactElement, ReactNode } from 'react';
import { createContext, useContext, useId } from 'react';

import { cx } from '../lib/cx';

/**
 * The form primitives: a field wrapper, a label, an input, help text, and an error.
 *
 * The wrapper exists because the part of a form that is repeatedly got wrong is not the
 * styling, it is the wiring — `htmlFor`, `aria-describedby`, `aria-invalid`, and the
 * relationship between an error message and the control it describes. Done per screen,
 * that is six chances to omit one and no way to notice: a missing `aria-describedby` looks
 * identical on screen and silently drops the error for anyone using a screen reader.
 *
 * So `Field` mints the ids and its children consume them from context. A screen writes the
 * label, the control, and the message; it never writes an id.
 */
interface FieldContextValue {
  readonly controlId: string;
  readonly hintId: string;
  readonly errorId: string;
  readonly invalid: boolean;
  readonly describedBy: string | undefined;
}

const FieldContext = createContext<FieldContextValue | null>(null);

function useField(part: string): FieldContextValue {
  const value = useContext(FieldContext);
  if (value === null) throw new Error(`<${part}> must be rendered inside a <Field>.`);
  return value;
}

export interface FieldProps {
  /**
   * The message, not a boolean. A field is invalid *because* of something, and splitting
   * the two lets a screen render a red border with no explanation of it — which is a
   * dead end for the person who has to fix the value.
   */
  readonly error?: string | undefined;
  readonly hint?: string | undefined;
  readonly className?: string | undefined;
  readonly children: ReactNode;
}

export function Field({ error, hint, className, children }: FieldProps): ReactElement {
  const id = useId();
  const controlId = `${id}-control`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  /**
   * The error is announced before the hint when both are present, because a screen reader
   * reads `aria-describedby` in the order given and the correction matters more than the
   * guidance the user has already failed to follow.
   */
  const describedBy = cx(error !== undefined && errorId, hint !== undefined && hintId) || undefined;

  return (
    <FieldContext.Provider
      value={{ controlId, hintId, errorId, invalid: error !== undefined, describedBy }}
    >
      <div className={cx('flex flex-col gap-1', className)}>
        {children}
        {hint !== undefined && (
          <p id={hintId} className="text-xs text-text-subtle">
            {hint}
          </p>
        )}
        {error !== undefined && <FieldError id={errorId}>{error}</FieldError>}
      </div>
    </FieldContext.Provider>
  );
}

export function FieldLabel({ children }: { readonly children: ReactNode }): ReactElement {
  const { controlId } = useField('FieldLabel');
  return (
    <LabelPrimitive.Root htmlFor={controlId} className="text-sm font-medium text-text">
      {children}
    </LabelPrimitive.Root>
  );
}

/**
 * Rendered by `Field` from its `error` prop, and exported for the one case that is not a
 * field — a form-level message that belongs to no single control.
 */
export function FieldError({
  id,
  children,
}: {
  readonly id?: string | undefined;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <p
      id={id}
      /**
       * `role="alert"` rather than a live region on the form: the message appears in
       * response to something the user did, and it is the message itself that must be
       * announced, not the region it landed in.
       */
      role="alert"
      className="text-xs text-danger-text"
    >
      {children}
    </p>
  );
}

/**
 * Shared by every control that looks like a text box, so that the input, the select
 * trigger, and the combobox input are one appearance rather than three that drift.
 */
export const CONTROL_CLASSES =
  // `min-w-0` so a control can shrink to its container. Inputs default to `min-width: auto`,
  // which a `width: 100%` does not override — most visibly a native `<input type="date">` on
  // mobile Safari, whose picker has an intrinsic min-width that then overflows a phone-width
  // form and scrolls it sideways (Initiative R). With `min-w-0` the control fits instead.
  'h-9 w-full min-w-0 rounded-md border bg-surface px-2 text-base text-text ' +
  'placeholder:text-text-subtle transition-colors ' +
  'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-text-subtle ' +
  'aria-invalid:border-danger';

export type TextInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'id' | 'aria-describedby' | 'aria-invalid'
>;

export function TextInput({ className, ...props }: TextInputProps): ReactElement {
  const { controlId, invalid, describedBy } = useField('TextInput');
  return (
    <input
      id={controlId}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      className={cx(CONTROL_CLASSES, 'border-border', className)}
      {...props}
    />
  );
}

export interface FieldControlProps {
  readonly id: string | undefined;
  readonly 'aria-invalid': true | undefined;
  readonly 'aria-describedby': string | undefined;
}

/**
 * The same wiring for a control that is not an `<input>` — the select trigger, the
 * combobox — without this module knowing what element it renders.
 *
 * Tolerant of there being no `Field` above it, unlike `FieldLabel`. Not every control
 * belongs to a labelled form field: a date-range filter in a report toolbar is a real
 * select carrying its own `aria-label`, and requiring a `Field` around it would mean
 * inventing an empty one.
 */
export function useFieldControl(): FieldControlProps {
  const field = useContext(FieldContext);
  if (field === null) {
    return { id: undefined, 'aria-invalid': undefined, 'aria-describedby': undefined };
  }
  return {
    id: field.controlId,
    'aria-invalid': field.invalid || undefined,
    'aria-describedby': field.describedBy,
  };
}
