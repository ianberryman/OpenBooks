import type { ReactElement } from 'react';

import { ResponsiveTable, formatMinorUnits } from '../../components';
import { STATUS_LABELS, vocabularyFor } from './ap-document';
import type { ApDocumentSummary, DocumentKind } from './ap-document';
import type { ReferenceData } from './queries';

/**
 * A page of bills or vendor credits.
 *
 * The bill list carries **two** number columns and they are labelled by owner, because
 * they are two different numbers doing two different jobs (D-36): "Our number" is the
 * gapless per-org sequence, assigned at approval and blank before it, and "Vendor's
 * number" is what the supplier printed and will quote when chasing. A single column
 * called "Reference" would make the pair indistinguishable at a glance, which is the
 * confusion the whole D-36 argument is about.
 *
 * `status` and `outstanding` are read, never computed. Both are derived on the server from
 * the journal columns and the allocations (D-34, D-38); a list that summed allocations
 * itself would be the second source of truth those decisions exist to refuse.
 */
export interface DocumentListProps {
  readonly kind: DocumentKind;
  readonly items: readonly ApDocumentSummary[];
  readonly reference: ReferenceData;
  readonly truncated: boolean;
  readonly onOpen: (documentId: string) => void;
}

export function DocumentList({
  kind,
  items,
  reference,
  truncated,
  onOpen,
}: DocumentListProps): ReactElement {
  const vocabulary = vocabularyFor(kind);

  if (items.length === 0) {
    return (
      <p className="text-text-muted">
        No {vocabulary.plural.toLowerCase()} match this filter. A new one starts as a draft and
        reaches the ledger only when it is approved.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <ResponsiveTable>
        <table className="w-full border-collapse">
          <caption className="sr-only">{vocabulary.plural}</caption>
          <thead>
            <tr className="text-left text-xs text-text-subtle">
              <th scope="col" className="p-2 font-medium">
                {vocabulary.ourNumberLabel}
              </th>
              <th scope="col" className="p-2 font-medium">
                {vocabulary.referenceLabel}
              </th>
              <th scope="col" className="p-2 font-medium">
                Vendor
              </th>
              <th scope="col" className="p-2 font-medium">
                Issued
              </th>
              {kind === 'bill' && (
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
                {vocabulary.outstandingLabel}
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="border-t border-border hover:bg-surface-hover">
                <td className="p-2">
                  <button
                    type="button"
                    className="font-mono text-base text-accent underline-offset-2 hover:underline"
                    onClick={() => onOpen(item.id)}
                  >
                    {item.documentNumber ?? 'Draft'}
                  </button>
                </td>
                <td className="p-2 font-mono text-base text-text">{item.reference ?? '—'}</td>
                <td className="p-2 text-base text-text">
                  {reference.vendorsById.get(item.contactId)?.displayName ?? 'Unknown vendor'}
                </td>
                <td className="p-2 font-mono text-base text-text-muted">{item.issueDate}</td>
                {kind === 'bill' && (
                  <td className="p-2 font-mono text-base text-text-muted">{item.dueDate ?? '—'}</td>
                )}
                <td className="p-2 text-base text-text-muted">{STATUS_LABELS[item.status]}</td>
                <td className="p-2 text-right font-mono text-base tabular-nums text-text">
                  {formatMinorUnits(item.totals.gross)}
                </td>
                <td className="p-2 text-right font-mono text-base tabular-nums text-text">
                  {formatMinorUnits(item.settlement.outstanding)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ResponsiveTable>

      {truncated && (
        <p className="text-xs text-text-subtle">
          Showing the first page. Narrow the filter — by vendor, by status, or by the vendor’s own
          number — to reach the rest.
        </p>
      )}
    </div>
  );
}
