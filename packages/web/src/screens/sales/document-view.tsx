import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import { useState } from 'react';

import { newIdempotencyKey, presentApiError } from '../../api';
import {
  Button,
  Dialog,
  DialogContent,
  Field,
  FieldLabel,
  ResponsiveTable,
  TextInput,
  formatMoney,
} from '../../components';
import { cx } from '../../lib/cx';
import { useIsCompact } from '../../lib/use-viewport';
import { AllocateDialog } from './allocate-dialog';
import { sendInvoice } from './delivery-client';
import type { InvoiceDelivery } from './delivery-client';
import { todayIsoDate } from './document-state';
import { DocumentHeader } from './document-header';
import { isOverdue } from './invoice-list';
import { MobileDocumentView } from './mobile-document-view';
import { PaymentHistory } from './payment-history';
import { apiFor, deleteAllocation, salesKeys } from './queries';
import type {
  Allocation,
  CreditNote,
  SalesDocument,
  SalesDocumentKind,
  SalesReferenceData,
} from './queries';
import { dueDateOf } from './queries';
import { Refusal, isAllocatedRefusal, preconditionToken } from './refusal';
import { vocabularyFor } from './vocabulary';

/**
 * An approved document: what it says, what has been applied to it, and the two things
 * that can still be done to it (OB-068; ROADMAP D-16, D-34, D-38, D-39).
 *
 * ## Read-only is the point, not a limitation
 *
 * Approval told the ledger. There is no edit affordance here — not disabled, absent —
 * because the server refuses an edit with `document_approved` and an edit form that only
 * ever fails is worse than no form. The corrections are a credit note (a document in its
 * own right) and a void (a reversing journal, never a deletion).
 *
 * ## Voiding, and the refusal it earns
 *
 * The reversal takes its **own** date, because the document's period is usually closed by
 * the time anyone voids it: reopening a closed period restates figures already reported,
 * while a reversal in the current period leaves those statements intact and shows the
 * correction where it happened.
 *
 * A document with allocations against it is refused with `document_has_allocations`, and that is
 * the refusal this view exists to make actionable rather than merely legible. Voiding
 * reverses the journal while the allocation would remain, so a payment would read as fully
 * applied against a receivable that no longer exists and the subledger would disagree with
 * the control account by exactly the amount applied. The fix is to un-apply first, so the
 * refusal is shown alongside `PaymentHistory`'s own Un-apply button on each row.
 *
 * ## Send (OB-131, Phase 1, S4)
 *
 * Invoices only — nothing about a credit note is ever mailed to a customer — and offered
 * whenever the invoice is not void; `sendInvoice` carries an optional `recipientEmail`
 * that overrides the invoiced contact's own address for that one send, so the dialog is
 * where that override is typed rather than a silent default. What this section itself
 * renders — the lines, the totals, the tax summary — *is* the preview: there is no second
 * "preview" endpoint in the delivery contract, so confirming the dialog is confirming
 * against what is already on screen. `sendInvoice`'s call goes through
 * `./delivery-client.ts`, a hand-typed mock of `POST /v1/invoices/{id}/send` — see that
 * file's header for why and for the one-line swap once the route is generated.
 *
 * ## `initialSend`
 *
 * The editor's Approve action, for an invoice, hands off here wanting the Send dialog
 * already open (`onApproved(approved, { openSend: true })`) — one primary action from the
 * user's point of view ("save and send") implemented as two steps because the API only
 * offers Approve and Send separately. `initialSend` is read once into the `sending` state's
 * initializer, not watched with an effect: it names an intent for the document this view
 * mounted with, not a value to keep re-syncing against.
 */
export interface DocumentViewProps {
  readonly document: SalesDocument;
  readonly kind: SalesDocumentKind;
  readonly reference: SalesReferenceData;
  readonly onChanged: () => void;
  readonly onBack: () => void;
  readonly initialSend?: boolean;
}

function isCreditNote(document: SalesDocument, kind: SalesDocumentKind): document is CreditNote {
  return kind === 'credit_note';
}

/**
 * "Due in N days" / "Overdue" / "Due today", from two calendar-date strings — the same
 * kind of plain `<`/`===` comparison `isOverdue` makes, not a date-math library pulled in
 * for one subtraction. `dueDate` and `asOf` are both `YYYY-MM-DD`, so the day count is a
 * `Date.parse` of each side and nothing fancier.
 */
