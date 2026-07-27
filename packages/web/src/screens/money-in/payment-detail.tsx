import type { ReactElement } from 'react';
import { useState } from 'react';

import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  ErrorBanner,
  Field,
  FieldLabel,
  TextInput,
} from '../../components';
import { AllocationEditor, AllocationRefusal, reduceToOutstanding } from './allocation-editor';
import type { AllocationDraft } from './allocation-editor';
import { Amount, isZeroAmount, todayCalendarDate } from './amounts';
import { DateField } from './controls';
import type { Allocation, Payment } from './queries';
import {
  useAllocatePayment,
  useContactOptions,
  useDeleteAllocation,
  useIntentKey,
  useMoneyAccountOptions,
  useOpenDocuments,
  usePayment,
  useVoidPayment,
} from './queries';

/**
 * One payment: what moved, what it has settled, and what is still credit on the contact
 * (OB-070; ROADMAP D-34, D-37, D-39).
 *
 * ## The credit is presented as an asset, not as an unfinished task
 *
 * `settlement.outstanding` on a payment is "how much of this is still available to apply",
 * the same arithmetic as an invoice's "still owed" (D-34) read from the other end. When it
 * is not zero this panel leads with it, in the accent role rather than the warning one,
 * worded as money on account. That is a deliberate choice against the obvious alternative —
 * an amber "unallocated" badge — because D-37 makes an unapplied payment a *credit balance
 * on the contact*, applicable later, and a screen that nags about it teaches people to
 * invent an allocation to make the warning go away. Inventing one is the failure the whole
 * subledger is built to prevent.
 *
 * ## Un-applying is a delete, and it needs no reversal
 *
 * An allocation posts no journal: by the time it is written the payment's journal has
 * already debited the bank and credited the control account, and a second posting would
 * double-count. So the row is an ordinary mutable one, removing it restates no financial
 * statement, and what changes is what is outstanding — which is computed on read (D-34),
 * so there is nothing else to correct anywhere. The button says "Un-apply" rather than
 * "Delete" for that reason: nothing about the money is being deleted.
 *
 * Voiding is the opposite kind of act and is worded as one. It posts a reversing journal
 * and takes the allocations with it, because the money did not move.
 */

export interface PaymentDetailProps {
  readonly paymentId: string;
  readonly onClose: () => void;
}

export function PaymentDetail({ paymentId, onClose }: PaymentDetailProps): ReactElement {
  const payment = usePayment(paymentId);

  if (payment.isPending) {
    return (
      <p role="status" className="text-text-subtle">
        Loading the payment…
      </p>
    );
  }

  if (payment.isError) {
    return (
      <ErrorBanner
        error={payment.error}
        onRetry={() => {
          void payment.refetch();
        }}
      />
    );
  }

  return <PaymentPanel payment={payment.data} onClose={onClose} />;
}

function PaymentPanel({
  payment,
  onClose,
}: {
  readonly payment: Payment;
  readonly onClose: () => void;
}): ReactElement {
  const contacts = useContactOptions();
  const accounts = useMoneyAccountOptions();
  const [applying, setApplying] = useState(false);
  const [voiding, setVoiding] = useState(false);

  const contactName =
    contacts.find((contact) => contact.id === payment.contactId)?.displayName ?? 'This contact';
  const account = accounts.find((candidate) => candidate.id === payment.accountId);
  const voided = payment.status === 'void';
  const credit = payment.settlement.outstanding;

  return (
    <section
      aria-label="Payment detail"
      className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold text-text">
            {payment.direction === 'received' ? 'Received from' : 'Paid to'} {contactName}
          </h2>
          <p className="text-sm text-text-muted">
            <Amount value={payment.amount} /> on {payment.date}
            {account === undefined ? '' : ` through ${account.name}`}
            {payment.reference === null ? '' : ` · ${payment.reference}`}
          </p>
          {payment.memo !== null && <p className="text-sm text-text-subtle">{payment.memo}</p>}
        </div>
        <div className="flex items-center gap-2">
          {voided && (
            <span className="rounded-full border border-warning-border bg-warning-soft px-2 py-0.5 text-xs text-warning-text">
              Voided
            </span>
          )}
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>

      {voided ? (
        <p className="rounded-md border border-border bg-surface-sunken px-3 py-2 text-sm text-text-muted">
          This payment was reversed by a second journal, and the allocations it had made were
          removed — the money did not move, so nothing it settled is settled. Both journals stay
          visible; nothing was deleted.
        </p>
      ) : (
        <CreditOnAccount credit={credit} contactName={contactName} />
      )}

      <AllocationList allocations={payment.allocations} disabled={voided} />

      {!voided && (
        <ApplySection
          payment={payment}
          open={applying}
          onOpenChange={setApplying}
          credit={credit}
        />
      )}

      {!voided && (
        <div className="flex justify-end border-t border-border pt-3">
          <Button
            variant="danger"
            size="sm"
            onClick={() => {
              setVoiding(true);
            }}
          >
            Void this payment
          </Button>
        </div>
      )}

      <VoidPaymentDialog
        payment={payment}
        open={voiding}
        onOpenChange={setVoiding}
        allocationCount={payment.allocations.length}
      />
    </section>
  );
}

