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
import type { BankAccount, BankFeedLinkSession, ConnectBankFeedBody } from './queries';
import { useBankFeedLinkSession, useConnectBankFeed, useIntentKey } from './queries';

/**
 * Connecting a live bank feed (OB-227; D-126, D-131).
 *
 * A feed is an existing bank account plus the org's own Stripe Financial Connections
 * restricted key (`connections.service.ts`'s "a bank account plus the credential that lets
 * this org's own Stripe pull its statement") — the analog of `processing/connect-dialog.tsx`,
 * where a connection is two ledger accounts plus a secret. The bank account is chosen, never
 * created — same reasoning as that dialog's account pickers.
 *
 * ## Two steps, because the account id is discovered, not typed (D-131)
 *
 * Unlike a processor connection, a feed names a specific `externalAccountId` at the provider,
 * and no user knows theirs by hand. So the credential opens a *link session* first
 * (`POST /v1/bank-feeds/link-sessions`), which lists the accounts the key can already pull;
 * the user picks one, and only then does `POST /v1/bank-feeds` connect it. The chosen row
 * carries the `externalAccountId` and `institution` the connect body needs.
 *
 * ## The restricted key is write-only, and that is not a styling choice (D-83)
 *
 * `restrictedKey` is handed to the secrets provider on the server and never echoed by any
 * response. The dialog reflects that: the key is a password input held only until submit,
 * the dialog unmounts on close (clearing the form), and a successful connect closes it — no
 * "connected" state keeps the key sitting in a box.
 */
export interface ConnectBankFeedDialogProps {
  readonly open: boolean;
  readonly bankAccounts: readonly BankAccount[];
  readonly onOpenChange: (open: boolean) => void;
}

export function ConnectBankFeedDialog({
  open,
  bankAccounts,
  onOpenChange,
}: ConnectBankFeedDialogProps): ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Mounted only while open, so a cancelled attempt leaves no restricted key sitting in a
          form that is merely hidden — `processing/connect-dialog.tsx`'s same reason. */}
      {open && (
        <ConnectBankFeedForm bankAccounts={bankAccounts} onConnected={() => onOpenChange(false)} />
      )}
    </Dialog>
  );
}

const FEED_SOURCE_OPTIONS = [
  { value: 'stripe_financial_connections', label: 'Stripe Financial Connections' },
  { value: 'fake', label: 'Fake (test)' },
];

type FeedSource = 'stripe_financial_connections' | 'fake';
type LinkedAccount = BankFeedLinkSession['linkedAccounts'][number];

interface FormValues {
  bankAccountId: string | null;
  feedSource: FeedSource;
  restrictedKey: string;
  externalAccountId: string | null;
}

const INITIAL_VALUES: FormValues = {
  bankAccountId: null,
  feedSource: 'stripe_financial_connections',
  restrictedKey: '',
  externalAccountId: null,
};

