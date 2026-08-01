import type { ReactElement, ReactNode } from 'react';

import { Button, Pill, formatMoney } from '../../components';
import { cx } from '../../lib/cx';
import { isOverdue, statusPresentation } from './invoice-list';
import { PaymentHistory } from './payment-history';
import { dueDateOf } from './queries';
import type { SalesDocument, SalesDocumentKind, SalesReferenceData } from './queries';
import { vocabularyFor } from './vocabulary';

/**
 * The compact (phone-width) read-only view of an approved invoice or credit note — the AR
 * mirror of `purchases/mobile-document-view.tsx`, for the same reason that file exists.
 *
 * `document-view.tsx` renders one read-only detail for every breakpoint's *data* (nothing
 * here is fetched independently), but once a document is approved there is nothing left to
 * edit, so the phone screen is free to read like a receipt — one card per concern, largest
 * figures first — rather than a disabled form squeezed onto a narrow viewport.
 * `document-view.tsx` decides *when* to show this (the compact tier, D-120); this component
 * only renders what it is handed.
 *
 * Every figure here is copied off `document`, never recomputed (D-34, D-38): totals, tax
 * and settlement are the server's arithmetic, and a second implementation of any of them
 * risks disagreeing with it at the rounding.
 */
export interface MobileDocumentViewProps {
  readonly kind: SalesDocumentKind;
  readonly document: SalesDocument;
  readonly reference: SalesReferenceData;
  readonly asOf: string;
  readonly actions: ReactNode;
  readonly onNavigateList: () => void;
}

export function MobileDocumentView({
  kind,
  document,
  reference,
  asOf,
  actions,
  onNavigateList,
}: MobileDocumentViewProps): ReactElement {
  const words = vocabularyFor(kind);
  const contact = reference.contactsById.get(document.contactId);
  const presented = statusPresentation(document, asOf);
  const overdue = isOverdue(document, asOf);
  const settled = document.settlement.outstanding === '0';
  const dueDate = dueDateOf(document);

  // Skip whichever of the six address fields the contact has none of — the same rule the
  // customer card on desktop follows, so the two presentations cannot disagree about which
  // lines exist.
  const addressLines = [
    contact?.addressLine1 ?? null,
    contact?.addressLine2 ?? null,
    contact?.city ?? null,
    contact?.region ?? null,
    contact?.postalCode ?? null,
    contact?.country ?? null,
  ].filter((line): line is string => line !== null && line !== '');

  return (
    <section
      className="flex flex-col gap-4 pb-24"
      aria-label={kind === 'invoice' ? 'Invoice' : 'Credit note'}
    >
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">
              {words.singular}
            </p>
            <p className="font-mono text-2xl font-semibold text-text">
              #{document.documentNumber ?? '—'}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Pill tone={presented.tone}>{presented.label}</Pill>
            <Button variant="ghost" onClick={onNavigateList} aria-label="Close">
              ✕
            </Button>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-1 rounded-lg border border-border bg-surface p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">Customer</p>
        <p className="text-base font-medium text-text">
          {contact?.displayName ?? 'Unknown contact'}
        </p>
        {addressLines.map((line) => (
          <p key={line} className="text-sm text-text-subtle">
            {line}
          </p>
        ))}
      </div>

      <div className="flex items-end justify-between gap-3 rounded-lg border border-border bg-surface p-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">
            {words.outstandingLabel}
          </p>
          <p
            className={cx(
              'mt-0.5 font-mono text-xl font-semibold tabular-nums',
              settled ? 'text-success-text' : overdue ? 'text-danger-text' : 'text-text',
            )}
          >
            {formatMoney(document.settlement.outstanding)}
          </p>
          <p className="mt-0.5 text-sm text-text-muted">
            Total paid: {formatMoney(document.settlement.allocated)}
          </p>
        </div>

        <div className="text-right">
          {dueDate !== null ? (
            <>
              <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">
                Due date
              </p>
              <p className="mt-0.5 font-mono text-sm text-text">{dueDate}</p>
              {overdue ? (
                <p className="mt-0.5 text-sm font-semibold text-danger-text">Overdue</p>
              ) : (
                <p className="mt-0.5 text-sm text-text-muted">Issued: {document.issueDate}</p>
              )}
            </>
          ) : (
            <>
              <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">Issued</p>
              <p className="mt-0.5 font-mono text-sm text-text">{document.issueDate}</p>
            </>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium text-text">Line items</p>
        <ul className="flex flex-col gap-2">
          {document.lines.map((line) => (
            <li
              key={line.lineId}
              className="flex flex-col gap-1 rounded-lg border border-border bg-surface p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <p className="min-w-0 truncate font-medium text-text">{line.description}</p>
                <p className="shrink-0 font-mono text-sm tabular-nums text-text">
                  {formatMoney(line.grossAmount)}
                </p>
              </div>
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-text-muted">
                  Qty: {line.quantity} × {formatMoney(line.unitAmount)}
                </p>
                <p className="text-sm text-text-muted">
                  {reference.accountsById.get(line.accountId)?.name ?? '—'}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-col gap-1 rounded-lg border border-border bg-surface-sunken p-3">
        <div className="flex justify-between text-sm text-text-muted">
          <span>Subtotal</span>
          <span className="font-mono tabular-nums text-text">
            {formatMoney(document.totals.net)}
          </span>
        </div>
        {document.taxSummary.map((row) => (
          <div
            key={row.taxRateId ?? 'untaxed'}
            className="flex justify-between text-sm text-text-muted"
          >
            <span>
              {row.taxRateName ?? 'Untaxed'}
              {row.percentage === null ? '' : ` (${row.percentage}%)`}
            </span>
            <span className="font-mono tabular-nums text-text">{formatMoney(row.tax)}</span>
          </div>
        ))}
        <div className="flex justify-between text-sm text-text-muted">
          <span>Tax</span>
          <span className="font-mono tabular-nums text-text">
            {formatMoney(document.totals.tax)}
          </span>
        </div>
        <div className="flex justify-between border-t border-border pt-1 text-sm font-semibold text-text">
          <span>Total</span>
          <span className="font-mono tabular-nums">{formatMoney(document.totals.gross)}</span>
        </div>
      </div>

      {document.memo !== null && document.memo !== '' && (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">
            Notes / Terms
          </p>
          <p className="whitespace-pre-wrap rounded-md bg-accent-soft p-3 text-sm italic text-text">
            {document.memo}
          </p>
        </div>
      )}

      <PaymentHistory
        kind={kind}
        allocations={document.allocations}
        settlement={document.settlement}
        totalGross={document.totals.gross}
      />

      <div className="no-print fixed inset-x-0 bottom-0 z-10 flex items-center justify-end gap-2 border-t border-border bg-surface p-3">
        {actions}
      </div>
    </section>
  );
}
