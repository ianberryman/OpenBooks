import { useQueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useId, useState } from 'react';

import { presentApiError } from '../../api';
import { ContactFormDialog } from '../contacts/contact-form';
import {
  Button,
  Combobox,
  Dialog,
  DialogClose,
  DialogContent,
  ErrorBanner,
  Field,
  FieldLabel,
  MoneyInput,
  Select,
  TextInput,
} from '../../components';
import { AllocationEditor, AllocationRefusal, reduceToOutstanding } from './allocation-editor';
import type { AllocationDraft } from './allocation-editor';
import { todayCalendarDate } from './amounts';
import { DateField } from './controls';
import type { CreatePaymentRequest, PaymentDirection } from './queries';
import {
  moneyInKeys,
  useContactOptions,
  useIntentKey,
  useMoneyAccountOptions,
  useOpenDocuments,
  useRecordPayment,
} from './queries';

/**
 * Recording a payment (OB-070; ROADMAP D-37).
 *
 * ## The form does not ask what the money settles
 *
 * That is the decision this dialog exists to make legible. A payment is an amount of money
 * that moved; an allocation is a separate statement about what it settles, and nothing
 * requires the two to be equal at the moment the money is recorded. So the required fields
 * are the ones that describe the movement — who, when, how much, through which account —
 * and the document picker is closed by default, below them, behind a heading that says
 * applying is optional.
 *
 * This is not a convenience. A deposit arriving before anyone has decided what it settles is
 * the *common* case, along with a customer who rounds up and a transfer that pays three
 * invoices. A form that required an invoice would make all three unrecordable, and the
 * workaround people reach for — a suspense journal posted by hand — is exactly the
 * un-auditable move the subledger exists to replace. What is left over is not an error and
 * is never reported as one: it is a credit balance on the contact, applicable later.
 *
 * ## Applying in the same call, when the user does know
 *
 * `POST /v1/payments` takes `allocations`, so the ordinary case — one payment settling one
 * invoice — stays a single idempotent write. Two calls would leave a window in which the
 * money is recorded and unapplied, and a client that failed between them would have created
 * the orphan credit that makes people distrust the feature. The batch is still
 * all-or-nothing: over-allocating any target refuses the request and the payment is not
 * recorded either, which is why the refusal below offers a repair rather than a retry.
 */

export interface RecordPaymentDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The recorded payment's id, so the screen can open it and show the credit it created. */
  readonly onRecorded: (paymentId: string) => void;
}

const DIRECTION_OPTIONS = [
  { value: 'received', label: 'Received — money in, settles invoices' },
  { value: 'made', label: 'Made — money out, settles bills' },
];

interface FormValues {
  direction: PaymentDirection;
  contactId: string | null;
  date: string;
  amount: string | null;
  accountId: string | null;
  reference: string;
  memo: string;
}

export function RecordPaymentDialog({
  open,
  onOpenChange,
  onRecorded,
}: RecordPaymentDialogProps): ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Mounted only while open, so a second "Record payment" starts from an empty form
          rather than from whatever the last one was abandoned holding. */}
      {open && (
        <RecordPaymentForm
          onRecorded={(paymentId) => {
            onOpenChange(false);
            onRecorded(paymentId);
          }}
        />
      )}
    </Dialog>
  );
}

