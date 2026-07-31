import type { ReactElement, ReactNode } from 'react';

import { Button, Pill, formatMoney } from '../../components';
import type { PillTone } from '../../components';
import { cx } from '../../lib/cx';
import { STATUS_LABELS, vocabularyFor } from './ap-document';
import type { ApDocument, DocumentKind } from './ap-document';
import { PaymentHistory } from './payment-history';

/**
 * The compact (phone-width) read-only view of an approved bill or vendor credit.
 *
 * `document-editor.tsx` renders one editor for both draft and read-only documents, on
 * every breakpoint (form fields disabled, a table below `md` becoming stacked cards). This
 * is a **separate** presentation for the read-only state on a phone: once a document is
 * approved there is nothing left to edit, so the phone screen is free to read like a
 * receipt — one card per concern, largest figures first — rather than a disabled form.
 * `document-editor.tsx` decides *when* to show this (status !== draft, compact viewport);
 * this component only renders what it is handed.
 *
 * Every figure here is copied off `document`, never recomputed — the same rule the editor
 * follows and for the same reason (D-34, D-35): totals, tax and settlement are the
 * server's arithmetic, and a second implementation of any of them risks disagreeing with it
 * at the rounding.
 */
export interface MobileDocumentViewProps {
  readonly kind: DocumentKind;
  readonly document: ApDocument;
  readonly vendorName: string;
  readonly vendorLocation: string;
  readonly pastDue: boolean;
  readonly actions: ReactNode;
  readonly onBack: () => void;
}

const STATUS_TONE: Readonly<Record<ApDocument['status'], PillTone>> = {
  draft: 'muted',
  approved: 'neutral',
  part_paid: 'neutral',
  paid: 'positive',
  void: 'muted',
};

export function MobileDocumentView({
  kind,
  document,
  vendorName,
  vendorLocation,
  pastDue,
  actions,
  onBack,
}: MobileDocumentViewProps): ReactElement {
  const vocabulary = vocabularyFor(kind);
  const referenceLabel = kind === 'bill' ? 'Bill reference' : 'Credit reference';
  const settled = document.settlement.outstanding === '0';

  return (
    <section
      className="flex flex-col gap-4 pb-24"
      aria-label={kind === 'bill' ? 'Bill' : 'Vendor credit'}
    >
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">
              {referenceLabel}
            </p>
            <p className="font-mono text-2xl font-semibold text-text">
              #{document.documentNumber ?? '—'}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Pill tone={STATUS_TONE[document.status]}>{STATUS_LABELS[document.status]}</Pill>
            <Button variant="ghost" onClick={onBack} aria-label="Close">
              ✕
            </Button>
          </div>
        </div>

        <div>
          <p className="text-base font-medium text-text">{vendorName}</p>
          {vendorLocation !== '' && <p className="text-sm text-text-subtle">{vendorLocation}</p>}
        </div>

        {document.committed !== '0' && (
          <div>
            <Pill tone="neutral">Payment pending</Pill>
          </div>
        )}

        {pastDue && document.dueDate !== null && (
          <p className="text-sm font-semibold text-danger-text">Past due: {document.dueDate}</p>
        )}
      </div>

      <div className="flex items-end justify-between gap-3 rounded-lg border border-border bg-surface p-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">
            {vocabulary.outstandingLabel}
          </p>
          <p
            className={cx(
              'mt-0.5 font-mono text-xl font-semibold tabular-nums',
              settled ? 'text-success-text' : 'text-text',
            )}
          >
            {formatMoney(document.settlement.outstanding)}
          </p>
          <p className="mt-0.5 text-sm text-text-muted">
            Total paid: {formatMoney(document.settlement.allocated)}
          </p>
        </div>

        <div className="text-right">
          {kind === 'bill' ? (
            <>
              <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">
                Due date
              </p>
              <p className="mt-0.5 font-mono text-sm text-text">{document.dueDate ?? '—'}</p>
              <p className="mt-0.5 text-sm text-text-muted">Issued: {document.issueDate}</p>
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
                <Pill tone="neutral">
                  {line.taxRatePercentage === null ? 'No tax' : `${line.taxRatePercentage}% tax`}
                </Pill>
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
        pendingCommitted={document.committed}
      />

      <div className="no-print fixed inset-x-0 bottom-0 z-10 flex items-center justify-end gap-2 border-t border-border bg-surface p-3">
        {actions}
      </div>
    </section>
  );
}