function ConnectBankFeedForm({
  bankAccounts,
  onConnected,
}: {
  readonly bankAccounts: readonly BankAccount[];
  readonly onConnected: () => void;
}): ReactElement {
  const formId = useId();
  const [values, setValues] = useState<FormValues>(INITIAL_VALUES);
  const [linkedAccounts, setLinkedAccounts] = useState<readonly LinkedAccount[] | null>(null);

  const linkSession = useBankFeedLinkSession();
  const connect = useConnectBankFeed();
  const intentKey = useIntentKey();

  // The step is derived, not a second piece of state to keep in sync: no linked accounts yet
  // means the credentials step; a list back from the link session means the pick step.
  const step: 'credentials' | 'pick' = linkedAccounts === null ? 'credentials' : 'pick';

  const linkErrors = presentApiError(linkSession.error).fieldErrors;
  const connectErrors = presentApiError(connect.error).fieldErrors;

  const credentialsComplete = values.bankAccountId !== null && values.restrictedKey.trim() !== '';

  function set<K extends keyof FormValues>(field: K, value: FormValues[K]): void {
    setValues((current) => ({ ...current, [field]: value }));
  }

  function findAccounts(): void {
    if (values.bankAccountId === null) return;
    const restrictedKey = values.restrictedKey.trim();
    if (restrictedKey === '') return;

    const request = { feedSource: values.feedSource, restrictedKey };
    linkSession.mutate(
      { ...request, idempotencyKey: intentKey(`link:${JSON.stringify(request)}`) },
      {
        onSuccess: (session) => {
          setLinkedAccounts(session.linkedAccounts);
          set('externalAccountId', session.linkedAccounts[0]?.externalAccountId ?? null);
        },
      },
    );
  }

  function connectBody(): ConnectBankFeedBody | null {
    if (values.bankAccountId === null || values.externalAccountId === null) return null;
    const restrictedKey = values.restrictedKey.trim();
    if (restrictedKey === '') return null;

    const chosen = (linkedAccounts ?? []).find(
      (account) => account.externalAccountId === values.externalAccountId,
    );

    return {
      bankAccountId: values.bankAccountId,
      feedSource: values.feedSource,
      restrictedKey,
      externalAccountId: values.externalAccountId,
      // The institution the provider reported for the chosen account, when it named one —
      // absent, not empty, when it did not (`processing/connect-dialog.tsx`'s reason).
      ...(chosen?.institution == null ? {} : { institution: chosen.institution }),
    };
  }

  function submit(): void {
    if (step === 'credentials') {
      findAccounts();
      return;
    }
    const request = connectBody();
    if (request === null) return;
    connect.mutate(
      { ...request, idempotencyKey: intentKey(`connect:${JSON.stringify(request)}`) },
      {
        onSuccess: () => {
          // Cleared on submit (D-83): nothing keeps holding the key once it has been sent.
          setValues(INITIAL_VALUES);
          setLinkedAccounts(null);
          onConnected();
        },
      },
    );
  }

  const bankAccountOptions = bankAccounts.map((account) => ({
    value: account.id,
    label: account.name,
  }));

  const pending = linkSession.isPending || connect.isPending;

  return (
    <DialogContent
      title="Connect a bank feed"
      description="Links this organization's own Stripe Financial Connections credential to an existing bank account. A daily job then imports its transactions. The key is stored securely and never shown again."
      footer={
        <>
          <DialogClose asChild>
            <Button disabled={pending}>Cancel</Button>
          </DialogClose>
          {step === 'pick' && (
            <Button
              disabled={pending}
              onClick={() => {
                setLinkedAccounts(null);
              }}
            >
              Back
            </Button>
          )}
          <Button
            type="submit"
            form={formId}
            variant="primary"
            disabled={
              pending ||
              (step === 'credentials' ? !credentialsComplete : values.externalAccountId === null)
            }
          >
            {step === 'credentials'
              ? linkSession.isPending
                ? 'Finding accounts…'
                : 'Find accounts'
              : connect.isPending
                ? 'Connecting…'
                : 'Connect feed'}
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
        {linkSession.isError && <ErrorBanner error={linkSession.error} />}
        {connect.isError && <ErrorBanner error={connect.error} />}

        {step === 'credentials' ? (
          <>
            <Field
              error={connectErrors['bankAccountId']}
              hint="The bank account this feed imports into. Its balance is the ledger account's — the feed only supplies the lines."
            >
              <FieldLabel>Bank account</FieldLabel>
              <Combobox
                value={values.bankAccountId}
                options={bankAccountOptions}
                placeholder="Search bank accounts…"
                onValueChange={(bankAccountId) => {
                  set('bankAccountId', bankAccountId);
                }}
              />
            </Field>

            <Field error={linkErrors['feedSource']}>
              <FieldLabel>Feed source</FieldLabel>
              <Select
                value={values.feedSource}
                options={FEED_SOURCE_OPTIONS}
                onValueChange={(value) => {
                  if (value === 'stripe_financial_connections' || value === 'fake') {
                    set('feedSource', value);
                  }
                }}
              />
            </Field>

            <Field
              error={linkErrors['restrictedKey']}
              hint="This organization's own Stripe Financial Connections restricted key. Stored through the secrets provider and never shown again, on this screen or any other."
            >
              <FieldLabel>Restricted key</FieldLabel>
              <TextInput
                type="password"
                autoComplete="off"
                value={values.restrictedKey}
                onChange={(event) => {
                  set('restrictedKey', event.target.value);
                }}
              />
            </Field>
          </>
        ) : (
          <Field
            error={connectErrors['externalAccountId']}
            hint="The accounts this credential can already pull. Pick the one to import into the bank account above."
          >
            <FieldLabel>Account to connect</FieldLabel>
            <Select
              value={values.externalAccountId ?? ''}
              options={(linkedAccounts ?? []).map((account) => ({
                value: account.externalAccountId,
                label:
                  account.institution === null
                    ? account.displayName
                    : `${account.displayName} — ${account.institution}`,
              }))}
              onValueChange={(externalAccountId) => {
                set('externalAccountId', externalAccountId);
              }}
            />
          </Field>
        )}
      </form>
    </DialogContent>
  );
}
