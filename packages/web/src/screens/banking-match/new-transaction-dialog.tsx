import type { ReactElement } from 'react';
import { useId, useState } from 'react';

import { newIdempotencyKey, presentApiError } from '../../api';
import {
  Button,
  CONTROL_CLASSES,
  Dialog,
  DialogClose,
  DialogContent,
  ErrorBanner,
  Field,
  FieldLabel,
  MoneyInput,
  Select,
  TextInput,
  useFieldControl,
} from '../../components';
import { cx } from '../../lib/cx';

import { useCreateManualStatementLine } from './queries';

/**
 * Enter one bank statement line by hand, for the match/reconcile flow when a transaction the
 * bank shows has no file yet — a same-day deposit, a fee. It joins the "To match" list and
 * dedupes against a later import of the same transaction (D-42), so this is a shortcut, not a
 * second source of truth.
 *
 * The form takes a positive amount plus a direction; the wire amount is signed (positive money
 * in, negative money out), so the direction is folded into the sign at submit. Everything else
 * — validation, the zero-amount refusal — is the server's shared schema, not restated here.
 */
export function NewTransactionDialog({
  bankAccountId,
  open,
  onOpenChange,
}: {
  readonly bankAccountId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <NewTransactionForm bankAccountId={bankAccountId} onDone={() => onOpenChange(false)} />
      )}
    </Dialog>
  );
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function NewTransactionForm({
  bankAccountId,
  onDone,
}: {
  readonly bankAccountId: string;
  readonly onDone: () => void;
}): ReactElement {
  const formId = useId();
  const [postedDate, setPostedDate] = useState<string>(todayIso);
  const [description, setDescription] = useState('');
  const [direction, setDirection] = useState<'in' | 'out'>('in');
  const [amount, setAmount] = useState<string | null>(null);
  const [counterparty, setCounterparty] = useState('');
  const [reference, setReference] = useState('');

  const create = useCreateManualStatementLine();
  const fieldErrors = presentApiError(create.error).fieldErrors;

  const complete =
    postedDate !== '' && description.trim() !== '' && amount !== null && amount !== '0';

  function orNull(value: string): string | null {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }

  function submit(): void {
    if (!complete || amount === null) return;
    const signed = direction === 'out' ? `-${amount}` : amount;
    create.mutate(
      {
        body: {
          bankAccountId,
          postedDate,
          valueDate: null,
          amount: signed,
          description: description.trim(),
          counterparty: orNull(counterparty),
          bankReference: orNull(reference),
        },
        idempotencyKey: newIdempotencyKey(),
      },
      { onSuccess: onDone },
    );
  }

  return (
    <DialogContent
      title="New transaction"
      description="A bank line entered by hand — a deposit or fee the bank shows before its file arrives. It joins the list to match, and dedupes against a later import."
      footer={
        <>
          <DialogClose asChild>
            <Button disabled={create.isPending}>Cancel</Button>
          </DialogClose>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            disabled={create.isPending || !complete}
          >
            {create.isPending ? 'Adding…' : 'Add transaction'}
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
        {create.isError && <ErrorBanner error={create.error} />}

        <Field
          error={fieldErrors['postedDate']}
          hint="The date it posted — a reconciliation counts it under this date."
        >
          <FieldLabel>Date</FieldLabel>
          <DateControl value={postedDate} onChange={setPostedDate} />
        </Field>

        <Field error={fieldErrors['description']}>
          <FieldLabel>Description</FieldLabel>
          <TextInput
            value={description}
            autoComplete="off"
            onChange={(event) => {
              setDescription(event.target.value);
            }}
          />
        </Field>

        <div className="flex flex-wrap gap-3">
          <Field className="w-40">
            <FieldLabel>Direction</FieldLabel>
            <Select
              value={direction}
              options={[
                { value: 'in', label: 'Money in' },
                { value: 'out', label: 'Money out' },
              ]}
              onValueChange={(value) => {
                setDirection(value === 'out' ? 'out' : 'in');
              }}
            />
          </Field>

          <Field className="min-w-40 flex-1" error={fieldErrors['amount']}>
            <FieldLabel>Amount</FieldLabel>
            <MoneyInput value={amount} onValueChange={setAmount} />
          </Field>
        </div>

        <Field error={fieldErrors['counterparty']}>
          <FieldLabel>Counterparty (optional)</FieldLabel>
          <TextInput
            value={counterparty}
            autoComplete="off"
            onChange={(event) => {
              setCounterparty(event.target.value);
            }}
          />
        </Field>

        <Field error={fieldErrors['bankReference']}>
          <FieldLabel>Reference (optional)</FieldLabel>
          <TextInput
            value={reference}
            autoComplete="off"
            onChange={(event) => {
              setReference(event.target.value);
            }}
          />
        </Field>
      </form>
    </DialogContent>
  );
}

/** A native date input wired through `Field` — the same shape money-in's date control uses. */
function DateControl({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}): ReactElement {
  const control = useFieldControl();
  return (
    <input
      {...control}
      type="date"
      value={value}
      className={cx(CONTROL_CLASSES, 'border-border font-mono tabular-nums')}
      onChange={(event) => {
        onChange(event.target.value);
      }}
    />
  );
}
