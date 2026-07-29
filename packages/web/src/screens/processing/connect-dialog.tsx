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
  Select,
  TextInput,
} from '../../components';
import type { ConnectProcessorRequest, ProcessingReferenceData } from './queries';
import { useConnectProcessor, useIntentKey } from './queries';

/**
 * Connecting a payment processor (OB-151; D-82, D-83, D-103).
 *
 * A connection is two existing ledger accounts plus the credentials that let this org's
 * own Stripe or Square talk back to it (`connections.ts`'s "extending D-46's 'a bank
 * account is a ledger account plus import metadata' to a processor"). The clearing and
 * fee accounts are chosen, never created — same reasoning as `bank-accounts/create-
 * dialog.tsx`'s ledger-account picker (D-23).
 *
 * ## The secret fields are write-only, and that is not a styling choice (D-83)
 *
 * `secretKey` and `webhookSecret` are handed straight to `SecretsProvider.put` on the
 * server; the connection row keeps only the names it stored them under, never the
 * values, and `processorConnectionSchema` — every later read of this connection —
 * carries neither field. There is no "shown once at creation" response for either one,
 * unlike an API key: OpenBooks never minted the value, so there is no moment it could
 * show it back. This form reflects that rather than working around it: both fields are
 * plain, uncontrolled-looking password inputs that hold state only until submit, the
 * dialog unmounts on close (clearing the form), and a successful submit closes it too —
 * there is no "connected" screen state that still has the secret sitting in a box.
 */
export interface ConnectProcessorDialogProps {
  readonly open: boolean;
  readonly reference: ProcessingReferenceData;
  readonly onOpenChange: (open: boolean) => void;
}

export function ConnectProcessorDialog({
  open,
  reference,
  onOpenChange,
}: ConnectProcessorDialogProps): ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Mounted only while open, so a cancelled attempt leaves no secret sitting in a
          form that is merely hidden — `bank-accounts/create-dialog.tsx`'s same reason. */}
      {open && (
        <ConnectProcessorForm reference={reference} onConnected={() => onOpenChange(false)} />
      )}
    </Dialog>
  );
}

const PROCESSOR_OPTIONS = [
  { value: 'stripe', label: 'Stripe' },
  { value: 'square', label: 'Square' },
  { value: 'fake', label: 'Fake (test)' },
];

interface FormValues {
  processor: 'stripe' | 'square' | 'fake';
  clearingAccountId: string | null;
  feeAccountId: string | null;
  publishableKey: string;
  secretKey: string;
  webhookSecret: string;
  externalAccountId: string;
}

const INITIAL_VALUES: FormValues = {
  processor: 'stripe',
  clearingAccountId: null,
  feeAccountId: null,
  publishableKey: '',
  secretKey: '',
  webhookSecret: '',
  externalAccountId: '',
};