function dueSubline(dueDate: string | null, asOf: string): string | null {
  if (dueDate === null) return null;
  if (dueDate < asOf) return 'Overdue';
  if (dueDate === asOf) return 'Due today';
  const days = Math.round((Date.parse(dueDate) - Date.parse(asOf)) / 86_400_000);
  return `Due in ${String(days)} day${days === 1 ? '' : 's'}`;
}

export function DocumentView({
  document,
  kind,
  reference,
  onChanged,
  onBack,
  initialSend,
}: DocumentViewProps): ReactElement {
  const queryClient = useQueryClient();
  const documentApi = apiFor(kind);
  const words = vocabularyFor(kind);
  const asOf = new Date().toISOString().slice(0, 10);

  const [voiding, setVoiding] = useState(false);
  const [allocating, setAllocating] = useState(false);
  const [voidDate, setVoidDate] = useState(() => todayIsoDate());
  const [voidMemo, setVoidMemo] = useState('');
  const [sending, setSending] = useState(
    () => initialSend === true && kind === 'invoice' && document.status !== 'void',
  );
  const [recipientOverride, setRecipientOverride] = useState('');
  const [delivery, setDelivery] = useState<InvoiceDelivery | null>(null);
  const [failure, setFailure] = useState<unknown>(null);

  const voidDocument = useMutation({
    mutationFn: async (variables: {
      readonly date: string;
      readonly memo: string | null;
      readonly idempotencyKey: string;
    }) =>
      documentApi.void(
        document.id,
        {
          date: variables.date,
          ...(variables.memo === null ? {} : { memo: variables.memo }),
        },
        variables.idempotencyKey,
      ),
  });

  const unapply = useMutation({
    mutationFn: async (variables: {
      readonly allocationId: string;
      readonly idempotencyKey: string;
    }) => deleteAllocation(variables.allocationId, variables.idempotencyKey),
  });

  const send = useMutation({
    mutationFn: async (variables: {
      readonly recipientEmail: string;
      readonly idempotencyKey: string;
    }) =>
      sendInvoice(
        document.id,
        // '' means "no override" — the contact's own email, per `sendInvoiceRequestSchema`
        // — and must not become `recipientEmail: ''` on the wire.
        variables.recipientEmail.trim() === ''
          ? {}
          : { recipientEmail: variables.recipientEmail.trim() },
        variables.idempotencyKey,
      ),
  });

  const busy = voidDocument.isPending || unapply.isPending || send.isPending;
  const presented = failure === null ? null : presentApiError(failure);
  const token = preconditionToken(failure);

  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey: salesKeys.document(kind, document.id) });
    void queryClient.invalidateQueries({ queryKey: salesKeys.list(kind) });
    // The credit picker reads this customer's open invoices, and an allocation just
    // changed what is outstanding on one of them.
    void queryClient.invalidateQueries({ queryKey: salesKeys.openInvoices(document.contactId) });
    onChanged();
  }

  async function handleVoid(): Promise<void> {
    setFailure(null);
    try {
      await voidDocument.mutateAsync({
        date: voidDate,
        memo: voidMemo.trim() === '' ? null : voidMemo.trim(),
        /**
         * Minted per submission rather than held against the document, unlike Approve.
         * `voidInvoice` fingerprints the body, which carries this date and memo — so a
         * key reused after the user corrected the date would come back as an
         * `idempotency_key_conflict` instead of the retry they asked for.
         */
        idempotencyKey: newIdempotencyKey(),
      });
      setVoiding(false);
      refresh();
    } catch (error) {
      setVoiding(false);
      setFailure(error);
    }
  }

  async function handleUnapply(allocation: Allocation): Promise<void> {
    setFailure(null);
    try {
      await unapply.mutateAsync({
        allocationId: allocation.id,
        idempotencyKey: newIdempotencyKey(),
      });
      refresh();
    } catch (error) {
      setFailure(error);
    }
  }

  async function handleSend(): Promise<void> {
    setFailure(null);
    try {
      const result = await send.mutateAsync({
        recipientEmail: recipientOverride,
        // Minted per submission, `handleVoid`'s reason: the body carries the recipient
        // override, so a key reused after the user corrected it would come back as an
        // `idempotency_key_conflict` instead of the retry they asked for.
        idempotencyKey: newIdempotencyKey(),
      });
      setDelivery(result);
      setSending(false);
      setRecipientOverride('');
    } catch (error) {
      setFailure(error);
    }
  }

  const isVoid = document.status === 'void';
  const canApplyCredit =
    isCreditNote(document, kind) && !isVoid && document.settlement.outstanding !== '0';
  const canSend = kind === 'invoice' && !isVoid;
  const overdue = isOverdue(document, asOf);
  const contact = reference.contactsById.get(document.contactId);

  /**
   * Built once and handed to both presentations (`DocumentHeader` on desktop, the sticky
   * footer inside `MobileDocumentView` on a phone), so a button is never wired up twice —
   * the D-38 line decides which appear: a credit note may still be applied, an invoice may
   * still be sent, and everything approved may be printed or voided.
   */
  const actions: ReactNode = (
    <>
      {canApplyCredit && (
        <Button variant="primary" disabled={busy} onClick={() => setAllocating(true)}>
          Apply to invoices
        </Button>
      )}

      {canSend && (
        <Button
          variant="primary"
          disabled={busy}
          onClick={() => {
            send.reset();
            setSending(true);
          }}
        >
          {send.isPending ? 'Sending…' : 'Send'}
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

      {!isVoid && (
        <Button variant="danger" disabled={busy} onClick={() => setVoiding(true)}>
          Void
        </Button>
      )}
    </>
  );

  const refusal =
    presented !== null ? (
      <Refusal error={failure}>
        {isAllocatedRefusal(failure) ? (
          <p className="text-sm text-text-muted">
            Un-apply the allocations listed below, then void it. Voiding reverses this document’s
            journal, and an allocation left pointing at a reversed document would make what the
            subledger says is outstanding disagree with the control account by exactly the amount
            applied.
          </p>
        ) : token === 'document_not_approved' ? (
          <p className="text-sm text-text-muted">
            Nothing has been posted for this document, so there is nothing in the ledger to reverse.
            Discard it instead.
          </p>
        ) : undefined}
      </Refusal>
    ) : null;

  const deliveryBanner =
    delivery === null ? null : (
      <div
        role="status"
        className="flex flex-col gap-1 rounded-lg border border-border bg-surface-sunken p-3"
      >
        <p className="text-sm font-semibold text-text">
          {delivery.status === 'sent' ? 'Sent' : 'Send failed'} to {delivery.recipientEmail}
        </p>
        <p className="text-xs text-text-subtle">
          {new Date(delivery.sentAt).toLocaleString()} ·{' '}
          <a
            href={delivery.publicUrl}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:no-underline"
          >
            Hosted invoice link
          </a>
        </p>
      </div>
    );

  const voidDialog = (
    <Dialog
      open={voiding}
      onOpenChange={(next) => {
        if (!next) setVoiding(false);
      }}
    >
      <DialogContent
        title={`Void this ${words.singular.toLowerCase()}?`}
        description="A second journal reverses the first. Nothing is deleted."
        footer={
          <>
            <Button onClick={() => setVoiding(false)}>Cancel</Button>
            <Button
              variant="danger"
              disabled={voidDocument.isPending}
              onClick={() => {
                void handleVoid();
              }}
            >
              {voidDocument.isPending ? 'Voiding…' : 'Void'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-text-muted">
            This {words.singular.toLowerCase()}, its number and its original journal all stay
            visible — a voided document that vanished would make the gapless number series a lie.
          </p>

          <Field
            className="w-48"
            hint="The reversal’s own date, which must fall in an open period."
          >
            <FieldLabel>Reversal date</FieldLabel>
            <TextInput
              type="date"
              value={voidDate}
              onChange={(event) => {
                setVoidDate(event.target.value);
              }}
            />
          </Field>

          <Field>
            <FieldLabel>Reason</FieldLabel>
            <TextInput
              value={voidMemo}
              placeholder="Carried onto the reversing journal"
              onChange={(event) => {
                setVoidMemo(event.target.value);
              }}
            />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  );

  const sendDialog = (
    <Dialog
      open={sending}
      onOpenChange={(next) => {
        if (!next) setSending(false);
      }}
    >
      <DialogContent
        title="Send this invoice?"
        description="An email goes out with a link to the invoice below and a PDF attached."
        footer={
          <>
            <Button onClick={() => setSending(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={send.isPending}
              onClick={() => {
                void handleSend();
              }}
            >
              {send.isPending ? 'Sending…' : 'Send'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-text-muted">
            Everything above — the lines, the totals, the tax summary — is what the customer will
            see, dressed in the organization&rsquo;s branding.
          </p>

          <Field hint="Leave blank to send to the customer’s own email on file.">
            <FieldLabel>Send to a different address</FieldLabel>
            <TextInput
              type="email"
              value={recipientOverride}
              placeholder={contact?.displayName ?? 'Customer email'}
              onChange={(event) => {
                setRecipientOverride(event.target.value);
              }}
            />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  );

  const allocateDialog = isCreditNote(document, kind) && (
    <AllocateDialog
      creditNote={document}
      open={allocating}
      onOpenChange={setAllocating}
      onApplied={refresh}
    />
  );

  if (useIsCompact()) {
    // The phone read-only layout (the design's mobile invoice/credit-note page). The
    // dialogs stay rendered alongside it — not inside `document-editor.tsx`'s ternary
    // branch, because this view has no non-compact sibling content to share them with —
    // so its Void/Send/Allocate actions still have somewhere to open.
    return (
      <>
        <MobileDocumentView
          kind={kind}
          document={document}
          reference={reference}
          asOf={asOf}
          actions={actions}
          onNavigateList={onBack}
        />

        {(refusal !== null || deliveryBanner !== null) && (
          <div className="flex flex-col gap-3 px-4">
            {refusal}
            {deliveryBanner}
          </div>
        )}

        {voidDialog}
        {sendDialog}
        {allocateDialog}
      </>
    );
  }

  return (
    <section
      className="flex flex-col gap-4"
      aria-label={`${words.singular} ${document.documentNumber ?? ''}`}
    >
      <DocumentHeader
        kind={kind}
        document={document}
        asOf={asOf}
        actions={actions}
        onNavigateList={onBack}
      />

      {refusal}

      <div className="flex flex-wrap items-start justify-between gap-6 rounded-lg border border-border bg-surface p-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">Due date</p>
          <p className="mt-0.5 font-mono text-xl font-semibold text-text">
            {dueDateOf(document) ?? '—'}
          </p>
          {dueSubline(dueDateOf(document), asOf) !== null && (
            <p
              className={cx(
                'mt-0.5 text-sm',
                overdue ? 'font-semibold text-danger-text' : 'text-text-muted',
              )}
            >
              {dueSubline(dueDateOf(document), asOf)}
            </p>
          )}
        </div>

        <div className="flex gap-8">
          <div className="text-right">
            <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">
              Still owed
            </p>
            <p
              className={cx(
                'mt-0.5 font-mono text-xl font-semibold tabular-nums',
                document.settlement.outstanding === '0'
                  ? 'text-success-text'
                  : overdue
                    ? 'text-danger-text'
                    : 'text-text',
              )}
            >
              {formatMoney(document.settlement.outstanding)}
            </p>
          </div>

          <div className="text-right">
            <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">
              Total paid
            </p>
            <p className="mt-0.5 font-mono text-xl font-semibold tabular-nums text-text">
              {formatMoney(document.settlement.allocated)}
            </p>
          </div>
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
            <p className="mt-0.5 font-mono text-sm text-text">{document.reference ?? '—'}</p>
          </div>

          <div className="text-right">
            <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">
              Issue date
            </p>
            <p className="mt-0.5 font-mono text-sm text-text">{document.issueDate}</p>
          </div>
        </div>
      </div>

      <ResponsiveTable aria-label={`${words.singular} lines`}>
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">{words.singular} lines</caption>
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
            {document.lines.map((line) => (
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

      {document.memo !== null && (
        <div className="flex flex-col gap-1 rounded-lg border border-border bg-surface p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">
            Notes / Terms
          </p>
          <p className="whitespace-pre-wrap text-sm text-text">{document.memo}</p>
        </div>
      )}

      <PaymentHistory
        kind={kind}
        allocations={document.allocations}
        settlement={document.settlement}
        totalGross={document.totals.gross}
        onUnapply={(allocation) => {
          void handleUnapply(allocation);
        }}
        disabled={busy}
      />

      {deliveryBanner}

      <p className="text-xs text-text-subtle">Approved documents cannot be edited (D-38).</p>

      {voidDialog}
      {sendDialog}
      {allocateDialog}
    </section>
  );
}
