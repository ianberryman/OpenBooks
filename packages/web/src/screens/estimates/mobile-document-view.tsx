import type { ReactElement, ReactNode } from 'react';

import { Button, Pill, formatMoney } from '../../components';
import { cx } from '../../lib/cx';
import { isExpired, statusPresentation } from './estimate-presentation';
import type { Estimate, EstimateReferenceData } from './queries';

/**
 * The compact (phone-width) read-only view of an estimate — the AR mirror of
 * `sales/mobile-document-view.tsx`, minus the whole payment-history section: an estimate
 * posts no journal and settles nothing (D-M3), so there is no "still owed" figure to
 * headline and no allocation ledger to list.
 *
 * `detail-view.tsx` renders one read-only detail for every breakpoint's *data* (nothing
 * here is fetched independently) and decides *when* to show this (the compact tier,
 * D-120); this component only renders what it is handed. Every figure here is copied off
 * `estimate`, never recomputed (D-35) — totals are the server's arithmetic.
 */
export interface MobileDocumentViewProps {
  readonly estimate: Estimate;
  readonly reference: EstimateReferenceData;
  readonly asOf: string;
  readonly actions: ReactNode;
  readonly onNavigateList: () => void;
}

/** `detail-view.tsx`'s `expirySubline`, restated for the card layout here — kept as a
 *  second small copy rather than a shared import, `sales/mobile-document-view.tsx`'s own
 *  reason: the two views render this string in different-shaped markup. */
function expirySubline(estimate: Estimate, asOf: string): string {
  if (isExpired(estimate, asOf)) return 'Expired';
  if (estimate.expiryDate === asOf) return 'Expires today';
  const days = Math.round(
    (Date.parse(estimate.expiryDate ?? asOf) - Date.parse(asOf)) / 86_400_000,
  );
  return `Expires in ${String(days)} day${days === 1 ? '' : 's'}`;
}

export function MobileDocumentView({
  estimate,
  reference,
  asOf,
  actions,
  onNavigateList,
}: MobileDocumentViewProps): ReactElement {
  const contact = reference.contactsById.get(estimate.contactId);
  const presented = statusPresentation(estimate, asOf);
  const expired = isExpired(estimate, asOf);

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
    <section className="flex flex-col gap-4 pb-24" aria-label="Estimate">
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">Estimate</p>
            <p className="font-mono text-2xl font-semibold text-text">
              #{estimate.documentNumber ?? '—'}
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
          <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">Total</p>
          <p className="mt-0.5 font-mono text-xl font-semibold tabular-nums text-text">
            {formatMoney(estimate.totals.gross)}
          </p>
        </div>

        <div className="text-right">
          {estimate.expiryDate !== null ? (
            <>
              <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">
                Expiry date
              </p>
              <p className="mt-0.5 font-mono text-sm text-text">{estimate.expiryDate}</p>
              <p
                className={cx(
                  'mt-0.5 text-sm',
                  expired ? 'font-semibold text-danger-text' : 'text-text-muted',
                )}
              >
                {expirySubline(estimate, asOf)}
              </p>
            </>
          ) : (
            <>
              <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">Issued</p>
              <p className="mt-0.5 font-mono text-sm text-text">{estimate.issueDate}</p>
            </>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium text-text">Line items</p>
        <ul className="flex flex-col gap-2">
          {estimate.lines.map((line) => (
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
            {formatMoney(estimate.totals.net)}
          </span>
        </div>
        <div className="flex justify-between text-sm text-text-muted">
          <span>Tax</span>
          <span className="font-mono tabular-nums text-text">
            {formatMoney(estimate.totals.tax)}
          </span>
        </div>
        <div className="flex justify-between border-t border-border pt-1 text-sm font-semibold text-text">
          <span>Total</span>
          <span className="font-mono tabular-nums">{formatMoney(estimate.totals.gross)}</span>
        </div>
      </div>

      {estimate.memo !== null && estimate.memo !== '' && (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">
            Notes / Terms
          </p>
          <p className="whitespace-pre-wrap rounded-md bg-accent-soft p-3 text-sm italic text-text">
            {estimate.memo}
          </p>
        </div>
      )}

      <div className="no-print fixed inset-x-0 bottom-0 z-10 flex items-center justify-end gap-2 border-t border-border bg-surface p-3">
        {actions}
      </div>
    </section>
  );
}
