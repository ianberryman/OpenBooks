import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';

import { Pill, ResponsiveTable, formatMoney } from '../../components';
import { cx } from '../../lib/cx';
import { useIsCompact } from '../../lib/use-viewport';
import type { DocumentKind } from './ap-document';
import type { Allocation, DocumentSettlement } from './queries';

/**
 * The settlement summary and applied-allocations list for an approved AP document.
 *
 * Everything here is read, never computed: `settlement` arrives from the server (D-34,
 * D-38) the same as `document-list.tsx`'s outstanding column does, and each allocation's
 * `amount` is copied straight from the wire. There is no second sum anywhere in this file —
 * a component that added the rows itself would be a second implementation of `allocated`
 * that could disagree with it at the rounding.
 *
 * This replaces the minimal list `document-editor.tsx` renders inline (a number and a date
 * per row): the totals bar and per-row labels are new, the data is the same
 * `allocations`/`settlement` the editor already reads off the saved document.
 */
export interface PaymentHistoryProps {
  readonly kind: DocumentKind;
  readonly allocations: readonly Allocation[];
  readonly settlement: DocumentSettlement;
  readonly totalGross: string;
  /**
   * D-68's reservation, not an allocation: an open, not-yet-issued Pay Bills intent
   * commits this much against the document without having settled anything yet.
   * Undefined (or `'0'`) renders nothing — most documents have none.
   */
  readonly pendingCommitted?: string;
}

export function PaymentHistory({
  kind,
  allocations,
  settlement,
  totalGross,
  pendingCommitted,
}: PaymentHistoryProps): ReactElement {
  const isCompact = useIsCompact();
  // A vendor credit settles bills rather than being settled itself (D-39); "Applied"
  // reads correctly either way, where "Payment history" implies money arriving.
  const heading = kind === 'vendor_credit' ? 'Applied' : 'Payment history';
  // A reservation, not an allocation: an open Pay Bills intent shows as its own row marked
  // "Pending" so it reads as money on its way out, distinct from what has actually settled.
  const pending =
    pendingCommitted !== undefined && pendingCommitted !== '0' ? pendingCommitted : null;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-3">
      <p className="text-sm font-medium text-text">{heading}</p>

      <div className="flex flex-wrap gap-4 rounded-md bg-surface-sunken p-3">
        <SummaryFigure label="Total amount" value={totalGross} />
        <SummaryFigure
          label="Applied"
          value={settlement.allocated}
          tone={settlement.allocated === '0' ? 'neutral' : 'success'}
        />
        <SummaryFigure
          label={kind === 'vendor_credit' ? 'Credit still available' : 'Still owed'}
          value={settlement.outstanding}
        />
      </div>

      {pending === null && allocations.length === 0 ? (
        <p className="text-sm text-text-muted">Nothing has been applied yet.</p>
      ) : isCompact ? (
        <ul className="flex flex-col gap-2">
          {pending !== null && (
            <li>
              {/* Links to the disbursements page: the payment is already built and only needs
                  issuing (D-68), which is where that happens. */}
              <Link
                to="/disbursements"
                className="flex items-center justify-between gap-3 rounded-md border border-dashed border-border p-3 hover:bg-surface-hover"
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm text-text">
                    Payment <Pill tone="neutral">Pending</Pill>
                  </p>
                  <p className="truncate text-xs text-text-subtle">
                    Queued — issue in disbursements
                  </p>
                </div>
                <p className="shrink-0 font-mono text-sm tabular-nums text-text-muted">
                  {formatMoney(pending)}
                </p>
              </Link>
            </li>
          )}
          {allocations.map((allocation) => (
            <AllocationCard key={allocation.id} allocation={allocation} />
          ))}
        </ul>
      ) : (
        <ResponsiveTable>
          <table className="w-full border-collapse">
            <caption className="sr-only">Amounts applied</caption>
            <thead>
              <tr className="text-left text-xs text-text-subtle">
                <th scope="col" className="p-2 font-medium">
                  Applied
                </th>
                <th scope="col" className="p-2 font-medium">
                  Reference
                </th>
                <th scope="col" className="p-2 font-medium">
                  Date
                </th>
                <th scope="col" className="p-2 text-right font-medium">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {pending !== null && (
                <tr className="border-t border-dashed border-border">
                  <td className="p-2 text-sm">
                    {/* Links to disbursements — the payment is built and only needs issuing (D-68). */}
                    <Link
                      to="/disbursements"
                      className="inline-flex items-center gap-2 text-accent underline-offset-2 hover:underline"
                    >
                      Payment <Pill tone="neutral">Pending</Pill>
                    </Link>
                  </td>
                  <td className="p-2 font-mono text-sm text-text-subtle">—</td>
                  <td className="p-2 text-sm text-text-subtle">Issue in disbursements</td>
                  <td className="p-2 text-right font-mono text-sm tabular-nums text-text-muted">
                    {formatMoney(pending)}
                  </td>
                </tr>
              )}
              {allocations.map((allocation) => (
                <tr key={allocation.id} className="border-t border-border">
                  <td className="p-2 text-sm text-text">{labelFor(allocation.sourceType)}</td>
                  <td className="p-2 font-mono text-sm text-text-muted">
                    {referenceFor(allocation)}
                  </td>
                  <td className="p-2 font-mono text-sm text-text-muted">{allocation.date}</td>
                  <td className="p-2 text-right font-mono text-sm tabular-nums text-text">
                    {formatMoney(allocation.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ResponsiveTable>
      )}
    </div>
  );
}

const TONE = {
  neutral: 'text-text',
  success: 'text-success-text',
} as const;

function SummaryFigure({
  label,
  value,
  tone = 'neutral',
}: {
  readonly label: string;
  readonly value: string;
  readonly tone?: keyof typeof TONE;
}): ReactElement {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">{label}</p>
      <p className={cx('mt-0.5 font-mono text-base font-semibold tabular-nums', TONE[tone])}>
        {formatMoney(value)}
      </p>
    </div>
  );
}

function AllocationCard({ allocation }: { readonly allocation: Allocation }): ReactElement {
  return (
    <li className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
      <div className="min-w-0">
        <p className="truncate text-sm text-text">{labelFor(allocation.sourceType)}</p>
        <p className="truncate font-mono text-xs text-text-subtle">
          {referenceFor(allocation)} · {allocation.date}
        </p>
      </div>
      <p className="shrink-0 font-mono text-sm tabular-nums text-text">
        {formatMoney(allocation.amount)}
      </p>
    </li>
  );
}

/**
 * What settled the document, in plain words. `sourceType` is the wire enum
 * (`ALLOCATION_SOURCE_TYPES` in `@openbooks/shared-types`); the default branch exists for
 * a future source type this component has not been told about, not for any value the API
 * sends today.
 */
function labelFor(sourceType: Allocation['sourceType']): string {
  switch (sourceType) {
    case 'payment':
      return 'Payment applied';
    case 'credit_note':
    case 'vendor_credit':
      return 'Credit applied';
    case 'discount':
      return 'Discount taken';
    default:
      return 'Applied';
  }
}

/**
 * A payment carries no number of its own (D-36 numbers only the four document types), so
 * `sourceNumber` is null and this falls back to the target's number, then to the label
 * alone. A credit's own number is prefixed `#` — the same convention `document-list.tsx`
 * uses for "our number" — a payment reference is not a document number and gets none.
 */
function referenceFor(allocation: Allocation): string {
  if (allocation.sourceNumber !== null) return `#${allocation.sourceNumber}`;
  if (allocation.targetNumber !== null) return `#${allocation.targetNumber}`;
  return labelFor(allocation.sourceType);
}
