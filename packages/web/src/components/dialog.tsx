import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { ReactElement, ReactNode } from 'react';

import { cx } from '../lib/cx';

/**
 * Radix Dialog, styled from tokens (D-24).
 *
 * The wrapper is thin on purpose. What Radix supplies here is the part that is genuinely
 * hard and genuinely not this product — the focus trap, the return of focus to the
 * trigger, `aria-modal` and the labelling relationships, inert background content, and
 * scroll locking. What it supplies no opinion about is appearance, which is why it is the
 * right base for a token layer: there is no vendor theme to override.
 */
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export interface DialogContentProps {
  /**
   * Required, and not optional-with-a-fallback. Radix warns at runtime when a dialog has
   * no accessible name; making it a prop means the compiler asks instead.
   */
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly className?: string | undefined;
}

export function DialogContent({
  title,
  description,
  children,
  footer,
  className,
}: DialogContentProps): ReactElement {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-scrim" />
      <DialogPrimitive.Content
        className={cx(
          // Compact (< md), D-124: a full-width sheet anchored to the *top* of the screen.
          // A centred modal leaves a cramped strip down each side on a phone; a full-width
          // sheet fixes that, and the top edge (not the bottom) is where a form's first field
          // and its title should sit — the header owns the top of the screen, the form drops
          // in beneath it rather than floating up from the bottom.
          'fixed inset-x-0 top-0 z-50 max-h-[90vh] w-full rounded-b-xl',
          // md and up: the centred dialog, unchanged from D-24 — restore the anchor, width
          // cap, centring translate, full rounding and the tighter height cap.
          'md:inset-x-auto md:top-1/2 md:left-1/2 md:max-h-[85vh] md:w-[calc(100vw-2rem)]',
          'md:max-w-dialog md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-t-xl',
          'border border-border bg-surface-overlay p-5 shadow-overlay',
          'flex flex-col gap-4',
          className,
        )}
      >
        <div className="flex flex-col gap-1">
          <DialogPrimitive.Title className="text-lg font-semibold text-text">
            {title}
          </DialogPrimitive.Title>
          {description !== undefined && (
            <DialogPrimitive.Description className="text-sm text-text-muted">
              {description}
            </DialogPrimitive.Description>
          )}
        </div>

        {/* The body scrolls vertically, not the dialog: a long chart-of-accounts form must
            not push its own confirm button off the bottom of the viewport. `overflow-x-hidden`
            pins the horizontal axis (Initiative R): a form's fields stack and its wide tables
            carry their own `ResponsiveTable` scroller, so nothing here should ever scroll
            sideways — and a native control a hair too wide on a phone is clipped invisibly
            rather than scrolling the whole sheet. */}
        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">{children}</div>

        {footer !== undefined && <div className="flex justify-end gap-2">{footer}</div>}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
