import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { StubRoute } from './test-support';
import { installApiStub, renderWithQueryClient } from './test-support';

/**
 * The custom, per-org role builder (OB-226).
 *
 * Four things are worth a test:
 *
 * 1. **The list shows every role, system and custom, with which is which** — the badge is
 *    the only signal a row gives before a click, and it is what decides whether the row
 *    offers "Edit"/"Delete" or a read-only "View".
 * 2. **The editor's checklist comes from the permission catalog, grouped by `group`, and
 *    ticking keys plus submitting sends exactly the ticked set** — never a value invented
 *    by this screen.
 * 3. **Editing prefills from `RoleDetail`, not from the row already on screen** — the list
 *    only carries `{id,code,name,description,isSystem}`; the permission set is a second
 *    fetch, and the test is really asserting that fetch happens and wins.
 * 4. **Deleting a custom role posts to the delete route** — and a system role never offers
 *    the control that would reach it.
 */
const { RolesScreen } = await import('../roles');

const SYSTEM_ROLE_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOM_ROLE_ID = '22222222-2222-4222-8222-222222222222';

const SYSTEM_ROLE = {
  id: SYSTEM_ROLE_ID,
  code: 'read_only',
  name: 'Read-only',
  description: 'Read access only.',
  isSystem: true,
};

const CUSTOM_ROLE = {
  id: CUSTOM_ROLE_ID,
  code: 'custom_reviewer',
  name: 'Reviewer',
  description: 'Reviews entries before they post.',
  isSystem: false,
};

const PERMISSIONS = [
  { code: 'journals.read', description: 'Read journal entries.', group: 'Ledger' },
  { code: 'journals.reverse', description: 'Reverse a posted entry.', group: 'Ledger' },
  { code: 'roles.write', description: 'Manage roles.', group: 'Settings' },
];

function rolesRoute(
  roles: readonly Record<string, unknown>[] = [SYSTEM_ROLE, CUSTOM_ROLE],
): StubRoute {
  return {
    method: 'GET',
    path: '/v1/roles',
    reply: () => ({ status: 200, body: { roles } }),
  };
}

function permissionsRoute(): StubRoute {
  return {
    method: 'GET',
    path: '/v1/permissions',
    reply: () => ({ status: 200, body: { permissions: PERMISSIONS } }),
  };
}

function roleDetailRoute(
  role: Record<string, unknown>,
  permissionKeys: readonly string[],
): StubRoute {
  return {
    method: 'GET',
    path: '/v1/roles/:roleId',
    reply: () => ({ status: 200, body: { ...role, permissionKeys } }),
  };
}

describe('RolesScreen', () => {
  it('lists system and custom roles with which is which', async () => {
    installApiStub([rolesRoute(), permissionsRoute()]);
    renderWithQueryClient(<RolesScreen />);

    expect(await screen.findByText('Read-only')).toBeInTheDocument();
    expect(screen.getByText('Reviewer')).toBeInTheDocument();
    expect(screen.getByText('System')).toBeInTheDocument();
    expect(screen.getByText('Custom')).toBeInTheDocument();

    // A system role offers only a viewer; a custom one offers both edit and delete.
    expect(screen.getByRole('button', { name: 'View Read-only' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete Read-only' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit Reviewer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete Reviewer' })).toBeInTheDocument();
  });

  it('groups the checklist by permission group and posts exactly the ticked keys', async () => {
    const stub = installApiStub([
      rolesRoute(),
      permissionsRoute(),
      {
        method: 'POST',
        path: '/v1/roles',
        reply: ({ body }) => ({
          status: 201,
          body: { ...(body as object), id: 'new-role', isSystem: false },
        }),
      },
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<RolesScreen />);

    await user.click(await screen.findByRole('button', { name: 'New role' }));

    const dialog = await screen.findByRole('dialog', { name: 'New role' });
    expect(within(dialog).getByText('Ledger')).toBeInTheDocument();
    expect(within(dialog).getByText('Settings')).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText('Name'), 'Reviewer');
    await user.type(within(dialog).getByLabelText('Description'), 'Reviews entries.');
    await user.click(within(dialog).getByRole('checkbox', { name: /journals\.read/ }));
    await user.click(within(dialog).getByRole('checkbox', { name: /roles\.write/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Create role' }));

    await waitFor(() => {
      expect(stub.keysFor('POST', '/v1/roles')).toHaveLength(1);
    });
    const created = stub.calls.find((call) => call.method === 'POST');
    expect(created?.body).toEqual({
      name: 'Reviewer',
      description: 'Reviews entries.',
      permissionKeys: ['journals.read', 'roles.write'],
    });
    expect(created?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('prefills the editor from RoleDetail, not from the row already on screen', async () => {
    installApiStub([
      rolesRoute(),
      permissionsRoute(),
      roleDetailRoute(CUSTOM_ROLE, ['journals.reverse']),
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<RolesScreen />);

    await user.click(await screen.findByRole('button', { name: 'Edit Reviewer' }));

    const dialog = await screen.findByRole('dialog', { name: 'Edit role' });
    await waitFor(() => {
      expect(within(dialog).getByLabelText('Name')).toHaveValue('Reviewer');
    });
    expect(within(dialog).getByLabelText('Description')).toHaveValue(
      'Reviews entries before they post.',
    );
    expect(within(dialog).getByRole('checkbox', { name: /journals\.reverse/ })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: /journals\.read/ })).not.toBeChecked();
  });

  it('renders a system role read-only, with no save action', async () => {
    installApiStub([
      rolesRoute(),
      permissionsRoute(),
      roleDetailRoute(SYSTEM_ROLE, ['journals.read']),
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<RolesScreen />);

    await user.click(await screen.findByRole('button', { name: 'View Read-only' }));

    const dialog = await screen.findByRole('dialog', { name: 'Read-only' });
    await waitFor(() => {
      expect(within(dialog).getByRole('checkbox', { name: /journals\.read/ })).toBeChecked();
    });
    expect(within(dialog).getByLabelText('Name')).toBeDisabled();
    expect(within(dialog).getByRole('checkbox', { name: /journals\.read/ })).toBeDisabled();
    expect(
      within(dialog).queryByRole('button', { name: /Create role|Save changes/ }),
    ).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('deletes a custom role through the delete route, after a confirm', async () => {
    const stub = installApiStub([
      rolesRoute(),
      permissionsRoute(),
      {
        method: 'DELETE',
        path: '/v1/roles/:roleId',
        reply: () => ({ status: 204 }),
      },
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<RolesScreen />);

    await user.click(await screen.findByRole('button', { name: 'Delete Reviewer' }));

    const dialog = await screen.findByRole('dialog', { name: 'Delete role' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(stub.calls.some((call) => call.method === 'DELETE')).toBe(true);
    });
    const deleted = stub.calls.find((call) => call.method === 'DELETE');
    expect(deleted?.path).toBe(`/v1/roles/${CUSTOM_ROLE_ID}`);
    expect(deleted?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });
});
