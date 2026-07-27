import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { StubRoute } from './test-support';
import { installApiStub, preconditionFailed, renderWithQueryClient } from './test-support';

/**
 * Members and invitations (OB-050; spec §5).
 *
 * The case worth the harness is the **last Owner**. The server refuses both the demotion
 * and the removal under a lock on the Owner set, and the failure it prevents — an
 * organization with no Owner, which nobody can administer and which no support path
 * reaches into a tenant to repair — is one a user has no reason to anticipate. So both
 * halves are tested: the sole Owner's controls are inert and say why, *and* the refusal is
 * still rendered legibly when it arrives anyway, which is the race where another
 * administrator demoted the other Owner a moment ago.
 *
 * `emailDelivered: false` is the other one. It is not an error and must not be presented as
 * one: the invitation is valid and nobody was told, which is what a self-host install on
 * the log email provider does every time (D-31).
 */
const { MembersSection } = await import('./members');

const ROLES = [
  { id: 'role-owner', code: 'owner', name: 'Owner', description: 'Everything', isSystem: true },
  {
    id: 'role-bookkeeper',
    code: 'bookkeeper',
    name: 'Bookkeeper',
    description: 'Day-to-day',
    isSystem: true,
  },
];

interface Member {
  userId: string;
  email: string;
  displayName: string;
  roleId: string;
  roleCode: string;
  roleName: string;
  isActive: boolean;
  invitedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

function member(name: string, role: (typeof ROLES)[number]): Member {
  return {
    userId: `user-${name.toLowerCase()}`,
    email: `${name.toLowerCase()}@example.com`,
    displayName: name,
    roleId: role.id,
    roleCode: role.code,
    roleName: role.name,
    isActive: true,
    invitedByUserId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const ADA = member('Ada', ROLES[0] as (typeof ROLES)[number]);
const GRACE = member('Grace', ROLES[0] as (typeof ROLES)[number]);
const BOB = member('Bob', ROLES[1] as (typeof ROLES)[number]);

function listRoutes(members: readonly Member[], invites: readonly unknown[] = []): StubRoute[] {
  return [
    { method: 'GET', path: '/v1/members', reply: () => ({ status: 200, body: { members } }) },
    { method: 'GET', path: '/v1/roles', reply: () => ({ status: 200, body: { roles: ROLES } }) },
    { method: 'GET', path: '/v1/invites', reply: () => ({ status: 200, body: { invites } }) },
  ];
}

function rowFor(name: string): HTMLElement {
  const row = screen.getByText(name).closest('tr');
  if (row === null) throw new Error(`No member row for ${name}.`);
  return row;
}

describe('MembersSection', () => {
  it('makes the last-Owner rule legible before either control is pressed', async () => {
    installApiStub(listRoutes([ADA, BOB]));
    renderWithQueryClient(<MembersSection />);

    await screen.findByText('Ada');

    const ada = within(rowFor('Ada'));
    expect(ada.getByRole('combobox', { name: 'Role for Ada' })).toBeDisabled();
    expect(ada.getByRole('button', { name: 'Remove Ada' })).toBeDisabled();
    expect(ada.getByText('The only Owner. Promote someone else first.')).toBeInTheDocument();

    // Said once at the top as well, because a disabled control with a caption beside it is
    // easy to read as a rendering fault rather than as a rule.
    expect(screen.getByText('One Owner')).toBeInTheDocument();
    expect(screen.getByText(/must keep at least one Owner/i)).toBeInTheDocument();

    // The rule is about Owners, not about everyone: Bob's controls are live.
    const bob = within(rowFor('Bob'));
    expect(bob.getByRole('combobox', { name: 'Role for Bob' })).toBeEnabled();
    expect(bob.getByRole('button', { name: 'Remove Bob' })).toBeEnabled();
  });

  it('leaves both controls live while the org has two Owners', async () => {
    installApiStub(listRoutes([ADA, GRACE]));
    renderWithQueryClient(<MembersSection />);

    await screen.findByText('Ada');
    expect(within(rowFor('Ada')).getByRole('combobox', { name: 'Role for Ada' })).toBeEnabled();
    expect(screen.queryByText('One Owner')).toBeNull();
  });

  it('renders the server refusal legibly when the Owner set changed underneath', async () => {
    /**
     * Two Owners as far as this screen knows, so the demotion is offered — and refused,
     * because another administrator demoted Grace between the render and the click. The
     * server is the authority; the advisory disable above is not a substitute for it.
     */
    installApiStub([
      {
        method: 'PATCH',
        path: '/v1/members/:userId',
        reply: () =>
          preconditionFailed(
            'last_owner_in_org',
            'This is the organization’s only Owner, so they cannot be removed or given a ' +
              'different role.',
          ),
      },
      ...listRoutes([ADA, GRACE]),
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<MembersSection />);

    await screen.findByText('Ada');
    await user.click(within(rowFor('Ada')).getByRole('combobox', { name: 'Role for Ada' }));
    await user.click(screen.getByRole('option', { name: 'Bookkeeper' }));

    expect(
      await screen.findByText('That would have left the organization with no Owner'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Make someone else an Owner, and try again/i)).toBeInTheDocument();
  });

  it('says an invitation was created and not delivered, and does not call it an error', async () => {
    installApiStub([
      {
        method: 'POST',
        path: '/v1/invites',
        reply: ({ body }) => ({
          status: 201,
          body: {
            emailDelivered: false,
            invitation: {
              id: 'invite-1',
              orgId: 'org-1',
              email: (body as { email: string }).email,
              roleId: 'role-bookkeeper',
              roleCode: 'bookkeeper',
              status: 'pending',
              expiresAt: '2026-03-01T00:00:00.000Z',
              createdAt: '2026-02-01T00:00:00.000Z',
              invitedByUserId: 'user-ada',
              acceptedByUserId: null,
            },
          },
        }),
      },
      ...listRoutes([ADA, BOB]),
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<MembersSection />);

    await screen.findByText('Ada');
    await user.click(screen.getByRole('button', { name: 'Invite someone' }));

    const dialog = await screen.findByRole('dialog', { name: 'Invite someone' });
    await user.type(within(dialog).getByLabelText('Email address'), 'carol@example.com');
    await user.click(within(dialog).getByRole('combobox', { name: 'Role' }));
    await user.click(screen.getByRole('option', { name: 'Bookkeeper' }));
    await user.click(within(dialog).getByRole('button', { name: 'Send invitation' }));

    expect(await screen.findByText('Invitation created — no message went out')).toBeInTheDocument();
    expect(
      screen.getByText(/the token is a credential and is never returned/i),
    ).toBeInTheDocument();

    // A status, not an alert: nothing failed, and presenting it as a failure would teach a
    // self-host operator to ignore the one notice that matters on this screen.
    const notice = screen.getByText('Invitation created — no message went out').closest('[role]');
    expect(notice).toHaveAttribute('role', 'status');
  });

  it('revokes a pending invitation with its own key', async () => {
    const invitation = {
      id: 'invite-1',
      orgId: 'org-1',
      email: 'carol@example.com',
      roleId: 'role-bookkeeper',
      roleCode: 'bookkeeper',
      status: 'pending',
      expiresAt: '2026-03-01T00:00:00.000Z',
      createdAt: '2026-02-01T00:00:00.000Z',
      invitedByUserId: 'user-ada',
      acceptedByUserId: null,
    };
    const stub = installApiStub([
      {
        method: 'POST',
        path: '/v1/invites/:inviteId/revoke',
        reply: () => ({ status: 200, body: { ...invitation, status: 'revoked' } }),
      },
      ...listRoutes([ADA, BOB], [invitation]),
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<MembersSection />);

    await user.click(
      await screen.findByRole('button', {
        name: 'Revoke the invitation for carol@example.com',
      }),
    );

    await waitFor(() => {
      expect(stub.keysFor('POST', '/v1/invites/:inviteId/revoke')).toHaveLength(1);
    });
    expect(stub.keysFor('POST', '/v1/invites/:inviteId/revoke')[0]).toMatch(/^[0-9a-f-]{36}$/);
  });
});
