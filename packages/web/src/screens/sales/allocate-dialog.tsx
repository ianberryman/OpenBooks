import { useMutation } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useState } from 'react';

import { newIdempotencyKey } from '../../api';
import { Button, Dialog, DialogContent, MoneyInput, formatMoney } from '../../components';
import { Refusal } from './refusal';
import { allocateCreditNote, useOpenInvoices } from './queries';
import type { CreditNote, InvoiceSummary } from './queries';

/**
 * Applying a credit note to invoices — D-39's whole mechanism (OB-068).
 *
 * ## Why this is not "issue a negative invoice"
 *
 * A credit note is a document, not a negative invoice. It posts its own journal at
 * approval, and it reduces what a customer owes by *allocating* against invoices through
 * the same rows a payment uses — so "what is outstanding" has one definition regardless of
 * what reduced it. Modelling it the other way would make aging special-case a sign and
 * would hand the customer an invoice claiming they owe minus two hundred.
 *
 * Approving therefore does **not** apply anything. It makes the credit available; this
 * dialog is the separate act that spends it, and the two being separate is why an approved
 * credit note reads `Credit available` rather than `Paid`.
 *
 * ## The amounts here are the user's, and every rule about them is the server's
 *
 * The dialog does not decide whether a batch fits. Over-allocating a document is refused
 * (`document_over_allocated`) and asking for more than the credit has left is refused
 * (`source_over_allocated`), both server-side and both against numbers computed on read
 * (D-34). What is shown next to each field — the invoice's `settlement.outstanding` — is
 * the server's own figure, offered as guidance rather than enforced as a maximum, because
 * a client-side cap would be a second definition of outstanding that goes stale the moment
 * somebody else records a payment.
 *
 * The whole batch carries **one** idempotency key, minted when the user presses Apply:
 * "this credit settles two invoices" is one decision by one person and has to succeed or
 * fail as one.
 */
export interface AllocateDialogProps {
  readonly creditNote: CreditNote;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onApplied: () => void;
}

export function AllocateDialog({
  creditNote,
  open,
  onOpenChange,
  onApplied,
}: AllocateDialogProps): ReactElement {
  const invoices = useOpenInvoices(open ? creditNote.contactId : null);
  const [amounts, setAmounts] = useState<Readonly<Record<string, string | null>>>({});
  const [failure, setFailure] = useState<unknown>(null);

  const apply = useMutation({
    mutationFn: async (variables: {
      readonly allocations: readonly { targetId: string; amount: string }[];
      readonly idempotencyKey: string;
    }) =>
      allocateCreditNote(
        creditNote.id,
        {
          allocations: variables.allocations.map((allocation) => ({
            targetType: 'invoice',
            targetId: allocation.targetId,
            amount: allocation.amount,
          })),
        },
        variables.idempotencyKey,
      ),
  });

  const chosen = Object.entries(amounts).flatMap(([targetId, amount]) =>
    amount === null || amount === '0' ? [] : [{ targetId, amount }],
  );

  async function handleApply(): Promise<void> {
    setFailure(null);
    try {
      await apply.mutateAsync({
        allocations: chosen,
        // One key for the batch, minted at the moment the user commits — so a retry
        // replays the same application rather than applying the credit twice.
        idempotencyKey: newIdempotencyKey(),
      });
      setAmounts({});
      onApplied();
      onOpenChange(false);
    } catch (error) {
      setFailure(error);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setAmounts({});
          setFailure(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent
        title="Apply this credit to invoices"
        description={
          `${formatMoney(creditNote.settlement.outstanding)} of this credit note is still ` +
          'available. Applying it reduces what those invoices leave outstanding; it posts no ' +
          'journal, because the credit note already put the money into the ledger when it was ' +
          'approved.'
        }
        footer={
          <>
            <Button
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={chosen.length === 0 || apply.isPending}
              onClick={() => {
                void handleApply();
              }}
            >
              {apply.isPending ? 'Applying…' : 'Apply credit'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {failure !== null && <Refusal error={failure} />}

          {invoices.error != null && <Refusal error={invoices.error} />}

          {invoices.isPending ? (
            <p className="text-sm text-text-subtle">Loading this customer’s open invoices…</p>
          ) : invoices.invoices.length === 0 ? (
            <p className="text-sm text-text-muted">
              This customer has no approved invoices with anything outstanding. A credit note can
              only be applied to an invoice of the same contact that is in the ledger — a draft is
              not.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {invoices.invoices.map((invoice) => (
                <InvoiceRow
                  key={invoice.id}
                  invoice={invoice}
                  amount={amounts[invoice.id] ?? null}
                  disabled={apply.isPending}
                  onAmountChange={(amount) => {
                    setAmounts((current) => ({ ...current, [invoice.id]: amount }));
                  }}
                />
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function InvoiceRow({
  invoice,
  amount,
  disabled,
  onAmountChange,
}: {
  readonly invoice: InvoiceSummary;
  readonly amount: string | null;
  readonly disabled: boolean;
  readonly onAmountChange: (amount: string | null) => void;
}): ReactElement {
  const label = invoice.documentNumber ?? 'Unnumbered';

  return (
    <li className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-2">
      <div className="min-w-0 flex-1">
        <p className="font-mono text-sm text-text">{label}</p>
        <p className="text-xs text-text-subtle">
          Due {invoice.dueDate} · {formatMoney(invoice.settlement.outstanding)} outstanding
        </p>
      </div>
      <div className="w-32">
        <MoneyInput
          aria-label={`Amount to apply to invoice ${label}`}
          value={amount}
          disabled={disabled}
          onValueChange={onAmountChange}
        />
      </div>
    </li>
  );
}
