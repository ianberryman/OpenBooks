import type { ReactElement } from 'react';
import { useId, useState } from 'react';

import { presentApiError } from '../../api';
import {
  Button,
  Combobox,
  CONTROL_CLASSES,
  Dialog,
  DialogClose,
  DialogContent,
  ErrorBanner,
  Field,
  FieldLabel,
  MoneyInput,
  useFieldControl,
} from '../../components';
import { cx } from '../../lib/cx';
import type { CreateSessionRequest } from './queries';
import { useBankAccountOptions, useCreateSession, useIntentKey } from './queries';

/**
 * Opening a reconciliation session (OB-087; ROADMAP D-45, D-46).
 *
 * Three fields, and they are the three things a person reads off a paper statement: which
 * account, the date it closes, and the closing balance it claims. `startDate` is not asked —
 * it is derived (carry on from the last session, or the account's earliest line), and the
 * API accepts a value only as an assertion, so sending one this form guessed would risk a
 * spurious `reconciliation_session_overlaps`. The closing balance is the one figure the
 * whole reconciliation is tested against (D-46): the claim from outside the system.
 */

export interface OpenSessionDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly bankAccountId: string | null;
  /** The opened session's id, so the screen can select it and show what it must agree with. */
  readonly onOpened: (sessionId: string) => void;
}

export function OpenSessionDialog({
  open,
  onOpenChange,
  bankAccountId,
  onOpened,
}: OpenSessionDialogProps): ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Mounted only while open, so re-opening starts from an empty form rather than from
          whatever the last one was abandoned holding. */}
      {open && (
        <OpenSessionForm
          bankAccountId={bankAccountId}
          onOpened={(sessionId) => {
            onOpenChange(false);
            onOpened(sessionId);
          }}
        />
      )}
    </Dialog>
  );
}

interface FormValues {
  bankAccountId: string | null;
  endDate: string;
  statementClosingBalance: string | null;
}

function OpenSessionForm({
  bankAccountId,
  onOpened,
}: {
  readonly bankAccountId: string | null;
  readonly onOpened: (sessionId: string) => void;
}): ReactElement {
  const formId = useId();
  const [values, setValues] = useState<FormValues>({
    bankAccountId,
    endDate: '',
    statementClosingBalance: null,
  });

  const accounts = useBankAccountOptions();
  const create = useCreateSession();
  const intentKey = useIntentKey();

  const fieldErrors = presentApiError(create.error).fieldErrors;
  const complete =
    values.bankAccountId !== null &&
    values.endDate !== '' &&
    values.statementClosingBalance !== null;

  function set<K extends keyof FormValues>(field: K, value: FormValues[K]): void {
    setValues((current) => ({ ...current, [field]: value }));
  }

  function body(): CreateSessionRequest | null {
    const { bankAccountId: accountId, statementClosingBalance } = values;
    if (accountId === null || statementClosingBalance === null || values.endDate === '')
      return null;
    return {
      bankAccountId: accountId,
      endDate: values.endDate,
      statementClosingBalance,
    };
  }

  function submit(): void {
    const request = body();
    if (request === null) return;
    create.mutate(
      { ...request, idempotencyKey: intentKey(JSON.stringify(request)) },
      { onSuccess: (session) => onOpened(session.id) },
    );
  }

  return (
    <DialogContent
      title="Open a reconciliation"
      description="A statement to test against the books: the account, the date it closes, and the balance it claims."
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
            {create.isPending ? 'Opening…' : 'Open reconciliation'}
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

        <Field error={fieldErrors['bankAccountId']}>
          <FieldLabel>Bank account</FieldLabel>
          <Combobox
            value={values.bankAccountId}
            options={accounts.map((account) => ({
              value: account.id,
              label: account.name,
              ...(account.institutionName === null ? {} : { detail: account.institutionName }),
            }))}
            placeholder="Search bank accounts…"
            onValueChange={(accountId) => {
              set('bankAccountId', accountId);
            }}
          />
        </Field>

        <Field
          error={fieldErrors['endDate']}
          hint="The date the statement closes. Every balance is computed as at this date; a line dated after it cannot be cleared into this session."
        >
          <FieldLabel>Statement end date</FieldLabel>
          <EndDateInput
            value={values.endDate}
            onChange={(endDate) => {
              set('endDate', endDate);
            }}
          />
        </Field>

        <Field
          error={fieldErrors['statementClosingBalance']}
          hint="What the statement says the account held at the end date — the claim the reconciliation tests."
        >
          <FieldLabel>Statement closing balance</FieldLabel>
          <MoneyInput
            value={values.statementClosingBalance}
            onValueChange={(amount) => {
              set('statementClosingBalance', amount);
            }}
          />
        </Field>
      </form>
    </DialogContent>
  );
}

/**
 * A native date control wired through `Field` — the same construction `money-in/controls.tsx`
 * keeps local, and for the same reason (D-24): a date input is not this screen's to add to
 * the shared component surface, but it must take its id and `aria-describedby` from
 * `useFieldControl` so a `Field` around it behaves as it does around any other control.
 */
function EndDateInput({
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
      onChange={(event) => {
        onChange(event.target.value);
      }}
      className={cx(CONTROL_CLASSES, 'border-border font-mono tabular-nums')}
    />
  );
}
