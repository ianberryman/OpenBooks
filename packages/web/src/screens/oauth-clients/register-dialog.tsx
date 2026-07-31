import type { ChangeEvent, ReactElement } from 'react';
import { useId, useState } from 'react';

import { presentApiError } from '../../api';
import {
  Button,
  CONTROL_CLASSES,
  Dialog,
  DialogClose,
  DialogContent,
  ErrorBanner,
  Field,
  FieldLabel,
  TextInput,
  useFieldControl,
} from '../../components';
import { cx } from '../../lib/cx';
import type { OAuthClientWithSecret } from './queries';
import { useIntentKey, useRegisterOAuthClient } from './queries';

/**
 * Registering a third-party client — and the one screen where `clientSecret` exists at all
 * (D-61). Two steps in one dialog, for the same reason `api-keys/create-dialog.tsx` is one
 * dialog and not two: `OAuthClientWithSecret.clientSecret` "is not recoverable" (the
 * schema's own words), every later read is a plain `OAuthClient` with no secret field, and
 * the only copy of the value that will ever exist is the create response still held in this
 * dialog's own state.
 *
 * One redirect URI per line, parsed on submit rather than as a repeating field-array
 * control: `RegisterOAuthClientRequest.redirectUris` is usually one value and rarely more
 * than two, and a line-per-entry textarea reads and edits as easily as a list of inputs
 * with add/remove buttons would, for a fraction of the state.
 */
export interface RegisterOAuthClientDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function RegisterOAuthClientDialog({
  open,
  onOpenChange,
}: RegisterOAuthClientDialogProps): ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <RegisterOAuthClientContent
          onClose={() => {
            onOpenChange(false);
          }}
        />
      )}
    </Dialog>
  );
}

function parseRedirectUris(raw: string): readonly string[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

function RegisterOAuthClientContent({ onClose }: { readonly onClose: () => void }): ReactElement {
  const formId = useId();
  const [name, setName] = useState('');
  const [redirectUrisText, setRedirectUrisText] = useState('');
  const [registered, setRegistered] = useState<OAuthClientWithSecret | null>(null);

  const register = useRegisterOAuthClient();
  const intentKey = useIntentKey();

  const fieldErrors = presentApiError(register.error).fieldErrors;
  const redirectUris = parseRedirectUris(redirectUrisText);

  if (registered !== null) {
    return <RevealedSecret client={registered} onDone={onClose} />;
  }

  return (
    <DialogContent
      title="Register an OAuth client"
      description="A display name shown on the consent screen, and every redirect URI it may be sent back to."
      footer={
        <>
          <DialogClose asChild>
            <Button disabled={register.isPending}>Cancel</Button>
          </DialogClose>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            disabled={register.isPending || name.trim() === '' || redirectUris.length === 0}
          >
            {register.isPending ? 'Registering…' : 'Register client'}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (redirectUris.length === 0) return;
          const body = { name: name.trim(), redirectUris: [...redirectUris] };
          register.mutate(
            { ...body, idempotencyKey: intentKey(`register:${JSON.stringify(body)}`) },
            {
              onSuccess: (issued) => {
                setRegistered(issued);
              },
            },
          );
        }}
      >
        {register.isError && <ErrorBanner error={register.error} />}

        <Field error={fieldErrors['name']} hint="Shown to a user on the consent screen.">
          <FieldLabel>Name</FieldLabel>
          <TextInput
            value={name}
            disabled={register.isPending}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </Field>

        <Field
          error={fieldErrors['redirectUris']}
          hint="One per line. A request naming any URI outside this set is refused."
        >
          <FieldLabel>Redirect URIs</FieldLabel>
          <RedirectUrisTextArea
            value={redirectUrisText}
            disabled={register.isPending}
            onChange={(event) => {
              setRedirectUrisText(event.target.value);
            }}
          />
        </Field>
      </form>
    </DialogContent>
  );
}

function RedirectUrisTextArea({
  value,
  disabled,
  onChange,
}: {
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
}): ReactElement {
  const control = useFieldControl();
  return (
    <textarea
      {...control}
      value={value}
      disabled={disabled}
      rows={3}
      placeholder={'https://app.example.com/oauth/callback'}
      className={cx(CONTROL_CLASSES, 'h-auto border-border py-1.5 font-mono text-sm')}
      onChange={onChange}
    />
  );
}

function RevealedSecret({
  client,
  onDone,
}: {
  readonly client: OAuthClientWithSecret;
  readonly onDone: () => void;
}): ReactElement {
  const [copied, setCopied] = useState(false);

  return (
    <DialogContent
      title="Client registered"
      description={`"${client.name}" is ready. Copy the client secret now — it will not be shown again.`}
      footer={
        <Button variant="primary" onClick={onDone}>
          I've saved it — close
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-text">Client ID</p>
          <div className="rounded-md border border-border bg-surface-sunken p-3">
            <code className="block font-mono text-sm break-all text-text select-all">
              {client.clientId}
            </code>
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-text">Client secret</p>
          <div className="rounded-md border border-border bg-surface-sunken p-3">
            <code className="block font-mono text-sm break-all text-text select-all">
              {client.clientSecret}
            </code>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            onClick={() => {
              void navigator.clipboard.writeText(client.clientSecret).then(() => {
                setCopied(true);
              });
            }}
          >
            {copied ? 'Copied' : 'Copy secret to clipboard'}
          </Button>
          <p className="text-xs text-text-subtle">
            Losing it means re-registering the client — the server keeps no copy.
          </p>
        </div>
      </div>
    </DialogContent>
  );
}
