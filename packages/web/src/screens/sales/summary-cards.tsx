import type { ReactElement, ReactNode } from 'react';

import { ErrorBanner, formatMoney } from '../../components';
import { cx } from '../../lib/cx';
import type { InvoiceCardFilter } from './invoice-list';
import type { InvoicesSummaryResult } from './queries';

/**
 * The three headline figures above the invoices list: total still unpaid, total overdue,
 * and paid in the last 30 days (OB-069 UI, the AR mirror of `purchases/summary-cards.tsx`).
 *
 * Every number is the server's — `useInvoicesSummary` reads them from
 * `/v1/invoices/summary`, where outstanding is total minus allocations computed on read
 * (D-34). Nothing here sums the invoice page: that page is capped, so a browser total
 * would be wrong past the first page, which is the whole reason the endpoint exists.
 *
 * Each card is also a **filter toggle**: tapping it narrows the list to the invoices it
 * counts (`onSelectFilter`) and its border lights up (`activeFilter`), tapping again
 * clears it. The subset each card maps to is in `matchesCardFilter`.
 *
 * Below `sm` the cards are a horizontal-scroll strip so the third peeks and invites the
 * scroll (D-123's compact-tier polish); at `sm` and up they are a three-column grid.
 */
export function InvoicesSummaryCards({
  summary,
  activeFilter,
  onSelectFilter,
}: {
  readonly summary: InvoicesSummaryResult;
  readonly activeFilter: InvoiceCardFilter | null;
  readonly onSelectFilter: (filter: InvoiceCardFilter) => void;
}): ReactElement {
  if (summary.error != null) {
    return <ErrorBanner error={summary.error} onRetry={summary.refetch} />;
  }

  const data = summary.data;
  const openInvoices =
    data === null
      ? ''
      : `Across ${data.openCount} open ${data.openCount === 1 ? 'invoice' : 'invoices'}`;

  return (
    <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-1 sm:mx-0 sm:grid sm:grid-cols-3 sm:gap-4 sm:overflow-visible sm:px-0 sm:pb-0">
      <Card
        label="Total unpaid"
        subtext={openInvoices}
        active={activeFilter === 'unpaid'}
        onSelect={() => onSelectFilter('unpaid')}
      >
        {data === null ? null : formatMoney(data.totalUnpaid)}
      </Card>
      <Card
        label="Total overdue"
        subtext={data === null ? '' : `${data.overdueCount} overdue`}
        tone={data !== null && data.totalOverdue !== '0' ? 'danger' : 'neutral'}
        active={activeFilter === 'overdue'}
        onSelect={() => onSelectFilter('overdue')}
      >
        {data === null ? null : formatMoney(data.totalOverdue)}
      </Card>
      <Card
        label="Paid in last 30 days"
        subtext="Money in from customers"
        tone="success"
        active={activeFilter === 'paid'}
        onSelect={() => onSelectFilter('paid')}
      >
        {data === null ? null : formatMoney(data.paidLast30Days)}
      </Card>
    </div>
  );
}

const AMOUNT_TONE = {
  neutral: 'text-text',
  danger: 'text-danger-text',
  success: 'text-success-text',
} as const;

function Card({
  label,
  subtext,
  tone = 'neutral',
  active,
  onSelect,
  children,
}: {
  readonly label: string;
  readonly subtext: string;
  readonly tone?: keyof typeof AMOUNT_TONE;
  readonly active: boolean;
  readonly onSelect: () => void;
  readonly children: ReactNode;
}): ReactElement {
  // `children` is null while the figure is loading — a pulsing bar stands in for the
  // amount so the row keeps its height rather than jumping when the numbers arrive.
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onSelect}
      className={cx(
        'min-w-[14rem] shrink-0 rounded-lg border bg-surface p-4 text-left transition-colors hover:bg-surface-hover sm:min-w-0',
        active ? 'border-accent ring-1 ring-accent' : 'border-border',
      )}
    >
      <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">{label}</p>
      {children === null ? (
        <div className="mt-2 h-7 w-28 animate-pulse rounded bg-surface-sunken" aria-hidden />
      ) : (
        <p className={cx('mt-1 text-2xl font-semibold tabular-nums', AMOUNT_TONE[tone])}>
          {children}
        </p>
      )}
      {subtext === '' ? (
        <div className="mt-2 h-4 w-20 animate-pulse rounded bg-surface-sunken" aria-hidden />
      ) : (
        <p className="mt-1 text-sm text-text-subtle">{subtext}</p>
      )}
    </button>
  );
}
