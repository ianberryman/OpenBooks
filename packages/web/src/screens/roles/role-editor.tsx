import type { ReactElement } from 'react';
import { useEffect, useId, useMemo, useState } from 'react';

import { newIdempotencyKey, presentApiError } from '../../api';
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
import type { PermissionCatalogEntry } from './queries';
import { useCreateRole, usePermissionCatalog, useRoleDetail, useUpdateRole } from './queries';

/**
 * The create/edit dialog (OB-226).
 *
 * ## Why a system role opens the same dialog instead of a separate viewer
 *
 * `AssignableRole.isSystem` is the only thing that changes what this dialog offers: a
 * system role's permissions ship with the product and are not this org's to change, so
 * every control renders `disabled` and there is no footer action but "Close". Building a
 * second, view-only component would duplicate the grouped checklist for no behavioural
 * gain — the fields and the layout are identical, only whether they accept input differs.
 *
 * ## Sensitive keys are a hint, not a gate
 *
 * The five keys named in the ticket (`disbursements.issue`, `journals.reverse`,
 * `periods.close`, `api_keys.write`, `roles.write`) each let a role reach past its own
 * scope — pay someone, undo a posted entry, lock a period, mint a credential, or grant
 * itself more. None of that is refused here: the full catalog is allowed on a custom
 * role, and the server is the actual authority on what a role may hold. The badge exists
 * so an admin composing a role notices what they are granting before they save it, not
 * after someone uses it.
 */
const SENSITIVE_PERMISSION_KEYS: ReadonlySet<string> = new Set([
  'disbursements.issue',
  'journals.reverse',
  'periods.close',
  'api_keys.write',
  'roles.write',
]);

export interface RoleEditorDialogProps {
  readonly open: boolean;
  /** The role being edited, or `null` for "New role". */
  readonly roleId: string | null;
  readonly onOpenChange: (open: boolean) => void;
}

export function RoleEditorDialog({
  open,
  roleId,
  onOpenChange,
}: RoleEditorDialogProps): ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Mounted only while open, `CreateApiKeyDialog`'s pattern — closing and reopening
          for a different role starts this component's state fresh rather than carrying
          the previous role's fields into the next render. */}
      {open && (
        <RoleEditorContent
          roleId={roleId}
          onClose={() => {
            onOpenChange(false);
          }}
        />
      )}
    </Dialog>
  );
}

