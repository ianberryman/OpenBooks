import type { ReactElement, ReactNode } from 'react';

import { ErrorBanner, formatMoney } from '../../components';
import { cx } from '../../lib/cx';
import type { EstimateCardFilter } from './estimate-presentation';
import type { EstimatesSummaryResult } from './queries';

/**
 * The three headline figures above the estimates list: total still open, total expired,
 * and won (converted to an invoice) in the last 30 days — the estimates mirror of
 * `sales/summary-cards.tsx`'s `InvoicesSummaryCards` (estimates redesign, AGENT E-LEAVES).
 *
 * Every number is the server's — `useEstimatesSummary` reads them from
 * `/v1/estimates/summary`, computed directly from the estimates tables since an estimate
 * posts no journal and there is no aging repo to reuse (D-M3). Nothing here sums the
 * estimates page: that page is capped, so a browser total would be wrong past the first
 * page, which is the whole reason the endpoint exists.
 *
 * Each card is also a **filter toggle**: tapping it narrows the list to the estimates it
 * counts (`onSelectFilter`) and its border lights up (`activeFilter`), tapping again
 * clears it. The subset each card maps to is in `matchesCardFilter`.
 *
 * Below `sm` the cards are a horizontal-scroll strip so the third peeks and invites the
 * scroll (D-123's compact-tier polish); at `sm` and up they are a three-column grid.
 */
export function EstimatesSummaryCards({
  summary,
  activeFilter,
  onSelectFilter,
}: {
  readonly summary: EstimatesSummaryResult;
  readonly activeFilter: EstimateCardFilter | null;
  readonly onSelectFilter: (filter: EstimateCardFilter) => void;
}): ReactElement {
  if (summary.error != null) {
    return <ErrorBanner error={summary.error} onRetry={summary.refetch} />;
  }

  const data = summary.data;
  const openEstimates =
    data === null
      ? ''
      : `Across ${data.openCount} open ${data.openCount === 1 ? 'estimate' : 'estimates'}`;

  return (
    <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-1 sm:mx-0 sm:grid sm:grid-cols-3 sm:gap-4 sm:overflow-visible sm:px-0 sm:pb-0">
      <Card
        label="Open value"
        subtext={openEstimates}
        active={activeFilter === 'open'}
        onSelect={() => onSelectFilter('open')}
      >
        {data === null ? null : formatMoney(data.openValue)}
      </Card>
      <Card
        label="Expired"
        subtext={data === null ? '' : `${data.expiredCount} expired`}
        tone={data !== null && data.expiredValue !== '0' ? 'danger' : 'neutral'}
        active={activeFilter === 'expired'}
        onSelect={() => onSelectFilter('expired')}
      >
        {data === null ? null : formatMoney(data.expiredValue)}
      </Card>
      <Card
        label="Converted (30 days)"
        subtext="Won in the last 30 days"
        tone="success"
        active={activeFilter === 'converted'}
        onSelect={() => onSelectFilter('converted')}
      >
        {data === null ? null : formatMoney(data.convertedValue)}
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
