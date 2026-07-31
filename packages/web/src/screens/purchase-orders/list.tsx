import type { ReactElement } from 'react';

import { Button, ResponsiveTable, formatMinorUnits } from '../../components';
import { cx } from '../../lib/cx';
import { EmptyRow, Pill, TABLE_CLASSES, TD_CLASSES, TH_CLASSES } from '../settings/section';
import type { PurchaseOrderReferenceData, PurchaseOrderSummary } from './queries';
import { STATUS_LABELS, STATUS_TONES } from './vocabulary';

/**
 * One page of the register — `fixed-assets/list.tsx`'s shape.
 *
 * `status` is read off the response, never derived — approve, convert and discard are the
 * only paths that change it (D-M6), and each is a call back to the server, never a local
 * flip of the pill. Row actions are gated on that same field: an update is refused once a
 * purchase order is no longer `draft` (`purchase_order_approved`), so Edit and Discard
 * disappear the moment it is, rather than staying present to demonstrate the refusal.
 */
export interface PurchaseOrderListProps {
  readonly orders: readonly PurchaseOrderSummary[];
  readonly reference: PurchaseOrderReferenceData;
  readonly loading: boolean;
  readonly emptyMessage: string;
  /** The one order a row action is currently in flight for, or `null`. Disables that row's
   *  buttons without freezing every other row while one call is out. */
  readonly actionPendingId: string | null;
  readonly onEdit: (order: PurchaseOrderSummary) => void;
  readonly onApprove: (order: PurchaseOrderSummary) => void;
  readonly onConvert: (order: PurchaseOrderSummary) => void;
  readonly onSend: (order: PurchaseOrderSummary) => void;
  readonly onDiscard: (order: PurchaseOrderSummary) => void;
}

export function PurchaseOrderList({
  orders,
  reference,
  loading,
  emptyMessage,
  actionPendingId,
  onEdit,
  onApprove,
  onConvert,
  onSend,
  onDiscard,
}: PurchaseOrderListProps): ReactElement {
  return (
    <ResponsiveTable>
      <table className={TABLE_CLASSES}>
        <caption className="sr-only">Purchase orders</caption>
        <thead>
          <tr>
            <th scope="col" className={TH_CLASSES}>
              Number
            </th>
            <th scope="col" className={TH_CLASSES}>
              Vendor
            </th>
            <th scope="col" className={TH_CLASSES}>
              Issue date
            </th>
            <th scope="col" className={TH_CLASSES}>
              Status
            </th>
            <th scope="col" className={cx(TH_CLASSES, 'text-right')}>
              Total
            </th>
            <th scope="col" className={cx(TH_CLASSES, 'text-right')}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {orders.length === 0 && (
            <EmptyRow columns={6}>{loading ? 'Loading…' : emptyMessage}</EmptyRow>
          )}
          {orders.map((order) => {
            const pending = actionPendingId === order.id;
            const vendorName =
              reference.vendorsById.get(order.contactId)?.displayName ?? 'Unknown vendor';

            return (
              <tr key={order.id}>
                <td className={cx(TD_CLASSES, 'font-mono')}>{order.documentNumber ?? 'Draft'}</td>
                <td className={TD_CLASSES}>
                  {vendorName}
                  {order.reference !== null && order.reference !== '' && (
                    <span className="block text-xs text-text-subtle">Ref {order.reference}</span>
                  )}
                </td>
                <td className={cx(TD_CLASSES, 'font-mono')}>{order.issueDate}</td>
                <td className={TD_CLASSES}>
                  <Pill tone={STATUS_TONES[order.status]}>{STATUS_LABELS[order.status]}</Pill>
                </td>
                <td className={cx(TD_CLASSES, 'text-right font-mono tabular-nums')}>
                  {formatMinorUnits(order.totals.gross)}
                </td>
                <td className={cx(TD_CLASSES, 'text-right')}>
                  <div className="flex justify-end gap-1">
                    {order.status === 'draft' && (
                      <>
                        <Button
                          size="sm"
                          onClick={() => {
                            onEdit(order);
                          }}
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={pending}
                          onClick={() => {
                            onApprove(order);
                          }}
                        >
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={pending}
                          aria-label={`Discard ${order.documentNumber ?? 'this purchase order'}`}
                          onClick={() => {
                            onDiscard(order);
                          }}
                        >
                          Discard
                        </Button>
                      </>
                    )}
                    {order.status === 'approved' && (
                      <>
                        <Button
                          size="sm"
                          onClick={() => {
                            onSend(order);
                          }}
                        >
                          Send
                        </Button>
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={pending}
                          onClick={() => {
                            onConvert(order);
                          }}
                        >
                          Convert to bill
                        </Button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </ResponsiveTable>
  );
}
