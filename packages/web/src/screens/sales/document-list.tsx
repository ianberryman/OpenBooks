import type { ReactElement } from 'react';

import { Pill, ResponsiveTable, formatMoney } from '../../components';
import { cx } from '../../lib/cx';
import { useIsCompact } from '../../lib/use-viewport';
import { isOverdue, statusPresentation } from './invoice-list';
import { dueDateOf } from './queries';
import type { SalesDocumentKind, SalesDocumentSummary, SalesReferenceData } from './queries';
import { vocabularyFor } from './vocabulary';

/**
 * A page of invoices or credit notes (OB-069 UI redesign, the AR mirror of
 * `purchases/document-list.tsx`).
 *
 * ## `status` and `outstanding` are read, never derived
 *
 * Both are on every summary and neither is a column: the status comes from the journals
 * and the allocations, and what is outstanding is the total minus the allocations applied
 * — computed by the server on read (D-34, D-38). A list that summed allocations itself
 * would be a second definition of outstanding, which is the divergence spec §11's
 * subledger-agreement invariant exists to catch. The one thing derived here is the
 * **overdue** presentation — a date comparison against `asOf`, not a money figure — which
 * `statusPresentation` and `isOverdue` draw the same way the summary's `totalOverdue` does.
 *
 * ## The number column is empty for drafts, and that is the design
 *
 * A draft holds no number, because one reserved by a draft that was then discarded would
 * leave a gap — and a gap in a document series is indistinguishable from a deleted
 * document (D-36). So the column says "Draft" rather than showing a provisional number
 * that might never be issued.
 *
 * Below `md` this renders as a stack of cards instead of the table (D-123's compact tier),
 * with the amount labelled "Total amount" once nothing is owed and the outstanding label
 * otherwise — the same switch the desktop still-owed column makes.
 */
export interface DocumentListProps {
  readonly documents: readonly SalesDocumentSummary[];
  readonly kind: SalesDocumentKind;
  readonly reference: SalesReferenceData;
  /** The date the overdue pill is measured against — today, echoed from the summary. */
  readonly asOf: string;
  readonly truncated: boolean;
  readonly onOpen: (documentId: string) => void;
}

export function DocumentList({
  documents,
  kind,
  reference,
  asOf,
  truncated,
  onOpen,
}: DocumentListProps): ReactElement {
  const words = vocabularyFor(kind);
  const isCompact = useIsCompact();

  if (documents.length === 0) {
    return <p className="text-text-muted">{words.emptyList}</p>;
  }

  function customerName(document: SalesDocumentSummary): string {
    return reference.contactsById.get(document.contactId)?.displayName ?? 'Unknown contact';
  }

  return (
    <div className="flex flex-col gap-2">
      {isCompact ? (
        <ul className="flex flex-col gap-3" aria-label={words.plural}>
          {documents.map((document) => (
            <DocumentCard
              key={document.id}
              kind={kind}
              document={document}
              customerName={customerName(document)}
              asOf={asOf}
              onOpen={onOpen}
            />
          ))}
        </ul>
      ) : (
        <ResponsiveTable>
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">{words.plural}</caption>
            <thead>
              <tr className="text-left text-xs text-text-subtle">
                <th scope="col" className="p-2 font-medium">
                  #
                </th>
                <th scope="col" className="p-2 font-medium">
                  {words.numberLabel}
                </th>
                <th scope="col" className="p-2 font-medium">
                  Customer
                </th>
                {kind === 'invoice' && (
                  <th scope="col" className="p-2 font-medium">
                    Due
                  </th>
                )}
                <th scope="col" className="p-2 font-medium">
                  Status
                </th>
                <th scope="col" className="p-2 text-right font-medium">
                  Total
                </th>
                <th scope="col" className="p-2 text-right font-medium">
                  {words.outstandingLabel}
                </th>
              </tr>
            </thead>
            <tbody>
              {documents.map((document, index) => {
                const status = statusPresentation(document, asOf);
                const overdue = isOverdue(document, asOf);
                return (
                  <tr key={document.id} className="border-t border-border hover:bg-surface-hover">
                    <td className="p-2 font-mono text-text-muted">{index + 1}</td>
                    <td className="p-2">
                      <button
                        type="button"
                        onClick={() => {
                          onOpen(document.id);
                        }}
                        className="rounded-sm font-mono text-text underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
                      >
                        {document.documentNumber ?? 'Draft'}
                      </button>
                    </td>
                    <td className="p-2 text-text">{customerName(document)}</td>
                    {kind === 'invoice' && (
                      <td
                        className={cx(
                          'p-2 font-mono text-text-muted',
                          overdue && 'text-danger-text',
                        )}
                      >
                        {dueDateOf(document) ?? '—'}
                      </td>
                    )}
                    <td className="p-2">
                      <Pill tone={status.tone}>{status.label}</Pill>
                    </td>
                    <td className="p-2 text-right font-mono tabular-nums text-text">
                      {formatMoney(document.totals.gross)}
                    </td>
                    <td
                      className={cx(
                        'p-2 text-right font-mono tabular-nums text-text',
                        overdue && 'text-danger-text',
                      )}
                    >
                      {/* A draft has settled nothing and is settled by nothing — it is not
                          in the ledger — so the column is blank rather than a zero that
                          would read as "fully paid". */}
                      {document.status === 'draft'
                        ? '—'
                        : formatMoney(document.settlement.outstanding)}
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
          Showing the first page. Narrow the filter — by customer, by status, or by invoice number —
          to reach the rest.
        </p>
      )}
    </div>
  );
}

/**
 * One invoice or credit note as a card, for the compact tier.
 *
 * The whole card is the open control, so a tap anywhere on it does what a click on the
 * number does in the table. Both labels switch on whether anything is still owed: while a
 * balance remains the left block shows the due date and the right block what is left to
 * collect; once nothing is owed the left block shows when it was issued and the right
 * block the document's total, in `text-success-text` to read as settled.
 */
function DocumentCard({
  kind,
  document,
  customerName,
  asOf,
  onOpen,
}: {
  readonly kind: SalesDocumentKind;
  readonly document: SalesDocumentSummary;
  readonly customerName: string;
  readonly asOf: string;
  readonly onOpen: (documentId: string) => void;
}): ReactElement {
  const words = vocabularyFor(kind);
  const status = statusPresentation(document, asOf);
  const overdue = isOverdue(document, asOf);
  const settled = document.settlement.outstanding === '0';
  const owing = !settled;
  const subline = document.documentNumber === null ? 'Draft' : `#${document.documentNumber}`;

  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(document.id)}
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
            <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">
              {owing ? 'Due date' : 'Issued'}
            </p>
            <p className={cx('mt-0.5 font-mono text-sm text-text', overdue && 'text-danger-text')}>
              {owing ? (dueDateOf(document) ?? '—') : document.issueDate}
            </p>
          </div>
          <div className="text-right">
            <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">
              {settled ? 'Total amount' : words.outstandingLabel}
            </p>
            <p
              className={cx(
                'mt-0.5 font-mono text-base font-semibold tabular-nums',
                overdue ? 'text-danger-text' : settled ? 'text-success-text' : 'text-text',
              )}
            >
              {formatMoney(settled ? document.totals.gross : document.settlement.outstanding)}
            </p>
          </div>
        </div>
      </button>
    </li>
  );
}