function RecordPaymentForm({
  onRecorded,
}: {
  readonly onRecorded: (paymentId: string) => void;
}): ReactElement {
  const formId = useId();
  const [values, setValues] = useState<FormValues>({
    direction: 'received',
    contactId: null,
    date: todayCalendarDate(),
    amount: null,
    accountId: null,
    reference: '',
    memo: '',
  });
  const [applying, setApplying] = useState(false);
  const [drafts, setDrafts] = useState<readonly AllocationDraft[]>([]);
  // Inline contact creation from the picker: the typed name, or null when the form is shut.
  const [newContactName, setNewContactName] = useState<string | null>(null);

  const queryClient = useQueryClient();
  const contacts = useContactOptions();
  const accounts = useMoneyAccountOptions();
  const openDocuments = useOpenDocuments(values.direction, applying ? values.contactId : null);
  const record = useRecordPayment();
  const intentKey = useIntentKey();

  // Which side the money is on decides what a new contact is: a received payment settles a
  // customer's invoices, a made one a vendor's bills. Pre-marking the role means "New …"
  // reads right and the contact lands where the next document will look for it.
  const createsCustomer = values.direction === 'received';

  const documents = openDocuments.data ?? [];
  const fieldErrors = presentApiError(record.error).fieldErrors;
  const complete =
    values.contactId !== null &&
    values.accountId !== null &&
    values.amount !== null &&
    values.date !== '';

  function set<K extends keyof FormValues>(field: K, value: FormValues[K]): void {
    setValues((current) => ({ ...current, [field]: value }));
  }

  function body(): CreatePaymentRequest | null {
    const { contactId, accountId, amount } = values;
    if (contactId === null || accountId === null || amount === null) return null;

    return {
      direction: values.direction,
      contactId,
      accountId,
      date: values.date,
      amount,
      reference: values.reference.trim() === '' ? null : values.reference.trim(),
      memo: values.memo.trim() === '' ? null : values.memo.trim(),
      // Absent rather than empty when nobody has decided what this settles. `[]` and
      // "no allocations" are the same request, and the shorter one says what happened.
      ...(applying && drafts.length > 0
        ? {
            allocations: drafts.map((draft) => {
              const document = documents.find((candidate) => candidate.id === draft.documentId);
              return {
                targetType:
                  document?.targetType ?? (values.direction === 'received' ? 'invoice' : 'bill'),
                targetId: draft.documentId,
                amount: draft.amount,
              };
            }),
          }
        : {}),
    };
  }

  function submit(): void {
    const request = body();
    if (request === null) return;

    record.mutate(
      { ...request, idempotencyKey: intentKey(JSON.stringify(request)) },
      {
        onSuccess: (payment) => {
          onRecorded(payment.id);
        },
      },
    );
  }

  return (
    <DialogContent
      title="Record a payment"
      description="Money that moved. What it settles is a separate decision, and it can wait."
      footer={
        <>
          <DialogClose asChild>
            <Button disabled={record.isPending}>Cancel</Button>
          </DialogClose>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            disabled={record.isPending || !complete}
          >
            {record.isPending ? 'Recording…' : 'Record payment'}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {record.isError &&
          (applying && drafts.length > 0 ? (
            <AllocationRefusal
              error={record.error}
              drafts={drafts}
              documents={documents}
              available={values.amount ?? '0'}
              onReduceToOutstanding={() => {
                setDrafts(reduceToOutstanding(drafts, documents));
                record.reset();
              }}
              onDismiss={() => {
                record.reset();
              }}
            />
          ) : (
            <ErrorBanner error={record.error} />
          ))}

        <Field hint="A received payment settles invoices; one made settles bills. An allocation may never cross the two.">
          <FieldLabel>Direction</FieldLabel>
          <Select
            value={values.direction}
            options={DIRECTION_OPTIONS}
            onValueChange={(value) => {
              set('direction', value === 'made' ? 'made' : 'received');
              setDrafts([]);
            }}
          />
        </Field>

        <Field
          error={fieldErrors['contactId']}
          hint="Required even with nothing applied: an unapplied payment is a credit balance on a contact, and one belonging to nobody could never be found again."
        >
          <FieldLabel>Contact</FieldLabel>
          <Combobox
            value={values.contactId}
            options={contacts.map((contact) => ({
              value: contact.id,
              label: contact.displayName,
              ...(contact.code === null ? {} : { detail: contact.code }),
            }))}
            placeholder="Search contacts…"
            onValueChange={(contactId) => {
              set('contactId', contactId);
              setDrafts([]);
            }}
            onCreate={{
              label: (q) =>
                q.trim() === ''
                  ? createsCustomer
                    ? 'New customer'
                    : 'New vendor'
                  : `Create "${q.trim()}"`,
              onSelect: (q) => {
                setNewContactName(q.trim());
              },
            }}
          />
        </Field>

        <DateField
          label="Date"
          value={values.date}
          hint="The date the money moved, and the entry date of the journal it posts. It must fall in an open period."
          error={fieldErrors['date']}
          onChange={(date) => {
            set('date', date);
          }}
        />

        <Field error={fieldErrors['amount']}>
          <FieldLabel>Amount</FieldLabel>
          <MoneyInput
            value={values.amount}
            onValueChange={(amount) => {
              set('amount', amount);
            }}
          />
        </Field>

        <Field
          error={fieldErrors['accountId']}
          hint="The bank or cash account the money moved through."
        >
          <FieldLabel>Account</FieldLabel>
          <Combobox
            value={values.accountId}
            options={accounts.map((account) => ({
              value: account.id,
              label: account.name,
              detail: account.code,
            }))}
            placeholder="Search accounts…"
            onValueChange={(accountId) => {
              set('accountId', accountId);
            }}
          />
        </Field>

        <Field
          error={fieldErrors['reference']}
          hint="The bank's reference, the cheque number — whatever identifies this movement on a statement. A payment has no number of its own."
        >
          <FieldLabel>Reference</FieldLabel>
          <TextInput
            value={values.reference}
            autoComplete="off"
            onChange={(event) => {
              set('reference', event.target.value);
            }}
          />
        </Field>

        <Field error={fieldErrors['memo']}>
          <FieldLabel>Memo</FieldLabel>
          <TextInput
            value={values.memo}
            autoComplete="off"
            onChange={(event) => {
              set('memo', event.target.value);
            }}
          />
        </Field>

        <fieldset className="flex flex-col gap-2 rounded-md border border-border p-3">
          <legend className="px-1 text-sm font-medium text-text">
            Apply it to documents — optional
          </legend>
          <p className="text-xs text-text-subtle">
            Leave this alone if nobody has decided what the money settles yet. Recording it
            unapplied is not an omission: the amount becomes credit on the contact and can be
            applied to any of their documents later, on this screen.
          </p>

          {!applying && (
            <div>
              <Button
                size="sm"
                disabled={values.contactId === null}
                onClick={() => {
                  setApplying(true);
                }}
              >
                Choose documents
              </Button>
              {values.contactId === null && (
                <p className="pt-1 text-xs text-text-subtle">
                  Pick a contact first — money settles that contact&rsquo;s documents and nobody
                  else&rsquo;s.
                </p>
              )}
            </div>
          )}

          {applying && openDocuments.isPending && (
            <p className="text-sm text-text-muted">Loading open documents…</p>
          )}

          {applying && openDocuments.isError && <ErrorBanner error={openDocuments.error} />}

          {applying && openDocuments.isSuccess && (
            <>
              <AllocationEditor
                documents={documents}
                drafts={drafts}
                onChange={setDrafts}
                available={values.amount ?? '0'}
                isPending={record.isPending}
                emptyMessage="This contact has nothing open on this side. The whole payment becomes credit on them."
                asOfDate={values.date}
              />
              <div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setApplying(false);
                    setDrafts([]);
                  }}
                >
                  Record it unapplied instead
                </Button>
              </div>
            </>
          )}

          {applying && drafts.length > 0 && (
            <p className="text-xs text-text-subtle">
              These go in the same write that records the payment, and they succeed or fail with it.
            </p>
          )}
        </fieldset>
      </form>

      {/* Inline contact creation: seeded with the typed name and pre-marked by the side the
          money is on; on success the money-in contacts list is refetched (its own query key,
          which useCreateContact's `['contacts']` invalidation does not reach) and selected. */}
      <ContactFormDialog
        contact={null}
        open={newContactName !== null}
        onOpenChange={(next) => {
          if (!next) setNewContactName(null);
        }}
        initialDisplayName={newContactName ?? ''}
        initialIsCustomer={createsCustomer}
        initialIsVendor={!createsCustomer}
        onCreated={(created) => {
          void queryClient.invalidateQueries({ queryKey: moneyInKeys.contacts });
          set('contactId', created.id);
          setDrafts([]);
        }}
      />
    </DialogContent>
  );
}