function ConnectProcessorForm({
  reference,
  onConnected,
}: {
  readonly reference: ProcessingReferenceData;
  readonly onConnected: () => void;
}): ReactElement {
  const formId = useId();
  const [values, setValues] = useState<FormValues>(INITIAL_VALUES);

  const connect = useConnectProcessor();
  const intentKey = useIntentKey();

  const fieldErrors = presentApiError(connect.error).fieldErrors;
  const complete =
    values.clearingAccountId !== null &&
    values.feeAccountId !== null &&
    values.secretKey.trim() !== '' &&
    values.webhookSecret.trim() !== '';

  function set<K extends keyof FormValues>(field: K, value: FormValues[K]): void {
    setValues((current) => ({ ...current, [field]: value }));
  }

  function body(): ConnectProcessorRequest | null {
    if (values.clearingAccountId === null || values.feeAccountId === null) return null;
    const secretKey = values.secretKey.trim();
    const webhookSecret = values.webhookSecret.trim();
    if (secretKey === '' || webhookSecret === '') return null;

    const publishableKey = values.publishableKey.trim();
    const externalAccountId = values.externalAccountId.trim();

    return {
      processor: values.processor,
      clearingAccountId: values.clearingAccountId,
      feeAccountId: values.feeAccountId,
      secretKey,
      webhookSecret,
      // Absent, not empty — `bank-accounts/create-dialog.tsx`'s reason: a blank optional
      // box is the user declining to give one, which is the same thing an omitted field
      // means on the wire.
      ...(publishableKey === '' ? {} : { publishableKey }),
      ...(externalAccountId === '' ? {} : { externalAccountId }),
    };
  }

  function submit(): void {
    const request = body();
    if (request === null) return;
    connect.mutate(
      { ...request, idempotencyKey: intentKey(JSON.stringify(request)) },
      {
        onSuccess: () => {
          // Cleared on submit (D-83): nothing keeps holding the secret once it has been
          // sent, success or not — a retry after a dropped response resends the same
          // values because `intentKey` is fingerprinted on this body, not because the
          // form still shows them.
          setValues(INITIAL_VALUES);
          onConnected();
        },
      },
    );
  }

  return (
    <DialogContent
      title="Connect a payment processor"
      description="Wires a Stripe or Square account to a clearing account and a fee account already in this organization's chart."
      footer={
        <>
          <DialogClose asChild>
            <Button disabled={connect.isPending}>Cancel</Button>
          </DialogClose>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            disabled={connect.isPending || !complete}
          >
            {connect.isPending ? 'Connecting…' : 'Connect processor'}
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
        {connect.isError && <ErrorBanner error={connect.error} />}

        <Field error={fieldErrors['processor']}>
          <FieldLabel>Processor</FieldLabel>
          <Select
            value={values.processor}
            options={PROCESSOR_OPTIONS}
            onValueChange={(value) => {
              if (value === 'stripe' || value === 'square' || value === 'fake') {
                set('processor', value);
              }
            }}
          />
        </Field>

        <Field
          error={fieldErrors['clearingAccountId']}
          hint="Where a charge clears into immediately — before any payout reaches the bank."
        >
          <FieldLabel>Clearing account</FieldLabel>
          <Combobox
            value={values.clearingAccountId}
            options={reference.clearingAccountOptions.map((account) => ({
              value: account.id,
              label: `${account.code} — ${account.name}`,
            }))}
            placeholder="Search asset accounts…"
            onValueChange={(accountId) => {
              set('clearingAccountId', accountId);
            }}
          />
        </Field>

        <Field
          error={fieldErrors['feeAccountId']}
          hint="Where the processor's per-charge fee posts to."
        >
          <FieldLabel>Fee account</FieldLabel>
          <Combobox
            value={values.feeAccountId}
            options={reference.feeAccountOptions.map((account) => ({
              value: account.id,
              label: `${account.code} — ${account.name}`,
            }))}
            placeholder="Search expense accounts…"
            onValueChange={(accountId) => {
              set('feeAccountId', accountId);
            }}
          />
        </Field>

        <Field
          error={fieldErrors['publishableKey']}
          hint="The processor's public, embeddable key, if it has one (Stripe does; not a secret)."
        >
          <FieldLabel>Publishable key (optional)</FieldLabel>
          <TextInput
            value={values.publishableKey}
            onChange={(event) => {
              set('publishableKey', event.target.value);
            }}
          />
        </Field>

        <Field
          error={fieldErrors['secretKey']}
          hint="Stored through the secrets provider and never shown again, on this screen or any other — not even to reveal it here."
        >
          <FieldLabel>Secret key</FieldLabel>
          <TextInput
            type="password"
            autoComplete="off"
            value={values.secretKey}
            onChange={(event) => {
              set('secretKey', event.target.value);
            }}
          />
        </Field>

        <Field
          error={fieldErrors['webhookSecret']}
          hint="The signing secret the webhook receiver verifies inbound events against. Also never shown again once saved."
        >
          <FieldLabel>Webhook secret</FieldLabel>
          <TextInput
            type="password"
            autoComplete="off"
            value={values.webhookSecret}
            onChange={(event) => {
              set('webhookSecret', event.target.value);
            }}
          />
        </Field>

        <Field
          error={fieldErrors['externalAccountId']}
          hint="The processor's own id for the connected account, if it assigns one."
        >
          <FieldLabel>External account id (optional)</FieldLabel>
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
