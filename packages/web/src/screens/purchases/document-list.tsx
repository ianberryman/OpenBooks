import type { ReactElement } from 'react';

import { Pill, ResponsiveTable, formatMoney } from '../../components';
import { useIsCompact } from '../../lib/use-viewport';
import { statusPresentation, vocabularyFor } from './ap-document';
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
 * itself would be the second source of truth those decisions exist to refuse. The one
 * thing derived here is the **overdue** pill — a date comparison against `asOf`, not a
 * money figure — which `statusPresentation` draws the same way the summary's `totalOverdue`
 * and the aging report's `current` bucket do.
 *
 * Below `md` this renders as a stack of cards instead of the table (D-123's compact tier),
 * with the amount labelled "Total amount" once nothing is owed and "Still owed" while a
 * balance remains — the switch the mobile design turns on.
 */
export interface DocumentListProps {
  readonly kind: DocumentKind;
  readonly items: readonly ApDocumentSummary[];
  readonly reference: ReferenceData;
  /** The date the overdue pill is measured against — today, echoed from the summary. */
  readonly asOf: string;
  readonly truncated: boolean;
  readonly onOpen: (documentId: string) => void;
}

export function DocumentList({
  kind,
  items,
  reference,
  asOf,
  truncated,
  onOpen,
}: DocumentListProps): ReactElement {
  const vocabulary = vocabularyFor(kind);
  const isCompact = useIsCompact();

  if (items.length === 0) {
    return (
      <p className="text-text-muted">
        No {vocabulary.plural.toLowerCase()} match this filter. A new one starts as a draft and
        reaches the ledger only when it is approved.
      </p>
    );
  }

  function vendorName(item: ApDocumentSummary): string {
    return reference.vendorsById.get(item.contactId)?.displayName ?? 'Unknown vendor';
  }

  return (
    <div className="flex flex-col gap-2">
      {isCompact ? (
        <ul className="flex flex-col gap-3" aria-label={vocabulary.plural}>
          {items.map((item) => (
            <DocumentCard
              key={item.id}
              kind={kind}
              item={item}
              vendorName={vendorName(item)}
              asOf={asOf}
              onOpen={onOpen}
            />
          ))}
        </ul>
      ) : (
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
              {items.map((item) => {
                const status = statusPresentation(item, asOf);
                return (
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
                    <td className="p-2 text-base text-text">{vendorName(item)}</td>
                    <td className="p-2 font-mono text-base text-text-muted">{item.issueDate}</td>
                    {kind === 'bill' && (
                      <td className="p-2 font-mono text-base text-text-muted">
                        {item.dueDate ?? '—'}
                      </td>
                    )}
                    <td className="p-2">
                      <div className="flex flex-wrap items-center gap-1">
                        <Pill tone={status.tone}>{status.label}</Pill>
                        {item.committed !== '0' && <Pill tone="neutral">Payment pending</Pill>}
                      </div>
                    </td>
                    <td className="p-2 text-right font-mono text-base tabular-nums text-text">
                      {formatMoney(item.totals.gross)}
                    </td>
                    <td className="p-2 text-right font-mono text-base tabular-nums text-text">
                      {formatMoney(item.settlement.outstanding)}
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
          Showing the first page. Narrow the filter — by vendor, by status, or by the vendor’s own
          number — to reach the rest.
        </p>
      )}
    </div>
  );
}

/**
 * One bill or vendor credit as a card, for the compact tier.
 *
 * The whole card is the open control, so a tap anywhere on it does what a click on the
 * number does in the table. The amount label switches on what is left: once `outstanding`
 * is zero the card leads with the document total, and while a balance remains it leads with
 * what is still owed — the same figure the table's outstanding column shows.
 */
function DocumentCard({
  kind,
  item,
  vendorName,
  asOf,
  onOpen,
}: {
  readonly kind: DocumentKind;
  readonly item: ApDocumentSummary;
  readonly vendorName: string;
  readonly asOf: string;
  readonly onOpen: (documentId: string) => void;
}): ReactElement {
  const vocabulary = vocabularyFor(kind);
  const status = statusPresentation(item, asOf);
  const settled = item.settlement.outstanding === '0';
  const subline =
    item.reference ?? (item.documentNumber === null ? 'Draft' : `#${item.documentNumber}`);

  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(item.id)}
        className="flex w-full flex-col gap-3 rounded-lg border border-border bg-surface p-4 text-left hover:bg-surface-hover"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-lg font-semibold text-text">{vendorName}</p>
            <p className="truncate font-mono text-sm text-text-subtle">{subline}</p>
          </div>
          <div className="flex flex-shrink-0 flex-wrap items-center justify-end gap-1">
            <Pill tone={status.tone}>{status.label}</Pill>
            {item.committed !== '0' && <Pill tone="neutral">Payment pending</Pill>}
          </div>
        </div>

        <div className="flex items-end justify-between gap-3 border-t border-border pt-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">
              {kind === 'bill' ? 'Due date' : 'Issued'}
            </p>
            <p className="mt-0.5 font-mono text-sm text-text">
              {kind === 'bill' ? (item.dueDate ?? '—') : item.issueDate}
            </p>
          </div>
          <div className="text-right">
            <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">
              {settled ? 'Total amount' : vocabulary.outstandingLabel}
            </p>
            <p className="mt-0.5 font-mono text-base font-semibold tabular-nums text-text">
              {formatMoney(settled ? item.totals.gross : item.settlement.outstanding)}
            </p>
          </div>
        </div>
      </button>
    </li>
  );
}
