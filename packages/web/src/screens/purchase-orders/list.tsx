import type { ReactElement } from 'react';

import { Pill, ResponsiveTable, formatMoney } from '../../components';
import { useIsCompact } from '../../lib/use-viewport';
import { statusPresentation } from './order-presentation';
import type { PurchaseOrderReferenceData, PurchaseOrderSummary } from './queries';
import { PLURAL } from './vocabulary';

/**
 * A page of purchase orders (PO redesign, matching the bill/estimate treatment) — the AP-side
 * mirror of `estimates/list.tsx`, adapted to a non-posting document.
 *
 * ## No settlement column, because nothing here is ever settled
 *
 * A bill's list carries a still-owed figure because payments apply against it; a purchase
 * order posts no journal and takes no payment (D-M3), so there is nothing analogous to show.
 * The desktop table's last column is simply the total, and the compact card's two-up footer
 * is Expected/Total rather than Due/Outstanding.
 *
 * ## No date reddens, because a purchase order does not lapse
 *
 * An estimate's list reddens its expiry column once an approved estimate has lapsed. A
 * purchase order has no such state: `expectedDate` is an informational delivery date (D-M6),
 * so the Expected column is rendered plainly (em-dash when null) and the status pill comes
 * straight off the stored `status` through `statusPresentation` — there is no date-derived
 * fourth state to override it with.
 *
 * ## Actions moved off this row
 *
 * The row-based shape this replaced carried five buttons per row — edit, approve, convert,
 * send, discard. Now a row does exactly one thing, `onOpen`, and every action lives on the
 * page it routes to (the editor for a draft, the detail view otherwise) — the same split the
 * bill and estimate lists made when their own per-row controls became a page.
 */
export interface PurchaseOrderListProps {
  readonly orders: readonly PurchaseOrderSummary[];
  readonly reference: PurchaseOrderReferenceData;
  readonly truncated: boolean;
  readonly onOpen: (purchaseOrderId: string) => void;
}

export function PurchaseOrderList({
  orders,
  reference,
  truncated,
  onOpen,
}: PurchaseOrderListProps): ReactElement {
  const isCompact = useIsCompact();

  if (orders.length === 0) {
    return (
      <p className="text-text-muted">
        No purchase orders yet. "New purchase order" starts a draft — nothing is sent or converted
        until you say so.
      </p>
    );
  }

  function vendorName(order: PurchaseOrderSummary): string {
    return reference.vendorsById.get(order.contactId)?.displayName ?? 'Unknown vendor';
  }

  return (
    <div className="flex flex-col gap-2">
      {isCompact ? (
        <ul className="flex flex-col gap-3" aria-label={PLURAL}>
          {orders.map((order) => (
            <PurchaseOrderCard
              key={order.id}
              order={order}
              vendorName={vendorName(order)}
              onOpen={onOpen}
            />
          ))}
        </ul>
      ) : (
        <ResponsiveTable>
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">{PLURAL}</caption>
            <thead>
              <tr className="text-left text-xs text-text-subtle">
                <th scope="col" className="p-2 font-medium">
                  #
                </th>
                <th scope="col" className="p-2 font-medium">
                  Number
                </th>
                <th scope="col" className="p-2 font-medium">
                  Vendor
                </th>
                <th scope="col" className="p-2 font-medium">
                  Issued
                </th>
                <th scope="col" className="p-2 font-medium">
                  Expected date
                </th>
                <th scope="col" className="p-2 font-medium">
                  Status
                </th>
                <th scope="col" className="p-2 text-right font-medium">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order, index) => {
                const status = statusPresentation(order);
                return (
                  <tr key={order.id} className="border-t border-border hover:bg-surface-hover">
                    <td className="p-2 font-mono text-text-muted">{index + 1}</td>
                    <td className="p-2">
                      <button
                        type="button"
                        onClick={() => {
                          onOpen(order.id);
                        }}
                        className="rounded-sm font-mono text-text underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
                      >
                        {order.documentNumber ?? 'Draft'}
                      </button>
                    </td>
                    <td className="p-2 text-text">{vendorName(order)}</td>
                    <td className="p-2 font-mono text-text-muted">{order.issueDate}</td>
                    <td className="p-2 font-mono text-text-muted">{order.expectedDate ?? '—'}</td>
                    <td className="p-2">
                      <Pill tone={status.tone}>{status.label}</Pill>
                    </td>
                    <td className="p-2 text-right font-mono tabular-nums text-text">
                      {formatMoney(order.totals.gross)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ResponsiveTable>
      )}

      {truncated && (
        <p className="text-xs text-text-subtle">
          Showing the first page. Narrow the filter — by vendor, by status, or by number — to reach
          the rest.
        </p>
      )}
    </div>
  );
}

/**
 * One purchase order as a card, for the compact tier — mirrors `estimates/list.tsx`'s
 * `EstimateCard`, minus the settled/owing switch a bill's footer makes: a purchase order
 * settles nothing, so the footer here is always Expected on the left and Total on the right.
 */
function PurchaseOrderCard({
  order,
  vendorName,
  onOpen,
}: {
  readonly order: PurchaseOrderSummary;
  readonly vendorName: string;
  readonly onOpen: (purchaseOrderId: string) => void;
}): ReactElement {
  const status = statusPresentation(order);
  const subline = order.documentNumber === null ? 'Draft' : `#${order.documentNumber}`;

  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(order.id)}
        className="flex w-full flex-col gap-3 rounded-lg border border-border bg-surface p-4 text-left hover:bg-surface-hover"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-lg font-semibold text-text">{vendorName}</p>
            <p className="truncate font-mono text-sm text-text-subtle">{subline}</p>
          </div>
          <div className="flex flex-shrink-0 flex-wrap items-center justify-end gap-1">
            <Pill tone={status.tone}>{status.label}</Pill>
          </div>
        </div>

        <div className="flex items-end justify-between gap-3 border-t border-border pt-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">Expected</p>
            <p className="mt-0.5 font-mono text-sm text-text">{order.expectedDate ?? '—'}</p>
          </div>
          <div className="text-right">
            <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">Total</p>
            <p className="mt-0.5 font-mono text-base font-semibold tabular-nums text-text">
              {formatMoney(order.totals.gross)}
            </p>
          </div>
        </div>
      </button>
    </li>
  );
}
