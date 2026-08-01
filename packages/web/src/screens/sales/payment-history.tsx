import type { ReactElement } from 'react';

import { Button, ResponsiveTable, formatMoney } from '../../components';
import { cx } from '../../lib/cx';
import { useIsCompact } from '../../lib/use-viewport';
import type { Allocation, DocumentSettlement, SalesDocumentKind } from './queries';
import { vocabularyFor } from './vocabulary';

/**
 * The settlement summary and applied-allocations list for an approved AR document — the AR
 * mirror of `purchases/payment-history.tsx`, minus that file's `pendingCommitted` prop and
 * its two "Pending" pseudo-rows: those exist only because an open Pay Bills intent commits
 * money against a bill before it settles anything (D-68), and there is no AR analog to a
 * disbursement queue.
 *
 * Everything here is read, never computed: `settlement` arrives from the server (D-34,
 * D-38) the same as `document-list.tsx`'s outstanding column does, and each allocation's
 * `amount` is copied straight from the wire. There is no second sum anywhere in this file.
 */
export interface PaymentHistoryProps {
  readonly kind: SalesDocumentKind;
  readonly allocations: readonly Allocation[];
  readonly settlement: DocumentSettlement;
  readonly totalGross: string;
  /**
   * Present only where un-applying is this screen's job (the full detail, not the compact
   * receipt view) — see `allocations-panel.tsx` for why the operation lives on the document
   * itself rather than only on a payments screen.
   */
  readonly onUnapply?: (allocation: Allocation) => void;
  readonly disabled?: boolean;
}

export function PaymentHistory({
  kind,
  allocations,
  settlement,
  totalGross,
  onUnapply,
  disabled = false,
}: PaymentHistoryProps): ReactElement {
  const isCompact = useIsCompact();
  const vocabulary = vocabularyFor(kind);
  // A credit note settles invoices rather than being settled itself (D-39); "Applied" reads
  // correctly either way, where "Payment history" implies money arriving.
  const heading = kind === 'credit_note' ? 'Applied' : 'Payment history';
  const emptyNote =
    kind === 'credit_note'
      ? 'None of this credit has been applied yet.'
      : 'No payments recorded for this invoice.';
  const showUnapply = onUnapply !== undefined;

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
        <SummaryFigure label={vocabulary.outstandingLabel} value={settlement.outstanding} />
      </div>

      {allocations.length === 0 ? (
        <p className="text-sm text-text-muted">{emptyNote}</p>
      ) : isCompact ? (
        <ul className="flex flex-col gap-2">
          {allocations.map((allocation) => (
            <AllocationCard
              key={allocation.id}
              allocation={allocation}
              onUnapply={showUnapply ? onUnapply : undefined}
              disabled={disabled}
            />
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
                {showUnapply && (
                  <th scope="col" className="p-2 font-medium">
                    <span className="sr-only">Un-apply</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {allocations.map((allocation) => (
                <tr key={allocation.id} className="border-t border-border">
                  <td className="p-2 text-sm text-text">{labelFor(allocation.sourceType)}</td>
                  <td className="p-2 font-mono text-sm text-text-muted">
                    {referenceFor(allocation)}
                  </td>
                  <td className="p-2 font-mono text-sm text-text-muted">{allocation.date}</td>
                  <td className="p-2 text-right font-mono text-sm tabular-nums text-success-text">
                    +{formatMoney(allocation.amount)}
                  </td>
                  {showUnapply && (
                    <td className="p-2 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={disabled}
                        onClick={() => {
                          onUnapply(allocation);
                        }}
                      >
                        Un-apply
                      </Button>
                    </td>
                  )}
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

function AllocationCard({
  allocation,
  onUnapply,
  disabled,
}: {
  readonly allocation: Allocation;
  readonly onUnapply?: ((allocation: Allocation) => void) | undefined;
  readonly disabled: boolean;
}): ReactElement {
  return (
    <li className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
      <div className="min-w-0">
        <p className="truncate text-sm text-text">{labelFor(allocation.sourceType)}</p>
        <p className="truncate font-mono text-xs text-text-subtle">
          {referenceFor(allocation)} · {allocation.date}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <p className="font-mono text-sm tabular-nums text-success-text">
          +{formatMoney(allocation.amount)}
        </p>
        {onUnapply !== undefined && (
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => {
              onUnapply(allocation);
            }}
          >
            Un-apply
          </Button>
        )}
      </div>
    </li>
  );
}

/**
 * What settled the document, in plain words. `sourceType` is the wire enum
 * (`ALLOCATION_SOURCE_TYPES` in `@openbooks/shared-types`) shared with AP; `vendor_credit`
 * cannot reach an AR document but is handled here rather than left to fall through, since
 * the type is the same enum across both ledgers. Matches `allocations-panel.tsx`'s
 * `SOURCE_LABELS`, phrased as a settlement event rather than a document name.
 */
function labelFor(sourceType: Allocation['sourceType']): string {
  switch (sourceType) {
    case 'payment':
      return 'Payment received';
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
 * alone.
 */
function referenceFor(allocation: Allocation): string {
  if (allocation.sourceNumber !== null) return `#${allocation.sourceNumber}`;
  if (allocation.targetNumber !== null) return `#${allocation.targetNumber}`;
  return labelFor(allocation.sourceType);
}
