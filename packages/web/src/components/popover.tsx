import * as PopoverPrimitive from '@radix-ui/react-popover';
import type { ComponentPropsWithoutRef, ReactElement } from 'react';

import { cx } from '../lib/cx';

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;

/**
 * The surface shared by every floating panel — the popover itself, the select listbox, and
 * the combobox listbox — so the three cannot drift into three different elevations.
 *
 * `--radix-popper-available-height` is set by Radix's positioning engine; reading it here
 * is what keeps a listbox from extending past the viewport on a short window, which is the
 * failure mode of a fixed `max-height`.
 */
export const FLOATING_SURFACE_CLASSES =
  'z-50 rounded-lg border border-border bg-surface-overlay shadow-overlay ' +
  'max-h-[var(--radix-popper-available-height)] overflow-y-auto';

export type PopoverContentProps = ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>;

export function PopoverContent({
  className,
  sideOffset = 6,
  ...props
}: PopoverContentProps): ReactElement {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        sideOffset={sideOffset}
        className={cx(FLOATING_SURFACE_CLASSES, 'p-2', className)}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
