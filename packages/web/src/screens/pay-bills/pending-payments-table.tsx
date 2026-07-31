import type { ReactElement } from 'react';

import { Button, ResponsiveTable, Select, formatMinorUnits } from '../../components';
import { cx } from '../../lib/cx';
import { useIsCompact } from '../../lib/use-viewport';
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

const STATUS_LABEL: Readonly<Record<PendingPayment['status'], string>> = {
  open: 'Open',
  issued: 'Issued',
  cancelled: 'Cancelled',
};

/**
 * The pending-payment queue (OB-116; ROADMAP D-64, D-65, D-68, D-110).
 *
 * Rail is edited in place — `PATCH { rail }`, never a dedicated route, the same shape
 * `recurring-invoices.tsx` describes for pause/resume — and only while `status === 'open'`:
 * an issued payment's rail is what actually moved the money and is never rewritten after the
 * fact, and a cancelled one has nothing left to route.
 *
 * Below `md` this is a stack of cards (D-123's polish tier) rather than the grid — the same
 * props, `STATUS_TONE`/`STATUS_LABEL`/`RAIL_OPTIONS` and Issue/Cancel handlers, so the two
 * presentations cannot disagree about what one queued payment can do.
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

export function PendingPaymentsTable(props: PendingPaymentsTableProps): ReactElement {
  const isCompact = useIsCompact();

  if (isCompact) {
    return <PendingPaymentCards {...props} />;
  }

  const {
    payments,
    loading,
    selectedIds,
    railPendingId,
    disabled,
    onToggleSelect,
    onChangeRail,
    onIssue,
    onCancel,
  } = props;

  return (
    <ResponsiveTable>
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
                  <Pill tone={STATUS_TONE[payment.status]}>{STATUS_LABEL[payment.status]}</Pill>
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
    </ResponsiveTable>
  );
}

function PendingPaymentCards({
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
  if (payments.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-surface p-4 text-center text-text-muted">
        {loading ? 'Loading…' : 'Nothing is queued.'}
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-3" aria-label="Pending payments">
      {payments.map((payment) => {
        const open = payment.status === 'open';

        return (
          <li
            key={payment.id}
            className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-3"
          >
            <div className="flex items-start justify-between gap-3">
              {open ? (
                <label className="flex min-h-[44px] items-center gap-3">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(payment.id)}
                    disabled={disabled}
                    aria-label={`Select the payment to ${payment.vendorName}`}
                    className="size-4 shrink-0 rounded-sm border border-border accent-accent"
                    onChange={() => {
                      onToggleSelect(payment);
                    }}
                  />
                  <span className="font-medium text-text">{payment.vendorName}</span>
                </label>
              ) : (
                <span className="flex min-h-[44px] items-center font-medium text-text">
                  {payment.vendorName}
                </span>
              )}
              <Pill tone={STATUS_TONE[payment.status]}>{STATUS_LABEL[payment.status]}</Pill>
            </div>

            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
              <div className="col-span-2">
                <dt className="text-xs text-text-subtle">Memo</dt>
                <dd className="text-text-muted">{payment.memo ?? '—'}</dd>
              </div>
              <div>
                <dt className="text-xs text-text-subtle">Amount</dt>
                <dd className="font-mono tabular-nums text-text">
                  {formatMinorUnits(payment.totalAmount)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-text-subtle">Rail</dt>
                <dd>
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
                    <span className="capitalize text-text">{payment.rail}</span>
                  )}
                </dd>
              </div>
            </dl>

            {open && (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  className="min-h-[44px] flex-1"
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
                  className="min-h-[44px] flex-1"
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
          </li>
        );
      })}
    </ul>
  );
}
