import type { ReactElement, ReactNode } from 'react';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { Button, ResponsiveTable, formatMoney } from '../../components';
import { useIsCompact } from '../../lib/use-viewport';
import { ConvertOrderDialog } from './convert-dialog';
import { MobileDocumentView } from './mobile-document-view';
import { OrderHeader } from './order-header';
import type { Bill, PurchaseOrder, PurchaseOrderReferenceData } from './queries';
import { SendOrderDialog } from './send-dialog';

/**
 * A read-only purchase order: what it says, and the two things left to do with it once it can
 * no longer be edited (D-M6). The AP mirror of `estimates/detail-view.tsx`, with the same
 * whole payment-history section absent — a purchase order posts no journal and settles nothing
 * (D-M3), so there is no settlement to show and no allocation to un-apply. Correcting one is
 * discarding the draft; there is no reversal here.
 *
 * ## No "expired" state, unlike an estimate
 *
 * An estimate lapses (`expiryDate < today` → an "Expired" pill and a red warning); a purchase
 * order does not (`order-presentation.ts`'s own words). `expectedDate` is a purely
 * informational delivery date, so it is shown as a plain field and the status pill is only
 * ever the stored `status` — `draft` → `approved` → `converted`.
 *
 * ## Convert is the only irreversible step
 *
 * `ConvertOrderDialog` is reused as-is rather than re-implemented: convert-once is enforced by
 * the server's row-locked read (`purchase_order_already_converted` on a second attempt), and
 * this view only stops offering the button once `status` says `converted` (D-M4).
 *
 * ## `initialSend`
 *
 * `order-editor.tsx`'s Approve action hands off here wanting the Send dialog already open
 * (`onApproved(approved, { openSend: true })`, carried through the route as navigation state) —
 * one primary action from the user's point of view ("approve and send") implemented as two
 * separate calls because the API offers Approve and Send separately. Read once into the
 * `sending` state's initializer, not watched with an effect — it names an intent for the order
 * this view mounted with.
 */
export interface PurchaseOrderDetailViewProps {
  readonly order: PurchaseOrder;
  readonly reference: PurchaseOrderReferenceData;
  readonly onBack: () => void;
  readonly initialSend?: boolean;
  readonly onConverted: (bill: Bill) => void;
  readonly onChanged: () => void;
}