function RoleEditorContent({
  roleId,
  onClose,
}: {
  readonly roleId: string | null;
  readonly onClose: () => void;
}): ReactElement {
  const formId = useId();
  const isEdit = roleId !== null;

  const detail = useRoleDetail(roleId);
  const catalog = usePermissionCatalog();
  const create = useCreateRole();
  const update = useUpdateRole();
  const mutation = isEdit ? update : create;

  const isSystem = detail.data?.isSystem ?? false;
  const readOnly = isEdit && isSystem;

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [keys, setKeys] = useState<ReadonlySet<string>>(new Set());
  const [prefilled, setPrefilled] = useState(!isEdit);

  useEffect(() => {
    if (prefilled || detail.data === undefined) return;
    setName(detail.data.name);
    setDescription(detail.data.description);
    setKeys(new Set(detail.data.permissionKeys));
    setPrefilled(true);
  }, [prefilled, detail.data]);

  const groups = useMemo(() => {
    const byGroup = new Map<string, PermissionCatalogEntry[]>();
    for (const permission of catalog.data?.permissions ?? []) {
      const existing = byGroup.get(permission.group);
      if (existing === undefined) byGroup.set(permission.group, [permission]);
      else existing.push(permission);
    }
    return Array.from(byGroup.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [catalog.data]);

  function toggleKey(code: string, checked: boolean): void {
    setKeys((previous) => {
      const next = new Set(previous);
      if (checked) next.add(code);
      else next.delete(code);
      return next;
    });
  }

  const fieldErrors = presentApiError(mutation.error).fieldErrors;
  const loading = (isEdit && detail.isPending) || catalog.isPending;

  return (
    <DialogContent
      title={readOnly ? (detail.data?.name ?? 'System role') : isEdit ? 'Edit role' : 'New role'}
      description={
        readOnly
          ? 'A system role is fixed — its permissions ship with the product and cannot be changed here.'
          : 'A name, a description, and any set of permissions this organization wants to grant together.'
      }
      footer={
        readOnly ? (
          <DialogClose asChild>
            <Button>Close</Button>
          </DialogClose>
        ) : (
          <>
            <DialogClose asChild>
              <Button disabled={mutation.isPending}>Cancel</Button>
            </DialogClose>
            <Button
              type="submit"
              form={formId}
              variant="primary"
              disabled={mutation.isPending || !prefilled || name.trim() === ''}
            >
              {mutation.isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Create role'}
            </Button>
          </>
        )
      }
    >
      {detail.isError && <ErrorBanner error={detail.error} />}
      {catalog.isError && <ErrorBanner error={catalog.error} />}

      <form
        id={formId}
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (readOnly) return;
          const body = {
            name: name.trim(),
            description: description.trim(),
            permissionKeys: Array.from(keys),
          };
          if (isEdit && roleId !== null) {
            update.mutate(
              { roleId, ...body, idempotencyKey: newIdempotencyKey() },
              { onSuccess: onClose },
            );
          } else {
            create.mutate({ ...body, idempotencyKey: newIdempotencyKey() }, { onSuccess: onClose });
          }
        }}
      >
        {mutation.isError && <ErrorBanner error={mutation.error} />}

        <Field error={fieldErrors['name']}>
          <FieldLabel>Name</FieldLabel>
          <TextInput
            value={name}
            disabled={readOnly || mutation.isPending}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </Field>

        <Field error={fieldErrors['description']}>
          <FieldLabel>Description</FieldLabel>
          <TextInput
            value={description}
            disabled={readOnly || mutation.isPending}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
          />
        </Field>

        <div className="flex flex-col gap-3">
          <span className="text-sm font-medium text-text">Permissions</span>
          {loading && <p className="text-sm text-text-muted">Loading…</p>}
          {groups.map(([group, permissions]) => (
            <fieldset
              key={group}
              className="flex flex-col gap-1.5 rounded-md border border-border p-3"
            >
              <legend className="px-1 text-xs font-semibold tracking-wide text-text-subtle uppercase">
                {group}
              </legend>
              {permissions.map((permission) => (
                <PermissionCheckbox
                  key={permission.code}
                  permission={permission}
                  checked={keys.has(permission.code)}
                  disabled={readOnly || mutation.isPending}
                  onCheckedChange={(checked) => {
                    toggleKey(permission.code, checked);
                  }}
                />
              ))}
            </fieldset>
          ))}
        </div>
      </form>
    </DialogContent>
  );
}

function PermissionCheckbox({
  permission,
  checked,
  disabled,
  onCheckedChange,
}: {
  readonly permission: PermissionCatalogEntry;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}): ReactElement {
  const sensitive = SENSITIVE_PERMISSION_KEYS.has(permission.code);

  return (
    <label className="flex items-start gap-2 rounded-md px-1 py-1 hover:bg-surface-sunken">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        className="mt-0.5 size-4 shrink-0 rounded-sm border border-border accent-accent"
        onChange={(event) => {
          onCheckedChange(event.target.checked);
        }}
      />
      <span className="flex min-w-0 flex-col">
        <span className="text-sm text-text">
          {permission.code}
          {sensitive && (
            <span className="ml-2 rounded-full border border-warning-border bg-warning-soft px-1.5 py-0.5 text-xs font-medium text-warning-text">
              High-privilege
            </span>
          )}
        </span>
        <span className="text-xs text-text-subtle">{permission.description}</span>
      </span>
    </label>
  );
}
