import type { ButtonHTMLAttributes, ReactElement } from 'react';

import { cx } from '../lib/cx';

/**
 * The variants are named for intent rather than appearance — `danger`, not `red` — so that
 * a theme re-binding `--ob-color-danger` reaches every destructive control without a
 * component changing (D-24).
 *
 * `danger` exists for one reason in this application: an action that cannot be undone.
 * Nothing in the ledger deletes, so its M2 call sites are the small set that genuinely
 * removes something — a draft, an invite, a membership.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

const VARIANT_CLASSES: Readonly<Record<ButtonVariant, string>> = {
  primary: 'bg-accent text-accent-on hover:bg-accent-hover border-transparent',
  secondary: 'bg-surface text-text border-border hover:bg-surface-hover',
  ghost: 'bg-transparent text-text-muted border-transparent hover:bg-surface-hover',
  danger: 'bg-danger text-danger-on hover:bg-danger-hover border-transparent',
};

const SIZE_CLASSES: Readonly<Record<ButtonSize, string>> = {
  sm: 'h-7 px-2 text-xs gap-1',
  md: 'h-9 px-3 text-base gap-2',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
}

/**
 * `type="button"` by default, overridable.
 *
 * The default in HTML is `submit`, and a button inside a form that was meant to add a
 * journal line and instead posts the entry is the kind of bug that only shows up with a
 * keyboard. Every screen in M2 is a form; the default is inverted once, here.
 */
export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  type = 'button',
  ...props
}: ButtonProps): ReactElement {
  return (
    <button
      type={type}
      className={cx(
        'inline-flex items-center justify-center rounded-md border font-medium',
        'transition-colors disabled:pointer-events-none disabled:opacity-50',
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        className,
      )}
      {...props}
    />
  );
}
