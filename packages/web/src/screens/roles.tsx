import type { ReactElement } from 'react';
import { useState } from 'react';

import { Button, ErrorBanner } from '../components';
import { RoleList } from './roles/list';
import { RoleEditorDialog } from './roles/role-editor';
import { useRoleList } from './roles/queries';
import type { AssignableRole } from './roles/queries';

/**
 * Custom, per-org role builder (OB-226).
 *
 * The seeded system roles (`isSystem: true`) exist so an org never starts with nothing to
 * assign; a custom role composes any set of permission-catalog keys this org wants to
 * grant together, under one name. Both live in the same list — `GET /v1/roles` draws no
 * distinction — because they are the same kind of thing to a member picker or an invite
 * form: a role to hold, not two separate concepts.
 */
export interface RolesEditorState {
  readonly open: boolean;
  /** The role being edited, or `null` for "New role". */
  readonly roleId: string | null;
}

export function RolesScreen(): ReactElement {
  const [editor, setEditor] = useState<RolesEditorState>({ open: false, roleId: null });

  const list = useRoleList();
  const roles = list.data?.roles ?? [];

  function openEditor(role: AssignableRole | null): void {
    setEditor({ open: true, roleId: role?.id ?? null });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-text">Roles</h1>
          <p className="max-w-form text-text-muted">
            The seeded system roles are fixed by the product; a custom role composes any set of
            permissions this organization wants to grant together, under its own name.
          </p>
        </div>
        <Button
          variant="primary"
          onClick={() => {
            openEditor(null);
          }}
        >
          New role
        </Button>
      </div>

      {list.error != null && (
        <ErrorBanner
          error={list.error}
          onRetry={() => {
            void list.refetch();
          }}
        />
      )}

      <RoleList roles={roles} loading={list.isPending} onEdit={openEditor} />

      <RoleEditorDialog
        open={editor.open}
        roleId={editor.roleId}
        onOpenChange={(open) => {
          setEditor((previous) => ({ ...previous, open }));
        }}
      />
    </div>
  );
}