export function PurchaseOrderDetailView({
  order,
  reference,
  onBack,
  initialSend,
  onConverted,
  onChanged,
}: PurchaseOrderDetailViewProps): ReactElement {
  const [converting, setConverting] = useState(false);
  const [sending, setSending] = useState(() => initialSend === true && order.status !== 'draft');

  const vendor = reference.vendorsById.get(order.contactId);

  /**
   * Built once and handed to both presentations (`OrderHeader` on desktop, the sticky
   * footer inside `MobileDocumentView` on a phone) — a button is never wired up twice. `draft`
   * offers nothing here because a draft is edited, not viewed (`order-editor.tsx` owns that
   * state).
   */
  const actions: ReactNode = (
    <>
      {order.status === 'approved' && (
        <Button variant="primary" onClick={() => setConverting(true)}>
          Convert to bill
        </Button>
      )}

      {order.status !== 'draft' && (
        <Button
          variant={order.status === 'approved' ? 'secondary' : 'primary'}
          onClick={() => setSending(true)}
        >
          Send
        </Button>
      )}

      <Button
        variant="secondary"
        onClick={() => {
          window.print();
        }}
      >
        Print
      </Button>

      {order.status === 'converted' && order.convertedBillId !== null && (
        <Link
          to={`/purchases/bills/${order.convertedBillId}`}
          className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-border bg-surface px-3 text-base font-medium text-text transition-colors hover:bg-surface-hover"
        >
          View bill
        </Link>
      )}
    </>
  );

  const convertDialog = (
    <ConvertOrderDialog
      order={converting ? order : null}
      reference={reference}
      onOpenChange={setConverting}
      onConverted={(bill) => {
        onChanged();
        onConverted(bill);
      }}
    />
  );

  const sendDialog = (
    <SendOrderDialog
      order={sending ? order : null}
      reference={reference}
      onOpenChange={setSending}
    />
  );

  if (useIsCompact()) {
    // The phone read-only layout. The dialogs stay rendered alongside it — not inside a
    // ternary branch shared with desktop-only content, because this view has no non-compact
    // sibling for them to hang off — so Convert/Send still have somewhere to open.
    return (
      <>
        <MobileDocumentView
          order={order}
          reference={reference}
          actions={actions}
          onNavigateList={onBack}
        />

        {convertDialog}
        {sendDialog}
      </>
    );
  }

  return (
    <section
      className="flex flex-col gap-4"
      aria-label={`Purchase order ${order.documentNumber ?? ''}`}
    >
      <OrderHeader document={order} actions={actions} onNavigateList={onBack} />

      <div className="flex flex-wrap items-start justify-between gap-6 rounded-lg border border-border bg-surface p-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">
            Expected date
          </p>
          {/* Purely informational (`order-presentation.ts`): a purchase order does not lapse,
              so there is no subline and no red styling — an em-dash when the vendor's delivery
              date is unknown. */}
          <p className="mt-0.5 font-mono text-xl font-semibold text-text">
            {order.expectedDate ?? '—'}
          </p>
        </div>

        <div className="flex gap-8">
          <div className="text-right">
            <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">Total</p>
            <p className="mt-0.5 font-mono text-xl font-semibold tabular-nums text-text">
              {formatMoney(order.totals.gross)}
            </p>
          </div>

          {order.status === 'converted' && order.convertedBillId !== null && (
            <div className="text-right">
              <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">
                Converted
              </p>
              <p className="mt-0.5 text-sm">
                <Link
                  to={`/purchases/bills/${order.convertedBillId}`}
                  className="underline underline-offset-2 hover:no-underline"
                >
                  View bill
                </Link>
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-6 rounded-lg border border-border bg-surface p-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">Vendor</p>
          <p className="mt-0.5 text-base font-medium text-text">
            {vendor?.displayName ?? 'Unknown contact'}
          </p>
          {vendor?.addressLine1 != null && (
            <p className="text-sm text-text-subtle">{vendor.addressLine1}</p>
          )}
          {vendor?.addressLine2 != null && (
            <p className="text-sm text-text-subtle">{vendor.addressLine2}</p>
          )}
          {vendor?.city != null && <p className="text-sm text-text-subtle">{vendor.city}</p>}
          {vendor?.region != null && <p className="text-sm text-text-subtle">{vendor.region}</p>}
          {vendor?.postalCode != null && (
            <p className="text-sm text-text-subtle">{vendor.postalCode}</p>
          )}
          {vendor?.country != null && <p className="text-sm text-text-subtle">{vendor.country}</p>}
        </div>

        <div className="flex gap-8">
          <div className="text-right">
            <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">
              Reference
            </p>
            <p className="mt-0.5 font-mono text-sm text-text">{order.reference ?? '—'}</p>
          </div>

          <div className="text-right">
            <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">
              Issue date
            </p>
            <p className="mt-0.5 font-mono text-sm text-text">{order.issueDate}</p>
          </div>
        </div>
      </div>

      <ResponsiveTable aria-label="Purchase order lines">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Purchase order lines</caption>
          <thead>
            <tr className="text-left text-xs text-text-subtle">
              <th scope="col" className="p-1 font-medium">
                Description
              </th>
              <th scope="col" className="p-1 text-right font-medium">
                Quantity
              </th>
              <th scope="col" className="p-1 font-medium">
                Account
              </th>
              <th scope="col" className="p-1 text-right font-medium">
                Unit price
              </th>
              <th scope="col" className="p-1 text-right font-medium">
                Line total
              </th>
            </tr>
          </thead>
          <tbody>
            {order.lines.map((line) => (
              <tr key={line.lineId} className="border-t border-border">
                <td className="p-1 text-text">{line.description}</td>
                <td className="p-1 text-right font-mono text-text-muted">{line.quantity}</td>
                <td className="p-1 text-text-muted">
                  {reference.accountsById.get(line.accountId)?.name ?? '—'}
                </td>
                <td className="p-1 text-right font-mono tabular-nums text-text">
                  {formatMoney(line.unitAmount)}
                </td>
                <td className="p-1 text-right font-mono tabular-nums text-text">
                  {formatMoney(line.grossAmount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ResponsiveTable>

      {order.memo !== null && (
        <div className="flex flex-col gap-1 rounded-lg border border-border bg-surface p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">
            Notes / Terms
          </p>
          <p className="whitespace-pre-wrap text-sm text-text">{order.memo}</p>
        </div>
      )}

      {convertDialog}
      {sendDialog}
    </section>
  );
}
