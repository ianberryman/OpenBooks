import type { ReactElement } from 'react';

import { Pill, ResponsiveTable, formatMoney } from '../../components';
import { cx } from '../../lib/cx';
import { useIsCompact } from '../../lib/use-viewport';
import { isExpired, statusPresentation } from './estimate-presentation';
import type { EstimateReferenceData, EstimateSummary } from './queries';
import { PLURAL } from './vocabulary';

/**
 * A page of estimates (estimates redesign, AGENT E-EDITOR) — the AR-quote mirror of
 * `sales/document-list.tsx`, adapted to a non-posting document.
 *
 * ## No settlement column, because nothing here is ever settled
 *
 * An invoice's list carries a still-owed figure because payments apply against it; an
 * estimate posts no journal and takes no payment (D-M3), so there is nothing analogous to
 * show. The desktop table's last column is simply the total, and the compact card's
 * two-up footer is Expiry/Total rather than Due/Outstanding.
 *
 * ## Expiry, not a due date, is the date that turns red
 *
 * `expiryDate` is informational only — nothing enforces it — so the column reddens only
 * when `isExpired` says the estimate has actually lapsed (approved, unconverted, past its
 * date). A draft's expiry date never reddens, because `isExpired` itself refuses anything
 * but `approved` — the same one-definition-of-red split `sales/invoice-list.ts`'s
 * `isOverdue` makes for invoices.
 *
 * ## Actions moved off this row
 *
 * The dialog-based shape this replaced (`EstimateFormDialog`, opened from a row) carried
 * five callbacks per row — edit, approve, convert, send, discard. Now a row does exactly
 * one thing, `onOpen`, and every action lives on the page it routes to (the editor for a
 * draft, the detail view otherwise) — the same split `sales/document-list.tsx` made when
 * its own per-row dialog became a page.
 */
export interface EstimateListProps {
  readonly estimates: readonly EstimateSummary[];
  readonly reference: EstimateReferenceData;
  /** The date `isExpired`/`statusPresentation` measure against — today, echoed from the summary. */
  readonly asOf: string;
  readonly truncated: boolean;
  readonly onOpen: (estimateId: string) => void;
}

export function EstimateList({
  estimates,
  reference,
  asOf,
  truncated,
  onOpen,
}: EstimateListProps): ReactElement {
  const isCompact = useIsCompact();

  if (estimates.length === 0) {
    return (
      <p className="text-text-muted">
        No estimates yet. "New estimate" starts a draft — nothing is sent or converted until you say
        so.
      </p>
    );
  }

  function customerName(estimate: EstimateSummary): string {
    return reference.contactsById.get(estimate.contactId)?.displayName ?? 'Unknown contact';
  }

  return (
    <div className="flex flex-col gap-2">
      {isCompact ? (
        <ul className="flex flex-col gap-3" aria-label={PLURAL}>
          {estimates.map((estimate) => (
            <EstimateCard
              key={estimate.id}
              estimate={estimate}
              customerName={customerName(estimate)}
              asOf={asOf}
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
                  Customer
                </th>
                <th scope="col" className="p-2 font-medium">
                  Expiry
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
              {estimates.map((estimate, index) => {
                const status = statusPresentation(estimate, asOf);
                const expired = isExpired(estimate, asOf);
                return (
                  <tr key={estimate.id} className="border-t border-border hover:bg-surface-hover">
                    <td className="p-2 font-mono text-text-muted">{index + 1}</td>
                    <td className="p-2">
                      <button
                        type="button"
                        onClick={() => {
                          onOpen(estimate.id);
                        }}
                        className="rounded-sm font-mono text-text underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
                      >
                        {estimate.documentNumber ?? 'Draft'}
                      </button>
                    </td>
                    <td className="p-2 text-text">{customerName(estimate)}</td>
                    <td
                      className={cx('p-2 font-mono text-text-muted', expired && 'text-danger-text')}
                    >
                      {estimate.expiryDate ?? '—'}
                    </td>
                    <td className="p-2">
                      <Pill tone={status.tone}>{status.label}</Pill>
                    </td>
                    <td className="p-2 text-right font-mono tabular-nums text-text">
                      {formatMoney(estimate.totals.gross)}
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
          Showing the first page. Narrow the filter — by customer, by status, or by number — to
          reach the rest.
        </p>
      )}
    </div>
  );
}

/**
 * One estimate as a card, for the compact tier — mirrors `sales/document-list.tsx`'s
 * `DocumentCard`, minus the settled/owing switch its footer makes: an estimate settles
 * nothing, so the footer here is always Expiry on the left and Total on the right.
 */
function EstimateCard({
  estimate,
  customerName,
  asOf,
  onOpen,
}: {
  readonly estimate: EstimateSummary;
  readonly customerName: string;
  readonly asOf: string;
  readonly onOpen: (estimateId: string) => void;
}): ReactElement {
  const status = statusPresentation(estimate, asOf);
  const expired = isExpired(estimate, asOf);
  const subline = estimate.documentNumber === null ? 'Draft' : `#${estimate.documentNumber}`;

  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(estimate.id)}
        className="flex w-full flex-col gap-3 rounded-lg border border-border bg-surface p-4 text-left hover:bg-surface-hover"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-lg font-semibold text-text">{customerName}</p>
            <p className="truncate font-mono text-sm text-text-subtle">{subline}</p>
          </div>
          <div className="flex flex-shrink-0 flex-wrap items-center justify-end gap-1">
            <Pill tone={status.tone}>{status.label}</Pill>
          </div>
        </div>

        <div className="flex items-end justify-between gap-3 border-t border-border pt-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">Expiry</p>
            <p className={cx('mt-0.5 font-mono text-sm text-text', expired && 'text-danger-text')}>
              {estimate.expiryDate ?? '—'}
            </p>
          </div>
          <div className="text-right">
            <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">Total</p>
            <p className="mt-0.5 font-mono text-base font-semibold tabular-nums text-text">
              {formatMoney(estimate.totals.gross)}
            </p>
          </div>
        </div>
      </button>
    </li>
  );
}