/**
 * D-37, in the one place a user meets it.
 *
 * Zero is stated too, rather than the panel disappearing: "fully applied" is information,
 * and an absent line is indistinguishable from a line that failed to render.
 */
function CreditOnAccount({
  credit,
  contactName,
}: {
  readonly credit: string;
  readonly contactName: string;
}): ReactElement {
  if (isZeroAmount(credit)) {
    return (
      <p className="rounded-md border border-border bg-surface-sunken px-3 py-2 text-sm text-text-muted">
        Fully applied — every part of this payment is against a document.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border bg-accent-soft p-3">
      <p className="text-sm font-semibold text-text">
        <Amount value={credit} /> on account
      </p>
      <p className="text-sm text-text-muted">
        Recorded, and not yet against anything. This is {contactName}&rsquo;s credit: it is real
        money already in the books, and it can be applied to any of their documents whenever someone
        decides what it was for.
      </p>
    </div>
  );
}

function AllocationList({
  allocations,
  disabled,
}: {
  readonly allocations: readonly Allocation[];
  readonly disabled: boolean;
}): ReactElement {
  const unapply = useDeleteAllocation();
  const intentKey = useIntentKey();

  if (allocations.length === 0) {
    return (
      <p className="text-sm text-text-muted">Nothing has been applied from this payment yet.</p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-md font-semibold text-text">Applied to</h3>
      <table className="w-full border-collapse text-base">
        <caption className="sr-only">What this payment has settled</caption>
        <thead>
          <tr className="border-b border-border text-left text-sm text-text-muted">
            <th scope="col" className="py-1 pr-3 font-medium">
              Document
            </th>
            <th scope="col" className="py-1 pr-3 font-medium">
              Applied on
            </th>
            <th scope="col" className="py-1 pr-3 text-right font-medium">
              Amount
            </th>
            <th scope="col" className="py-1 font-medium">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {allocations.map((allocation) => (
            <tr key={allocation.id} className="border-b border-border">
              <td className="py-1 pr-3 font-mono text-sm text-text">
                {allocation.targetNumber ?? allocation.targetId}
              </td>
              {/* The allocation's own date, not the payment's: aging as at a date counts
                  only the allocations dated on or before it (D-40), so this is the date
                  that decides which report this settlement appears in. */}
              <td className="py-1 pr-3 font-mono text-sm text-text-muted">{allocation.date}</td>
              <td className="py-1 pr-3 text-right">
                <Amount value={allocation.amount} />
              </td>
              <td className="py-1 text-right">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled || unapply.isPending}
                  aria-label={`Un-apply ${allocation.targetNumber ?? 'this allocation'}`}
                  onClick={() => {
                    unapply.mutate({
                      allocationId: allocation.id,
                      idempotencyKey: intentKey(`unapply:${allocation.id}`),
                    });
                  }}
                >
                  Un-apply
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {unapply.isError && (
        <ErrorBanner
          error={unapply.error}
          onRetry={() => {
            unapply.reset();
          }}
        />
      )}

      <p className="text-xs text-text-subtle">
        Un-applying removes the row outright and restates no financial statement — an allocation
        posts no journal. What it changes is what is outstanding, and that is computed on read.
      </p>
    </div>
  );
}

function ApplySection({
  payment,
  open,
  onOpenChange,
  credit,
}: {
  readonly payment: Payment;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly credit: string;
}): ReactElement {
  const [drafts, setDrafts] = useState<readonly AllocationDraft[]>([]);
  const [date, setDate] = useState(payment.date);
  const openDocuments = useOpenDocuments(payment.direction, open ? payment.contactId : null);
  const allocate = useAllocatePayment();
  const intentKey = useIntentKey();

  const documents = openDocuments.data ?? [];

  if (!open) {
    return (
      <div>
        <Button
          disabled={isZeroAmount(credit)}
          onClick={() => {
            onOpenChange(true);
          }}
        >
          Apply this credit
        </Button>
        {isZeroAmount(credit) && (
          <p className="pt-1 text-xs text-text-subtle">
            There is nothing left on this payment to apply.
          </p>
        )}
      </div>
    );
  }

  function submit(): void {
    if (drafts.length === 0) return;

    const allocations = drafts.map((draft) => {
      const document = documents.find((candidate) => candidate.id === draft.documentId);
      return {
        targetType:
          document?.targetType ??
          (payment.direction === 'received' ? ('invoice' as const) : ('bill' as const)),
        targetId: draft.documentId,
        amount: draft.amount,
      };
    });

    allocate.mutate(
      {
        paymentId: payment.id,
        date,
        allocations,
        idempotencyKey: intentKey(`allocate:${payment.id}:${JSON.stringify(allocations)}:${date}`),
      },
      {
        onSuccess: () => {
          setDrafts([]);
          onOpenChange(false);
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border p-3">
      <h3 className="text-md font-semibold text-text">Apply this credit</h3>

      {allocate.isError && (
        <AllocationRefusal
          error={allocate.error}
          drafts={drafts}
          documents={documents}
          available={credit}
          onReduceToOutstanding={() => {
            setDrafts(reduceToOutstanding(drafts, documents));
            allocate.reset();
          }}
          onDismiss={() => {
            allocate.reset();
          }}
        />
      )}

      {openDocuments.isPending && <p className="text-sm text-text-muted">Loading documents…</p>}
      {openDocuments.isError && <ErrorBanner error={openDocuments.error} />}

      {openDocuments.isSuccess && (
        <>
          <AllocationEditor
            documents={documents}
            drafts={drafts}
            onChange={setDrafts}
            available={credit}
            isPending={allocate.isPending}
            emptyMessage="This contact has nothing open on this side, so the credit stays on account."
          />

          <DateField
            label="Applies from"
            value={date}
            className="w-44"
            hint="Aging as at a date counts only the allocations dated on or before it, so this decides which report the settlement appears in."
            onChange={setDate}
          />

          <div className="flex justify-end gap-2">
            <Button
              disabled={allocate.isPending}
              onClick={() => {
                setDrafts([]);
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={allocate.isPending || drafts.length === 0}
              onClick={submit}
            >
              {allocate.isPending ? 'Applying…' : 'Apply'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Voiding, which is a reversal and never a deletion (D-16).
 *
 * The reversal takes its own date because the payment's own period is usually closed by
 * the time anyone voids it, and the reversing journal has to land somewhere postable.
 */
function VoidPaymentDialog({
  payment,
  open,
  onOpenChange,
  allocationCount,
}: {
  readonly payment: Payment;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly allocationCount: number;
}): ReactElement {
  const [date, setDate] = useState(todayCalendarDate);
  const [memo, setMemo] = useState('');
  const voidPayment = useVoidPayment();
  const intentKey = useIntentKey();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <DialogContent
          title="Void this payment"
          description="A reversing journal, not a deletion. The payment stays visible with both journals against it."
          footer={
            <>
              <DialogClose asChild>
                <Button disabled={voidPayment.isPending}>Cancel</Button>
              </DialogClose>
              <Button
                variant="danger"
                disabled={voidPayment.isPending || date === ''}
                onClick={() => {
                  const body = { date, memo: memo.trim() === '' ? null : memo.trim() };
                  voidPayment.mutate(
                    {
                      paymentId: payment.id,
                      body,
                      idempotencyKey: intentKey(`void:${payment.id}:${JSON.stringify(body)}`),
                    },
                    {
                      onSuccess: () => {
                        onOpenChange(false);
                      },
                    },
                  );
                }}
              >
                {voidPayment.isPending ? 'Voiding…' : 'Void payment'}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            {voidPayment.isError && <ErrorBanner error={voidPayment.error} />}

            {allocationCount > 0 && (
              <p className="rounded-md border border-warning-border bg-warning-soft px-3 py-2 text-sm text-warning-text">
                This will also remove the {allocationCount} allocation(s) this payment made. The
                money did not move, so nothing it settled is settled — the documents go back to
                being outstanding.
              </p>
            )}

            <DateField
              label="Reversal date"
              value={date}
              hint="The reversing journal's own entry date, which must itself fall in an open period."
              onChange={setDate}
            />

            <Field>
              <FieldLabel>Memo</FieldLabel>
              <TextInput
                value={memo}
                autoComplete="off"
                onChange={(event) => {
                  setMemo(event.target.value);
                }}
              />
            </Field>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
