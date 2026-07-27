import type { ReactElement } from 'react';
import { useId, useState } from 'react';

import { presentApiError } from '../../api';
import {
  Button,
  Combobox,
  Dialog,
  DialogClose,
  DialogContent,
  ErrorBanner,
  Field,
  FieldLabel,
  TextInput,
} from '../../components';
import type { Account, CreateBankAccountBody } from './queries';
import { useCreateBankAccount, useIntentKey, useLedgerAccountOptions } from './queries';

/**
 * Registering a bank account (OB-095; ROADMAP D-46).
 *
 * A bank account is a ledger account plus the import metadata a statement needs (D-46), so
 * the form is exactly that: which ledger account it *is*, what the user calls it, and the
 * two optional bits of institution metadata. The ledger account is chosen, never created —
 * the chart is the org's, and a module that invented an account in it would decide the
 * org's chart on its behalf (D-23); an `accountId` naming nothing is the chart module's own
 * 404, which this form surfaces rather than pre-empts.
 */

export interface CreateBankAccountDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function CreateBankAccountDialog({
  open,
  onOpenChange,
}: CreateBankAccountDialogProps): ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Mounted only while open, so re-opening starts from an empty form rather than from
          whatever the last one was abandoned holding. */}
      {open && <CreateBankAccountForm onCreated={() => onOpenChange(false)} />}
    </Dialog>
  );
}

interface FormValues {
  accountId: string | null;
  name: string;
  institutionName: string;
  externalAccountId: string;
}

function CreateBankAccountForm({ onCreated }: { readonly onCreated: () => void }): ReactElement {
  const formId = useId();
  const [values, setValues] = useState<FormValues>({
    accountId: null,
    name: '',
    institutionName: '',
    externalAccountId: '',
  });

  const ledgerAccounts = useLedgerAccountOptions();
  const create = useCreateBankAccount();
  const intentKey = useIntentKey();

  const fieldErrors = presentApiError(create.error).fieldErrors;
  const complete = values.accountId !== null && values.name.trim() !== '';

  function set<K extends keyof FormValues>(field: K, value: FormValues[K]): void {
    setValues((current) => ({ ...current, [field]: value }));
  }

  function body(): CreateBankAccountBody | null {
    if (values.accountId === null || values.name.trim() === '') return null;
    const institution = values.institutionName.trim();
    const external = values.externalAccountId.trim();
    return {
      accountId: values.accountId,
      name: values.name.trim(),
      // Absent, not empty: the field is `string | null` on the wire, and a blank box is the
      // user declining to give one — which is `null`, the same thing an omitted field means.
      ...(institution === '' ? {} : { institutionName: institution }),
      ...(external === '' ? {} : { externalAccountId: external }),
    };
  }

  function submit(): void {
    const request = body();
    if (request === null) return;
    create.mutate(
      { ...request, idempotencyKey: intentKey(JSON.stringify(request)) },
      { onSuccess: onCreated },
    );
  }

  const options = (ledgerAccounts.data ?? []).map((account: Account) => ({
    value: account.id,
    label: `${account.code} — ${account.name}`,
  }));

  return (
    <DialogContent
      title="Register a bank account"
      description="A ledger account plus the metadata a statement import needs. Its balance is the ledger account's — there is no second figure here."
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
            {create.isPending ? 'Registering…' : 'Register bank account'}
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
          error={fieldErrors['accountId']}
          hint="The ledger account this bank account is. Its balance is what reconciliation tests a statement against."
        >
          <FieldLabel>Ledger account</FieldLabel>
          <Combobox
            value={values.accountId}
            options={options}
            placeholder="Search asset accounts…"
            onValueChange={(accountId) => {
              set('accountId', accountId);
            }}
          />
        </Field>

        <Field error={fieldErrors['name']} hint="What you call this account — “Barclays Current”.">
          <FieldLabel>Name</FieldLabel>
          <TextInput
            value={values.name}
            onChange={(event) => {
              set('name', event.target.value);
            }}
          />
        </Field>

        <Field error={fieldErrors['institutionName']}>
          <FieldLabel>Institution (optional)</FieldLabel>
          <TextInput
            value={values.institutionName}
            onChange={(event) => {
              set('institutionName', event.target.value);
            }}
          />
        </Field>

        <Field
          error={fieldErrors['externalAccountId']}
          hint="What the bank’s own file calls this account — OFX’s ACCTID. Held so an upload can be checked against the account it is imported into."
        >
          <FieldLabel>Bank’s account identifier (optional)</FieldLabel>
          <TextInput
            value={values.externalAccountId}
            onChange={(event) => {
              set('externalAccountId', event.target.value);
            }}
          />
        </Field>
      </form>
    </DialogContent>
  );
}
