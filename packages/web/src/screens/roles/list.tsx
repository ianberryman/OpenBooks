import type { ReactElement } from 'react';
import { useState } from 'react';

import { newIdempotencyKey } from '../../api';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  ErrorBanner,
  Pill,
  ResponsiveTable,
} from '../../components';
import { cx } from '../../lib/cx';
import { EmptyRow, TABLE_CLASSES, TD_CLASSES, TH_CLASSES } from '../settings/section';
import type { AssignableRole } from './queries';
import { useDeleteRole } from './queries';

/**
 * Every role this org may grant — seeded system roles and this org's custom ones,
 * together (`GET /v1/roles`'s own shape draws no distinction). `isSystem` is the only
 * thing that changes what a row offers: a system role's permissions ship with the
 * product, so it gets a view-only editor and no delete at all, never a disabled button
 * with no explanation.
 */
export interface RoleListProps {
  readonly roles: readonly AssignableRole[];
  readonly loading: boolean;
  readonly onEdit: (role: AssignableRole) => void;
}

export function RoleList({ roles, loading, onEdit }: RoleListProps): ReactElement {
  const [pendingDelete, setPendingDelete] = useState<AssignableRole | null>(null);
  const remove = useDeleteRole();

  return (
    <>
      <ResponsiveTable>
        <table className={TABLE_CLASSES}>
          <caption className="sr-only">Roles</caption>
          <thead>
            <tr>
              <th scope="col" className={TH_CLASSES}>
                Name
              </th>
              <th scope="col" className={TH_CLASSES}>
                Description
              </th>
              <th scope="col" className={TH_CLASSES}>
                Type
              </th>
              <th scope="col" className={cx(TH_CLASSES, 'text-right')}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {roles.length === 0 && (
              <EmptyRow columns={4}>{loading ? 'Loading…' : 'No roles yet.'}</EmptyRow>
            )}
            {roles.map((role) => (
              <tr key={role.id}>
                <td className={TD_CLASSES}>{role.name}</td>
                <td className={cx(TD_CLASSES, 'text-text-muted')}>{role.description}</td>
                <td className={TD_CLASSES}>
                  <Pill tone={role.isSystem ? 'neutral' : 'accent'}>
                    {role.isSystem ? 'System' : 'Custom'}
                  </Pill>
                </td>
                <td className={cx(TD_CLASSES, 'text-right')}>
                  <div className="flex justify-end gap-2">
                    <Button
                      size="sm"
                      aria-label={`${role.isSystem ? 'View' : 'Edit'} ${role.name}`}
                      onClick={() => {
                        onEdit(role);
                      }}
                    >
                      {role.isSystem ? 'View' : 'Edit'}
                    </Button>
                    {!role.isSystem && (
                      <Button
                        size="sm"
                        variant="danger"
                        aria-label={`Delete ${role.name}`}
                        onClick={() => {
                          remove.reset();
                          setPendingDelete(role);
                        }}
                      >
                        Delete
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ResponsiveTable>

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <DialogContent
          title="Delete role"
          description="A role nobody currently holds is removed for good. One still assigned to a member is refused — reassign everyone holding it first."
          footer={
            <>
              <DialogClose asChild>
                <Button disabled={remove.isPending}>Cancel</Button>
              </DialogClose>
              <Button
                variant="danger"
                disabled={remove.isPending}
                onClick={() => {
                  if (pendingDelete === null) return;
                  remove.mutate(
                    { roleId: pendingDelete.id, idempotencyKey: newIdempotencyKey() },
                    { onSuccess: () => setPendingDelete(null) },
                  );
                }}
              >
                {remove.isPending ? 'Deleting…' : 'Delete'}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            <p className="text-sm text-text">
              {pendingDelete?.name ?? 'This role'} will no longer be available to grant.
            </p>
            {remove.isError && <ErrorBanner error={remove.error} />}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
