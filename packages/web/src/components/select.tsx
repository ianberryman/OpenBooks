import * as SelectPrimitive from '@radix-ui/react-select';
import type { ReactElement } from 'react';

import { cx } from '../lib/cx';
import { CONTROL_CLASSES, useFieldControl } from './field';
import { FLOATING_SURFACE_CLASSES } from './popover';

/**
 * A select over a **closed, short** list — an account type, a period status, a role.
 *
 * The distinction from `Combobox` is not stylistic. A select has no text entry, so its
 * keyboard model is type-ahead over a fixed set and Radix's `Select` implements exactly
 * that. A list the user must filter to use is a combobox, and picking the wrong one is
 * felt at 400 accounts, not at 6.
 */
export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface SelectProps {
  readonly value: string | null;
  readonly onValueChange: (value: string) => void;
  readonly options: readonly SelectOption[];
  readonly placeholder?: string;
  readonly disabled?: boolean;
  /**
   * Only when there is no `<Field>` above — the same escape hatch `Combobox` carries, and
   * for the reason `useFieldControl` is tolerant of a missing `Field`: a report toolbar's
   * filter is a real select that belongs to no labelled form field. Without it a
   * standalone `Select` has no accessible name at all, and the tolerance documented on
   * `useFieldControl` is unreachable through this component.
   */
  readonly 'aria-label'?: string;
  readonly className?: string | undefined;
}

export function Select({
  value,
  onValueChange,
  options,
  placeholder = 'Select…',
  disabled,
  className,
  ...rest
}: SelectProps): ReactElement {
  const control = useFieldControl();

  /**
   * Radix treats `''` as "no value" and warns on it, while the API models an unset
   * selection as `null`. Converted at the boundary rather than by making every screen hold
   * a sentinel empty string — and spread rather than passed as `undefined`, because
   * `exactOptionalPropertyTypes` makes an absent prop and an explicitly-undefined one
   * different types.
   */
  const valueProps = value === null ? {} : { value };

  return (
    <SelectPrimitive.Root
      {...valueProps}
      onValueChange={onValueChange}
      disabled={disabled ?? false}
    >
      <SelectPrimitive.Trigger
        {...control}
        {...rest}
        className={cx(
          CONTROL_CLASSES,
          'border-border flex items-center justify-between gap-2 overflow-hidden text-left',
          'data-[placeholder]:text-text-subtle',
          className,
        )}
      >
        {/* The value truncates rather than wraps: a long option — an org name in the header
            switcher — in a fixed-width trigger would otherwise spill past the `h-9` onto two
            or three lines. `min-w-0` lets the flex child shrink so `truncate` can bite; the
            icon stays pinned with `shrink-0`. */}
        <span className="min-w-0 flex-1 truncate">
          <SelectPrimitive.Value placeholder={placeholder} />
        </span>
        <SelectPrimitive.Icon className="shrink-0 text-text-subtle" aria-hidden>
          ▾
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>

      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          /**
           * `position="popper"` rather than Radix's default item-aligned placement, which
           * overlays the trigger. In a journal-line grid that hides the row being edited.
           */
          position="popper"
          sideOffset={4}
          className={cx(FLOATING_SURFACE_CLASSES, 'min-w-[var(--radix-select-trigger-width)] p-1')}
        >
          <SelectPrimitive.Viewport>
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled ?? false}
                className={cx(
                  'flex cursor-default items-center rounded-sm px-2 py-1.5 text-base text-text',
                  'outline-none select-none',
                  // Radix sets `data-highlighted` for both pointer and keyboard, so hover
                  // and arrow-key navigation cannot look different by accident.
                  'data-[highlighted]:bg-surface-hover',
                  'data-[state=checked]:bg-surface-selected',
                  'data-[disabled]:text-text-subtle data-[disabled]:pointer-events-none',
                )}
              >
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
