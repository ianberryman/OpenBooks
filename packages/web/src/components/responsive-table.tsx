import type { ReactElement, ReactNode } from 'react';

import { cx } from '../lib/cx';

export interface ResponsiveTableProps {
  readonly children: ReactNode;
  readonly className?: string | undefined;
  /**
   * Names the scroll region for assistive technology. Supplied only where the label adds
   * something — most tables sit under a heading that already names them, and a generic
   * "Scrollable table" on every one of the ~60 sites would be noise, not help. When absent
   * the wrapper is a plain focusable scroller with no `role`.
   */
  readonly 'aria-label'?: string | undefined;
}

/**
 * Initiative R (D-123). The floor under every data table on a narrow viewport: a
 * horizontal-scroll wrapper, so a table wider than the screen scrolls inside its own box
 * instead of forcing the whole page to scroll sideways (the acceptance bar — no horizontal
 * `<body>` scroll at 360px).
 *
 * `overflow-x-auto` alone is reachable only with a pointer, so `tabIndex={0}` makes the
 * scroll region focusable and therefore scrollable from the keyboard. On desktop the
 * utility is inert — there is nothing to scroll when the table fits — so this is exactly
 * the table it wraps at every width; no `md:` reset is needed.
 *
 * This is the *baseline*. The highest-traffic money tables additionally collapse to a card
 * layout `< md` (D-123's polish tier) at their own call sites; this wrapper is what the
 * other ~50 get, and what those money tables fall back to above `md`.
 */
export function ResponsiveTable({
  children,
  className,
  'aria-label': ariaLabel,
}: ResponsiveTableProps): ReactElement {
  return (
    <div
      className={cx('w-full overflow-x-auto', className)}
      tabIndex={0}
      {...(ariaLabel !== undefined ? { role: 'region', 'aria-label': ariaLabel } : {})}
    >
      {children}
    </div>
  );
}
