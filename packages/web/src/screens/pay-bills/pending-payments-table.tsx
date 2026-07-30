import type { ReactElement } from 'react';

import { Button, Select, formatMinorUnits } from '../../components';
import { cx } from '../../lib/cx';
import { EmptyRow, Pill, TABLE_CLASSES, TD_CLASSES, TH_CLASSES } from '../settings/section';
import type { PendingPayment, Rail } from './queries';

const RAIL_OPTIONS: readonly { readonly value: Rail; readonly label: string }[] = [
  { value: 'check', label: 'Check' },
  { value: 'ach', label: 'ACH' },
  { value: 'wire', label: 'Wire' },
];

const STATUS_TONE: Readonly<Record<PendingPayment['status'], 'positive' | 'muted' | 'neutral'>> = {
  open: 'neutral',
  issued: 'positive',
  cancelled: 'muted',
};

/**
 * The pending-payment queue (OB-116; ROADMAP D-64, D-65, D-68, D-110).
 *
 * Rail is edited in place — `PATCH { rail }`, never a dedicated route, the same shape
 * `recurring-invoices.tsx` describes for pause/resume — and only while `status === 'open'`:
 * an issued payment's rail is what actually moved the money and is never rewritten after the
 * fact, and a cancelled one has nothing left to route.
 */
export interface PendingPaymentsTableProps {
  readonly payments: readonly PendingPayment[];
  readonly loading: boolean;
  readonly selectedIds: ReadonlySet<string>;
  readonly railPendingId: string | null;
  readonly disabled: boolean;
  readonly onToggleSelect: (payment: PendingPayment) => void;
  readonly onChangeRail: (payment: PendingPayment, rail: Rail) => void;
  readonly onIssue: (payment: PendingPayment) => void;
  readonly onCancel: (payment: PendingPayment) => void;
}

export function PendingPaymentsTable({
  payments,
  loading,
  selectedIds,
  railPendingId,
  disabled,
  onToggleSelect,
  onChangeRail,
  onIssue,
  onCancel,
}: PendingPaymentsTableProps): ReactElement {
  return (
    <div className="overflow-x-auto">
      <table className={TABLE_CLASSES}>
        <caption className="sr-only">Pending payments</caption>
        <thead>
          <tr>
            <th scope="col" className={TH_CLASSES}>
              <span className="sr-only">Select</span>
            </th>
            <th scope="col" className={TH_CLASSES}>
              Vendor
            </th>
            <th scope="col" className={TH_CLASSES}>
              Memo
            </th>
            <th scope="col" className={cx(TH_CLASSES, 'text-right')}>
              Amount
            </th>
            <th scope="col" className={TH_CLASSES}>
              Rail
            </th>
            <th scope="col" className={TH_CLASSES}>
              Status
            </th>
            <th scope="col" className={cx(TH_CLASSES, 'text-right')}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {payments.length === 0 && (
            <EmptyRow columns={7}>{loading ? 'Loading…' : 'Nothing is queued.'}</EmptyRow>
          )}
          {payments.map((payment) => {
            const open = payment.status === 'open';
            return (
              <tr key={payment.id}>
                <td className={TD_CLASSES}>
                  {open && (
                    <input
                      type="checkbox"
                      checked={selectedIds.has(payment.id)}
                      disabled={disabled}
                      aria-label={`Select the payment to ${payment.vendorName}`}
                      className="size-4 rounded-sm border border-border accent-accent"
                      onChange={() => {
                        onToggleSelect(payment);
                      }}
                    />
                  )}
                </td>
                <td className={TD_CLASSES}>{payment.vendorName}</td>
                <td className={cx(TD_CLASSES, 'text-text-muted')}>{payment.memo ?? '—'}</td>
                <td className={cx(TD_CLASSES, 'text-right font-mono tabular-nums')}>
                  {formatMinorUnits(payment.totalAmount)}
                </td>
                <td className={cx(TD_CLASSES, 'w-32')}>
                  {open ? (
                    <Select
                      aria-label={`Rail for the payment to ${payment.vendorName}`}
                      value={payment.rail}
                      options={RAIL_OPTIONS}
                      disabled={disabled || railPendingId === payment.id}
                      onValueChange={(value) => {
                        onChangeRail(payment, value as Rail);
                      }}
                    />
                  ) : (
                    <span className="capitalize">{payment.rail}</span>
                  )}
                </td>
                <td className={TD_CLASSES}>
                  <Pill tone={STATUS_TONE[payment.status]}>
                    {payment.status === 'open'
                      ? 'Open'
                      : payment.status === 'issued'
                        ? 'Issued'
                        : 'Cancelled'}
                  </Pill>
                </td>
                <td className={cx(TD_CLASSES, 'text-right')}>
                  {open && (
                    <div className="flex justify-end gap-1">
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={disabled}
                        onClick={() => {
                          onIssue(payment);
                        }}
                      >
                        Issue
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={disabled}
                        aria-label={`Cancel the payment to ${payment.vendorName}`}
                        onClick={() => {
                          onCancel(payment);
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
