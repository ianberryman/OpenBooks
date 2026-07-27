import type { ReactElement, ReactNode } from 'react';

/**
 * The chrome every viewer shares: a heading, the applied period, and the basis.
 */

export function ReportTitle({
  title,
  subtitle,
  aside,
}: {
  readonly title: string;
  readonly subtitle: ReactNode;
  readonly aside?: ReactNode;
}): ReactElement {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border-strong pb-2">
      <div className="flex flex-col">
        <h2 className="text-lg font-semibold text-text">{title}</h2>
        <p className="text-sm text-text-muted">{subtitle}</p>
      </div>
      {aside}
    </div>
  );
}

/**
 * The reporting basis, printed rather than assumed (D-22).
 *
 * M2 is accrual-only and the responses carry `basis: 'accrual'` for one reason: accrual
 * figures read under a cash-basis heading are a number someone might file. A badge is the
 * cheapest way to make that misreading impossible instead of merely unlikely, and it is
 * the thing that changes when M3 gives the field a second value.
 */
export function BasisBadge({ basis }: { readonly basis: 'accrual' }): ReactElement {
  return (
    <span className="rounded-full border border-border bg-surface-sunken px-2 py-0.5 text-xs text-text-muted">
      {basis === 'accrual' ? 'Accrual basis' : basis}
    </span>
  );
}

/** The bounds the server says it applied, which is not always the ones that were sent. */
export function describeRange(from: string | null, to: string | null): string {
  const start = from ?? 'the ledger’s beginning';
  const end = to ?? 'every posting to date';
  return `${start} to ${end}, both inclusive`;
}

export function ReportPending(): ReactElement {
  return (
    <p role="status" className="text-text-subtle">
      Running the report…
    </p>
  );
}
