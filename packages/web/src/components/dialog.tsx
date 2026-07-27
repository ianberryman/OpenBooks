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
          'fixed top-1/2 left-1/2 z-50 w-[calc(100vw-2rem)] max-w-dialog -translate-x-1/2 -translate-y-1/2',
          'rounded-xl border border-border bg-surface-overlay p-5 shadow-overlay',
          'flex max-h-[85vh] flex-col gap-4',
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

        {/* The body scrolls, not the dialog: a long chart-of-accounts form must not push
            its own confirm button off the bottom of the viewport. */}
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>

        {footer !== undefined && <div className="flex justify-end gap-2">{footer}</div>}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
