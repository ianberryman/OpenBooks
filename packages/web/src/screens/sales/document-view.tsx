import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useState } from 'react';

import { newIdempotencyKey, presentApiError } from '../../api';
import {
  Button,
  Dialog,
  DialogContent,
  Field,
  FieldLabel,
  TextInput,
  formatMinorUnits,
} from '../../components';
import { AllocateDialog } from './allocate-dialog';
import { AllocationsPanel } from './allocations-panel';
import { todayIsoDate } from './document-state';
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
import { TotalsPanel } from './totals';
import { StatusBadge, TAX_MODE_LABELS, lifecycleSummary, vocabularyFor } from './vocabulary';

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
 * refusal scrolls the user to rows with an Un-apply button on each.
 */
export interface DocumentViewProps {
  readonly document: SalesDocument;
  readonly kind: SalesDocumentKind;
  readonly reference: SalesReferenceData;
  readonly onChanged: () => void;
}

function isCreditNote(document: SalesDocument, kind: SalesDocumentKind): document is CreditNote {
  return kind === 'credit_note';
}

export function DocumentView({
  document,
  kind,
  reference,
  onChanged,
}: DocumentViewProps): ReactElement {
  const queryClient = useQueryClient();
  const documentApi = apiFor(kind);
  const words = vocabularyFor(kind);

  const [voiding, setVoiding] = useState(false);
  const [allocating, setAllocating] = useState(false);
  const [voidDate, setVoidDate] = useState(() => todayIsoDate());
  const [voidMemo, setVoidMemo] = useState('');
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

  const busy = voidDocument.isPending || unapply.isPending;
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

  const isVoid = document.status === 'void';
  const canApplyCredit =
    isCreditNote(document, kind) && !isVoid && document.settlement.outstanding !== '0';

  return (
    <section
      className="flex flex-col gap-4"
      aria-label={`${words.singular} ${document.documentNumber ?? ''}`}
    >
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge status={document.status} />
        <span className="font-mono text-sm text-text">
          {document.documentNumber ?? 'No number'}
        </span>
        {document.reference !== null && (
          <span className="text-sm text-text-subtle">Ref {document.reference}</span>
        )}
      </div>

      <p className="text-sm text-text-muted">
        {lifecycleSummary(document.status, kind, words.outstandingLabel)}
      </p>

      {presented !== null && (
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
              Nothing has been posted for this document, so there is nothing in the ledger to
              reverse. Discard it instead.
            </p>
          ) : undefined}
        </Refusal>
      )}

      <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
        <div>
          <dt className="text-text-subtle">Customer</dt>
          <dd className="text-text">
            {reference.contactsById.get(document.contactId)?.displayName ?? 'Unknown contact'}
          </dd>
        </div>
        <div>
          <dt className="text-text-subtle">Issue date</dt>
          <dd className="font-mono text-text">{document.issueDate}</dd>
        </div>
        {dueDateOf(document) !== null && (
          <div>
            <dt className="text-text-subtle">Due date</dt>
            <dd className="font-mono text-text">{dueDateOf(document)}</dd>
          </div>
        )}
        <div>
          <dt className="text-text-subtle">Tax on prices</dt>
          <dd className="text-text">{TAX_MODE_LABELS[document.taxMode]}</dd>
        </div>
      </dl>

      {document.memo !== null && <p className="text-sm text-text-muted">{document.memo}</p>}

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">{words.singular} lines</caption>
          <thead>
            <tr className="text-left text-xs text-text-subtle">
              <th scope="col" className="p-1 font-medium">
                Description
              </th>
              <th scope="col" className="p-1 text-right font-medium">
                Qty
              </th>
              <th scope="col" className="p-1 text-right font-medium">
                Unit price
              </th>
              <th scope="col" className="p-1 font-medium">
                Account
              </th>
              <th scope="col" className="p-1 font-medium">
                Tax
              </th>
              <th scope="col" className="p-1 text-right font-medium">
                Net
              </th>
              <th scope="col" className="p-1 text-right font-medium">
                Tax
              </th>
              <th scope="col" className="p-1 text-right font-medium">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {document.lines.map((line) => (
              <tr key={line.lineId} className="border-t border-border">
                <td className="p-1 text-text">{line.description}</td>
                <td className="p-1 text-right font-mono text-text-muted">{line.quantity}</td>
                <td className="p-1 text-right font-mono tabular-nums text-text">
                  {formatMinorUnits(line.unitAmount)}
                </td>
                <td className="p-1 text-text-muted">
                  {reference.accountsById.get(line.accountId)?.name ?? '—'}
                </td>
                {/* The percentage as it stood when the document was priced, not today's
                    rate list: a rate is archived rather than deleted, so the id always
                    resolves, and printing the current list against an old document would
                    print a number the customer never saw. */}
                <td className="p-1 text-text-muted">
                  {line.taxRatePercentage === null ? '—' : `${line.taxRatePercentage}%`}
                </td>
                <td className="p-1 text-right font-mono tabular-nums text-text">
                  {formatMinorUnits(line.netAmount)}
                </td>
                <td className="p-1 text-right font-mono tabular-nums text-text">
                  {formatMinorUnits(line.taxAmount)}
                </td>
                <td className="p-1 text-right font-mono tabular-nums text-text">
                  {formatMinorUnits(line.grossAmount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex justify-end">
        <TotalsPanel
          document={document}
          reference={reference}
          outstandingLabel={words.outstandingLabel}
          stale={false}
        />
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-4">
        <h2 className="text-sm font-semibold text-text">Applied</h2>
        <AllocationsPanel
          allocations={document.allocations}
          kind={kind}
          disabled={busy}
          onRemove={(allocation) => {
            void handleUnapply(allocation);
          }}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        <div className="flex-1" />

        {canApplyCredit && (
          <Button variant="primary" disabled={busy} onClick={() => setAllocating(true)}>
            Apply to invoices
          </Button>
        )}

        {!isVoid && (
          <Button variant="danger" disabled={busy} onClick={() => setVoiding(true)}>
            Void
          </Button>
        )}
      </div>

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

      {isCreditNote(document, kind) && (
        <AllocateDialog
          creditNote={document}
          open={allocating}
          onOpenChange={setAllocating}
          onApplied={refresh}
        />
      )}
    </section>
  );
}
