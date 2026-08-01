import type { ReactElement, ReactNode } from 'react';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { Button, ResponsiveTable, formatMoney } from '../../components';
import { cx } from '../../lib/cx';
import { useIsCompact } from '../../lib/use-viewport';
import { ConvertEstimateDialog } from './convert-dialog';
import { EstimateHeader } from './estimate-header';
import { isExpired } from './estimate-presentation';
import { MobileDocumentView } from './mobile-document-view';
import type { Estimate, EstimateReferenceData, Invoice } from './queries';
import { SendEstimateDialog } from './send-dialog';

/**
 * A read-only estimate: what it says, and the two things left to do with it once it can no
 * longer be edited (D-M6). The AR mirror of `sales/document-view.tsx`, with the whole
 * payment-history section gone — an estimate posts no journal and settles nothing, so there
 * is no settlement to show and no allocation to un-apply before a void that does not exist
 * either. Correcting an estimate is discarding the draft or letting it lapse; there is no
 * reversal here (D-M3).
 *
 * ## Convert is the only irreversible step
 *
 * `ConvertEstimateDialog` is reused as-is rather than re-implemented: convert-once is
 * enforced by the server's row-locked read (`estimate_already_converted` on a second
 * attempt), and this view only stops offering the button once `status` says `converted`.
 *
 * ## `initialSend`
 *
 * `estimate-editor.tsx`'s Approve action hands off here wanting the Send dialog already
 * open (`onApproved(approved, { openSend: true })`) — `sales/document-view.tsx`'s own
 * reasoning applies unchanged: one primary action from the user's point of view ("approve
 * and send") implemented as two separate calls because the API offers Approve and Send
 * separately. Read once into the `sending` state's initializer, not watched with an effect
 * — it names an intent for the estimate this view mounted with.
 */
export interface EstimateDetailViewProps {
  readonly estimate: Estimate;
  readonly reference: EstimateReferenceData;
  readonly onBack: () => void;
  readonly initialSend?: boolean;
  readonly onConverted: (invoice: Invoice) => void;
  readonly onChanged: () => void;
}

/**
 * "Expires in N days" / "Expires today" / "Expired" — `sales/document-view.tsx`'s
 * `dueSubline`, restated for a date that lapses rather than falls due. `expiryDate` and
 * `asOf` are both `YYYY-MM-DD`, so the day count is a `Date.parse` of each side and nothing
 * fancier.
 */
function expirySubline(estimate: Estimate, asOf: string): string | null {
  if (estimate.expiryDate === null) return null;
  if (isExpired(estimate, asOf)) return 'Expired';
  if (estimate.expiryDate === asOf) return 'Expires today';
  const days = Math.round((Date.parse(estimate.expiryDate) - Date.parse(asOf)) / 86_400_000);
  return `Expires in ${String(days)} day${days === 1 ? '' : 's'}`;
}

