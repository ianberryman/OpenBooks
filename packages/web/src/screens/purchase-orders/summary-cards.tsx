import type { ReactElement, ReactNode } from 'react';

import { ErrorBanner, formatMoney } from '../../components';
import { cx } from '../../lib/cx';
import type { PurchaseOrderCardFilter } from './order-presentation';
import type { PurchaseOrdersSummaryResult } from './queries';

/**
 * The three headline figures above the purchase-orders list: value still in draft, value
 * approved and awaiting conversion, and what converted to a bill in the last 30 days — the
 * AP-side mirror of `estimates/summary-cards.tsx`'s `EstimatesSummaryCards`.
 *
 * Every number is the server's — `usePurchaseOrdersSummary` reads them from
 * `/v1/purchase-orders/summary`, computed directly from the purchase-order tables since a PO
 * posts no journal and there is no aging repo to reuse (D-M3). Nothing here sums the
 * purchase-orders page: that page is capped, so a browser total would be wrong past the first
 * page, which is the whole reason the endpoint exists.
 *
 * ## Three lifecycle cards, not open/expired/converted
 *
 * An estimate can lapse, so its middle card is "Expired"; a purchase order does not — its
 * `expectedDate` is an informational delivery date (D-M6) — so the three cards are the three
 * lifecycle states instead: draft, awaiting conversion, converted. There is no red state here.
 *
 * Each card is also a **filter toggle**: tapping it narrows the list to the purchase orders it
 * counts (`onSelectFilter`) and its border lights up (`activeFilter`), tapping again clears
 * it. The subset each card maps to is in `matchesCardFilter`.
 *
 * Below `sm` the cards are a horizontal-scroll strip so the third peeks and invites the
 * scroll (D-123's compact-tier polish); at `sm` and up they are a three-column grid.
 */
export function PurchaseOrdersSummaryCards({
  summary,
  activeFilter,
  onSelectFilter,
}: {
  readonly summary: PurchaseOrdersSummaryResult;
  readonly activeFilter: PurchaseOrderCardFilter | null;
  readonly onSelectFilter: (filter: PurchaseOrderCardFilter) => void;
}): ReactElement {
  if (summary.error != null) {
    return <ErrorBanner error={summary.error} onRetry={summary.refetch} />;
  }

  const data = summary.data;
  const draftOrders =
    data === null ? '' : `Across ${data.draftCount} draft${data.draftCount === 1 ? '' : 's'}`;

  return (
    <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-1 sm:mx-0 sm:grid sm:grid-cols-3 sm:gap-4 sm:overflow-visible sm:px-0 sm:pb-0">
      <Card
        label="Draft"
        subtext={draftOrders}
        active={activeFilter === 'draft'}
        onSelect={() => onSelectFilter('draft')}
      >
        {data === null ? null : formatMoney(data.draftValue)}
      </Card>
      <Card
        label="Awaiting conversion"
        subtext={data === null ? '' : `${data.approvedCount} approved`}
        active={activeFilter === 'approved'}
        onSelect={() => onSelectFilter('approved')}
      >
        {data === null ? null : formatMoney(data.approvedValue)}
      </Card>
      <Card
        label="Converted (30 days)"
        subtext="Converted in the last 30 days"
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
