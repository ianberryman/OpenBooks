import type { ReactElement } from 'react';
import { useId, useState } from 'react';

import { presentApiError } from '../../api';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  ErrorBanner,
  Field,
  FieldLabel,
  Select,
  TextInput,
} from '../../components';
import type { ApiKeyWithSecret, AssignableRole } from './queries';
import { useCreateApiKey, useIntentKey } from './queries';

/**
 * Issuing a key — and the one screen where the full opaque value exists at all (D-61).
 *
 * ## Why this is one dialog with two steps, not a dialog plus a second one
 *
 * A key issued and then re-opened to "view" it would be a lie: `ApiKeyWithSecret.key`
 * "is not recoverable" (the schema's own words) — every later read is `ApiKey`, which has
 * no `key` field at all. So there is exactly one moment this screen can ever show the
 * value, and it is the response of the create call that is still in memory. Holding that
 * response in this dialog's own state — rather than routing it back through the list and
 * a second dialog keyed off some row — is what keeps that moment from ever needing a
 * fetch that could not succeed.
 *
 * Closing the dialog (by any path — the close button, the overlay, Escape) discards the
 * secret step's state along with the rest of the dialog's, per `TemplateFormDialog`'s
 * `key`-per-open pattern: nothing here persists the value anywhere it could be read back.
 */
export interface CreateApiKeyDialogProps {
  readonly open: boolean;
  readonly roles: readonly AssignableRole[];
  readonly onOpenChange: (open: boolean) => void;
}

export function CreateApiKeyDialog({
  open,
  roles,
  onOpenChange,
}: CreateApiKeyDialogProps): ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <CreateApiKeyContent
          roles={roles}
          onClose={() => {
            onOpenChange(false);
          }}
        />
      )}
    </Dialog>
  );
}

function CreateApiKeyContent({
  roles,
  onClose,
}: {
  readonly roles: readonly AssignableRole[];
  readonly onClose: () => void;
}): ReactElement {
  const formId = useId();
  const [name, setName] = useState('');
  const [roleId, setRoleId] = useState<string | null>(null);
  const [created, setCreated] = useState<ApiKeyWithSecret | null>(null);

  const create = useCreateApiKey();
  const intentKey = useIntentKey();

  const fieldErrors = presentApiError(create.error).fieldErrors;
  const roleOptions = roles.map((role) => ({ value: role.id, label: role.name }));

  if (created !== null) {
    return <RevealedKey apiKey={created} onDone={onClose} />;
  }

  return (
    <DialogContent
      title="Issue an API key"
      description="A name to tell it apart by, and the role it authenticates as — not your own role (D-55)."
      footer={
        <>
          <DialogClose asChild>
            <Button disabled={create.isPending}>Cancel</Button>
          </DialogClose>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            disabled={create.isPending || name.trim() === '' || roleId === null}
          >
            {create.isPending ? 'Issuing…' : 'Issue key'}
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
          if (roleId === null) return;
          create.mutate(
            { name: name.trim(), roleId, idempotencyKey: intentKey(`create:${name}:${roleId}`) },
            {
              onSuccess: (issued) => {
                setCreated(issued);
              },
            },
          );
        }}
      >
        {create.isError && <ErrorBanner error={create.error} />}

        <Field error={fieldErrors['name']} hint="e.g. Nightly import job.">
          <FieldLabel>Name</FieldLabel>
          <TextInput
            value={name}
            disabled={create.isPending}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </Field>

        <Field
          error={fieldErrors['roleId']}
          hint="The key's effective permissions are exactly this role's."
        >
          <FieldLabel>Role</FieldLabel>
          <Select
            value={roleId}
            options={roleOptions}
            disabled={create.isPending}
            onValueChange={(value) => {
              setRoleId(value);
            }}
          />
        </Field>
      </form>
    </DialogContent>
  );
}

/**
 * The secret-reveal panel: the full opaque key, shown exactly once, with a plain
 * "copy it now" affordance rather than a confirmation the user has to reason about — the
 * value is gone from every later screen the instant this dialog closes.
 */
function RevealedKey({
  apiKey,
  onDone,
}: {
  readonly apiKey: ApiKeyWithSecret;
  readonly onDone: () => void;
}): ReactElement {
  const [copied, setCopied] = useState(false);

  return (
    <DialogContent
      title="Key issued"
      description={`"${apiKey.name}" is ready. Copy the key now — it will not be shown again.`}
      footer={
        <Button variant="primary" onClick={onDone}>
          I've saved it — close
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="rounded-md border border-border bg-surface-sunken p-3">
          <code className="block font-mono text-sm break-all text-text select-all">
            {apiKey.key}
          </code>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            onClick={() => {
              void navigator.clipboard.writeText(apiKey.key).then(() => {
                setCopied(true);
              });
            }}
          >
            {copied ? 'Copied' : 'Copy to clipboard'}
          </Button>
          <p className="text-xs text-text-subtle">
            Losing it means issuing a new one — the server keeps only a hash, never this value.
          </p>
        </div>
      </div>
    </DialogContent>
  );
}
