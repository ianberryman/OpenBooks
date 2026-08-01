import type { ReactElement, ReactNode } from 'react';

import { Button, Pill, formatMoney } from '../../components';
import { statusPresentation } from './order-presentation';
import type { PurchaseOrder, PurchaseOrderReferenceData } from './queries';

/**
 * The compact (phone-width) read-only view of a purchase order — the AP mirror of
 * `estimates/mobile-document-view.tsx`, minus the whole payment-history section: a purchase
 * order posts no journal and settles nothing (D-M3), so there is no "still owed" figure to
 * headline and no allocation ledger to list.
 *
 * There is no "expired" state either (`order-presentation.ts`): a purchase order does not
 * lapse the way an estimate does, so `expectedDate` is shown as a plain delivery date with no
 * red styling and no "expires in N days" subline.
 *
 * `detail-view.tsx` owns the data (nothing here is fetched independently) and decides *when*
 * to show this (the compact tier, D-120); this component only renders what it is handed. Every
 * figure here is copied off `order`, never recomputed (D-35) — totals are the server's
 * arithmetic.
 */
export interface MobileDocumentViewProps {
  readonly order: PurchaseOrder;
  readonly reference: PurchaseOrderReferenceData;
  readonly actions: ReactNode;
  readonly onNavigateList: () => void;
}

export function MobileDocumentView({
  order,
  reference,
  actions,
  onNavigateList,
}: MobileDocumentViewProps): ReactElement {
  const vendor = reference.vendorsById.get(order.contactId);
  const presented = statusPresentation(order);

  // Skip whichever of the six address fields the vendor has none of — the same rule the vendor
  // card on desktop follows, so the two presentations cannot disagree about which lines exist.
  const addressLines = [
    vendor?.addressLine1 ?? null,
    vendor?.addressLine2 ?? null,
    vendor?.city ?? null,
    vendor?.region ?? null,
    vendor?.postalCode ?? null,
    vendor?.country ?? null,
  ].filter((line): line is string => line !== null && line !== '');

  return (
    <section className="flex flex-col gap-4 pb-24" aria-label="Purchase order">
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">
              Purchase order
            </p>
            <p className="font-mono text-2xl font-semibold text-text">
              #{order.documentNumber ?? '—'}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Pill tone={presented.tone}>{presented.label}</Pill>
            <Button variant="ghost" onClick={onNavigateList} aria-label="Close">
              ✕
            </Button>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-1 rounded-lg border border-border bg-surface p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">Vendor</p>
        <p className="text-base font-medium text-text">
          {vendor?.displayName ?? 'Unknown contact'}
        </p>
        {addressLines.map((line) => (
          <p key={line} className="text-sm text-text-subtle">
            {line}
          </p>
        ))}
      </div>

      <div className="flex items-end justify-between gap-3 rounded-lg border border-border bg-surface p-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">Total</p>
          <p className="mt-0.5 font-mono text-xl font-semibold tabular-nums text-text">
            {formatMoney(order.totals.gross)}
          </p>
        </div>

        <div className="text-right">
          {order.expectedDate !== null ? (
            <>
              <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">
                Expected date
              </p>
              <p className="mt-0.5 font-mono text-sm text-text">{order.expectedDate}</p>
            </>
          ) : (
            <>
              <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">Issued</p>
              <p className="mt-0.5 font-mono text-sm text-text">{order.issueDate}</p>
            </>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium text-text">Line items</p>
        <ul className="flex flex-col gap-2">
          {order.lines.map((line) => (
            <li
              key={line.lineId}
              className="flex flex-col gap-1 rounded-lg border border-border bg-surface p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <p className="min-w-0 truncate font-medium text-text">{line.description}</p>
                <p className="shrink-0 font-mono text-sm tabular-nums text-text">
                  {formatMoney(line.grossAmount)}
                </p>
              </div>
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-text-muted">
                  Qty: {line.quantity} × {formatMoney(line.unitAmount)}
                </p>
                <p className="text-sm text-text-muted">
                  {reference.accountsById.get(line.accountId)?.name ?? '—'}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-col gap-1 rounded-lg border border-border bg-surface-sunken p-3">
        <div className="flex justify-between text-sm text-text-muted">
          <span>Subtotal</span>
          <span className="font-mono tabular-nums text-text">{formatMoney(order.totals.net)}</span>
        </div>
        <div className="flex justify-between text-sm text-text-muted">
          <span>Tax</span>
          <span className="font-mono tabular-nums text-text">{formatMoney(order.totals.tax)}</span>
        </div>
        <div className="flex justify-between border-t border-border pt-1 text-sm font-semibold text-text">
          <span>Total</span>
          <span className="font-mono tabular-nums">{formatMoney(order.totals.gross)}</span>
        </div>
      </div>

      {order.memo !== null && order.memo !== '' && (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">
            Notes / Terms
          </p>
          <p className="whitespace-pre-wrap rounded-md bg-accent-soft p-3 text-sm italic text-text">
            {order.memo}
          </p>
        </div>
      )}

      <div className="no-print fixed inset-x-0 bottom-0 z-10 flex items-center justify-end gap-2 border-t border-border bg-surface p-3">
        {actions}
      </div>
    </section>
  );
}
