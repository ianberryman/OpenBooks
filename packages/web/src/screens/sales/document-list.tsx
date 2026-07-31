import type { ReactElement } from 'react';

import { ResponsiveTable, formatMinorUnits } from '../../components';
import { dueDateOf } from './queries';
import type { SalesDocumentKind, SalesDocumentSummary, SalesReferenceData } from './queries';
import { StatusBadge, vocabularyFor } from './vocabulary';

/**
 * One page of documents.
 *
 * ## `status` and `outstanding` are read, never derived
 *
 * Both are on every summary and neither is a column: the status comes from the journals
 * and the allocations, and what is outstanding is the total minus the allocations applied
 * — computed by the server on read (D-34, D-38). A list that summed allocations itself
 * would be a second definition of outstanding, which is the divergence spec §11's
 * subledger-agreement invariant exists to catch, and it would be a definition that
 * disagreed with the aging report on the same page.
 *
 * ## The number column is empty for drafts, and that is the design
 *
 * A draft holds no number, because one reserved by a draft that was then discarded would
 * leave a gap — and a gap in a document series is indistinguishable from a deleted
 * document (D-36). So the column says "Draft" rather than showing a provisional number
 * that might never be issued.
 *
 * The order is the server's `(created_at, id)` and not the document number, for the reason
 * the route gives: the number is null on exactly the rows a drafts-included list has to
 * page, and `issueDate` is editable while a document is a draft — a keyset over a mutable
 * column silently drops the rows that moved behind the cursor.
 */
export interface DocumentListProps {
  readonly documents: readonly SalesDocumentSummary[];
  readonly kind: SalesDocumentKind;
  readonly reference: SalesReferenceData;
  readonly onOpen: (documentId: string) => void;
}

export function DocumentList({
  documents,
  kind,
  reference,
  onOpen,
}: DocumentListProps): ReactElement {
  const words = vocabularyFor(kind);

  if (documents.length === 0) {
    return <p className="text-text-muted">{words.emptyList}</p>;
  }

  return (
    <ResponsiveTable>
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{words.plural}</caption>
        <thead>
          <tr className="text-left text-xs text-text-subtle">
            <th scope="col" className="p-2 font-medium">
              {words.numberLabel}
            </th>
            <th scope="col" className="p-2 font-medium">
              Customer
            </th>
            <th scope="col" className="p-2 font-medium">
              Issued
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
          {documents.map((document) => {
            const dueDate = dueDateOf(document);
            return (
              <tr key={document.id} className="border-t border-border hover:bg-surface-hover">
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
                <td className="p-2 text-text">
                  {reference.contactsById.get(document.contactId)?.displayName ?? 'Unknown contact'}
                </td>
                <td className="p-2 font-mono text-text-muted">{document.issueDate}</td>
                {kind === 'invoice' && (
                  <td className="p-2 font-mono text-text-muted">{dueDate ?? '—'}</td>
                )}
                <td className="p-2">
                  <StatusBadge status={document.status} />
                </td>
                <td className="p-2 text-right font-mono tabular-nums text-text">
                  {formatMinorUnits(document.totals.gross)}
                </td>
                <td className="p-2 text-right font-mono tabular-nums text-text">
                  {/* A draft has settled nothing and is settled by nothing — it is not in
                      the ledger — so the column is blank rather than a zero that would read
                      as "fully paid". */}
                  {document.status === 'draft'
                    ? '—'
                    : formatMinorUnits(document.settlement.outstanding)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </ResponsiveTable>
  );
}