export function EstimateDetailView({
  estimate,
  reference,
  onBack,
  initialSend,
  onConverted,
  onChanged,
}: EstimateDetailViewProps): ReactElement {
  const asOf = new Date().toISOString().slice(0, 10);

  const [converting, setConverting] = useState(false);
  const [sending, setSending] = useState(() => initialSend === true && estimate.status !== 'draft');

  const contact = reference.contactsById.get(estimate.contactId);
  const expired = isExpired(estimate, asOf);

  /**
   * Built once and handed to both presentations (`EstimateHeader` on desktop, the sticky
   * footer inside `MobileDocumentView` on a phone) — `sales/document-view.tsx`'s reason: a
   * button is never wired up twice. `draft` offers nothing here because a draft is edited,
   * not viewed (`estimate-editor.tsx` owns that state).
   */
  const actions: ReactNode = (
    <>
      {estimate.status === 'approved' && (
        <Button variant="primary" onClick={() => setConverting(true)}>
          Convert to invoice
        </Button>
      )}

      {estimate.status !== 'draft' && (
        <Button
          variant={estimate.status === 'approved' ? 'secondary' : 'primary'}
          onClick={() => setSending(true)}
        >
          Send
        </Button>
      )}

      <Button
        variant="secondary"
        onClick={() => {
          window.print();
        }}
      >
        Print
      </Button>

      {estimate.status === 'converted' && estimate.convertedInvoiceId !== null && (
        <Link
          to={`/sales/invoices/${estimate.convertedInvoiceId}`}
          className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-border bg-surface px-3 text-base font-medium text-text transition-colors hover:bg-surface-hover"
        >
          View invoice
        </Link>
      )}
    </>
  );

  const convertDialog = (
    <ConvertEstimateDialog
      estimate={converting ? estimate : null}
      reference={reference}
      onOpenChange={setConverting}
      onConverted={(invoice) => {
        onChanged();
        onConverted(invoice);
      }}
    />
  );

  const sendDialog = (
    <SendEstimateDialog
      estimate={sending ? estimate : null}
      reference={reference}
      onOpenChange={setSending}
    />
  );

  if (useIsCompact()) {
    // The phone read-only layout. The dialogs stay rendered alongside it — not inside a
    // ternary branch shared with desktop-only content, because this view has no
    // non-compact sibling for them to hang off — so Convert/Send still have somewhere to
    // open (`sales/document-view.tsx`'s same structure).
    return (
      <>
        <MobileDocumentView
          estimate={estimate}
          reference={reference}
          asOf={asOf}
          actions={actions}
          onNavigateList={onBack}
        />

        {convertDialog}
        {sendDialog}
      </>
    );
  }

  return (
    <section
      className="flex flex-col gap-4"
      aria-label={`Estimate ${estimate.documentNumber ?? ''}`}
    >
      <EstimateHeader document={estimate} asOf={asOf} actions={actions} onNavigateList={onBack} />

      <div className="flex flex-wrap items-start justify-between gap-6 rounded-lg border border-border bg-surface p-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">
            Expiry date
          </p>
          <p className="mt-0.5 font-mono text-xl font-semibold text-text">
            {estimate.expiryDate ?? '—'}
          </p>
          {expirySubline(estimate, asOf) !== null && (
            <p
              className={cx(
                'mt-0.5 text-sm',
                expired ? 'font-semibold text-danger-text' : 'text-text-muted',
              )}
            >
              {expirySubline(estimate, asOf)}
            </p>
          )}
        </div>

        <div className="flex gap-8">
          <div className="text-right">
            <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">Total</p>
            <p className="mt-0.5 font-mono text-xl font-semibold tabular-nums text-text">
              {formatMoney(estimate.totals.gross)}
            </p>
          </div>

          {estimate.status === 'converted' && estimate.convertedInvoiceId !== null && (
            <div className="text-right">
              <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">
                Converted
              </p>
              <p className="mt-0.5 text-sm">
                <Link
                  to={`/sales/invoices/${estimate.convertedInvoiceId}`}
                  className="underline underline-offset-2 hover:no-underline"
                >
                  View invoice
                </Link>
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-6 rounded-lg border border-border bg-surface p-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">Customer</p>
          <p className="mt-0.5 text-base font-medium text-text">
            {contact?.displayName ?? 'Unknown contact'}
          </p>
          {contact?.addressLine1 != null && (
            <p className="text-sm text-text-subtle">{contact.addressLine1}</p>
          )}
          {contact?.addressLine2 != null && (
            <p className="text-sm text-text-subtle">{contact.addressLine2}</p>
          )}
          {contact?.city != null && <p className="text-sm text-text-subtle">{contact.city}</p>}
          {contact?.region != null && <p className="text-sm text-text-subtle">{contact.region}</p>}
          {contact?.postalCode != null && (
            <p className="text-sm text-text-subtle">{contact.postalCode}</p>
          )}
          {contact?.country != null && (
            <p className="text-sm text-text-subtle">{contact.country}</p>
          )}
        </div>

        <div className="flex gap-8">
          <div className="text-right">
            <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">
              Reference
            </p>
            <p className="mt-0.5 font-mono text-sm text-text">{estimate.reference ?? '—'}</p>
          </div>

          <div className="text-right">
            <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">
              Issue date
            </p>
            <p className="mt-0.5 font-mono text-sm text-text">{estimate.issueDate}</p>
          </div>
        </div>
      </div>

      <ResponsiveTable aria-label="Estimate lines">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Estimate lines</caption>
          <thead>
            <tr className="text-left text-xs text-text-subtle">
              <th scope="col" className="p-1 font-medium">
                Description
              </th>
              <th scope="col" className="p-1 text-right font-medium">
                Quantity
              </th>
              <th scope="col" className="p-1 font-medium">
                Account
              </th>
              <th scope="col" className="p-1 text-right font-medium">
                Unit price
              </th>
              <th scope="col" className="p-1 text-right font-medium">
                Line total
              </th>
            </tr>
          </thead>
          <tbody>
            {estimate.lines.map((line) => (
              <tr key={line.lineId} className="border-t border-border">
                <td className="p-1 text-text">{line.description}</td>
                <td className="p-1 text-right font-mono text-text-muted">{line.quantity}</td>
                <td className="p-1 text-text-muted">
                  {reference.accountsById.get(line.accountId)?.name ?? '—'}
                </td>
                <td className="p-1 text-right font-mono tabular-nums text-text">
                  {formatMoney(line.unitAmount)}
                </td>
                <td className="p-1 text-right font-mono tabular-nums text-text">
                  {formatMoney(line.grossAmount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ResponsiveTable>

      {estimate.memo !== null && (
        <div className="flex flex-col gap-1 rounded-lg border border-border bg-surface p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">
            Notes / Terms
          </p>
          <p className="whitespace-pre-wrap text-sm text-text">{estimate.memo}</p>
        </div>
      )}

      {convertDialog}
      {sendDialog}
    </section>
  );
}
