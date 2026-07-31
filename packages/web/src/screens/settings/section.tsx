import type { ReactElement, ReactNode } from 'react';
import { useId } from 'react';

import { cx } from '../../lib/cx';

/**
 * The presentational atoms the three settings sections share.
 *
 * Deliberately not a component library and deliberately not in `src/components/`: D-24's
 * rule is that a seventh shared component arrives with the screen that needs it, and a
 * section heading and three table class strings are needed by one screen. They live here
 * so the three sections cannot draw three different tables, and they take no props that a
 * real component would have to be designed around. `Pill` used to live here too, until
 * enough other screens reached across for it that it belonged in `src/components/` instead
 * — see `pill.tsx`.
 */

export interface SettingsSectionProps {
  readonly title: string;
  readonly description: ReactNode;
  /** Rendered on the heading row — the section's primary action, or a counter. */
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}

export function SettingsSection({
  title,
  description,
  actions,
  children,
}: SettingsSectionProps): ReactElement {
  const headingId = useId();

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={headingId} className="text-lg font-semibold text-text">
            {title}
          </h2>
          <p className="max-w-prose text-sm text-text-muted">{description}</p>
        </div>
        {actions !== undefined && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/**
 * A statement about state that is not an error — "the org has no periods", "the message
 * did not go out". `ErrorBanner` is the wrong surface for these: it is `role="alert"` and
 * red, and it presents an `ApiError`, whereas none of these is a failure of a request.
 */
export type NoticeTone = 'warning' | 'success' | 'info';

const NOTICE_CLASSES: Readonly<Record<NoticeTone, string>> = {
  warning: 'border-warning-border bg-warning-soft text-warning-text',
  success: 'border-success-border bg-success-soft text-success-text',
  info: 'border-border bg-surface-sunken text-text-muted',
};

export interface NoticeProps {
  readonly tone: NoticeTone;
  readonly title?: ReactNode;
  readonly children: ReactNode;
  readonly actions?: ReactNode;
  readonly className?: string | undefined;
}

export function Notice({ tone, title, children, actions, className }: NoticeProps): ReactElement {
  return (
    <div
      /**
       * `status` and not `alert`: these appear as a consequence of loading state or of a
       * successful write, and an `alert` interrupts a screen reader mid-sentence for
       * something the user is not required to act on right now.
       */
      role="status"
      className={cx(
        'flex flex-wrap items-start justify-between gap-3 rounded-lg border p-3',
        NOTICE_CLASSES[tone],
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-1">
        {title !== undefined && <p className="text-sm font-semibold">{title}</p>}
        <div className="max-w-prose text-sm">{children}</div>
      </div>
      {actions !== undefined && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export const TABLE_CLASSES = 'w-full border-collapse text-left text-sm';
export const TH_CLASSES = 'border-b border-border px-2 py-2 text-xs font-medium text-text-subtle';
export const TD_CLASSES = 'border-b border-border px-2 py-2 align-middle text-text';

/** The row a table shows instead of nothing at all. */
export function EmptyRow({
  columns,
  children,
}: {
  readonly columns: number;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <tr>
      <td colSpan={columns} className={cx(TD_CLASSES, 'text-text-muted')}>
        {children}
      </td>
    </tr>
  );
}
