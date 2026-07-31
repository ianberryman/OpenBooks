import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useId, useState } from 'react';

import { api, expectNoContent, idempotencyHeader, newIdempotencyKey, unwrap } from '../../api';
import type { IdempotentVariables, components } from '../../api';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  ErrorBanner,
  Field,
  FieldLabel,
  Pill,
  ResponsiveTable,
  Select,
  TextInput,
} from '../../components';
import { cx } from '../../lib/cx';
import {
  EmptyRow,
  Notice,
  SettingsSection,
  TABLE_CLASSES,
  TD_CLASSES,
  TH_CLASSES,
} from './section';
import { formatTimestamp, preconditionOf } from './support';

/**
 * Members and invitations (OB-050; spec §5).
 *
 * ## The last Owner, said out loud rather than discovered
 *
 * An org cannot lose its last Owner: the server refuses both the demotion and the removal,
 * under a lock on the Owner set rather than a count, and answers `precondition_failed`
 * with `last_owner_in_org`. The rule is not negotiable and it is not obvious, and the
 * shape of the mistake it prevents — an organization nobody can administer, with no
 * support path that reaches inside one tenant to repair it — is exactly the shape a user
 * only understands *after* being told. So the sole Owner's row disables both controls and
 * says why, before either is pressed. The server is still the authority; this is the same
 * advisory relationship `permissions` on `GET /v1/auth/me` has (D-25), and the refusal is
 * rendered as well, for the race where a second administrator demotes the other Owner
 * between this render and the click.
 *
 * ## `emailDelivered` is shown because it can be false
 *
 * The send happens after the commit and must never fail the write, and a self-host install
 * running the log email adapter (D-31 — `smtp` is not a provider) delivers nothing at all.
 * So a `false` here means the invitation is perfectly valid and *nobody was told*. The
 * token is never returned to this screen — it is a credential, held only as a hash — so
 * the only honest instruction is that the link has to be taken from where the message was
 * written and passed on another way.
 */

/**
 * The six system roles have stable codes and per-deployment ids, which is why the API says
 * to branch on `roleCode`: a screen keyed on the id is keyed on a value that differs
 * between two installations of the same product.
 */
const OWNER_ROLE_CODE = 'owner';

const MEMBERS_QUERY_KEY = ['settings', 'members'] as const;
const INVITES_QUERY_KEY = ['settings', 'invites'] as const;
const ROLES_QUERY_KEY = ['settings', 'roles'] as const;

type OrgMember = components['schemas']['OrgMember'];
type Invitation = components['schemas']['Invitation'];
type IssuedInvitation = components['schemas']['IssuedInvitation'];

export function MembersSection(): ReactElement {
  const queryClient = useQueryClient();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [pendingRemoval, setPendingRemoval] = useState<OrgMember | null>(null);
  const [issued, setIssued] = useState<IssuedInvitation | null>(null);

  const members = useQuery({
    queryKey: MEMBERS_QUERY_KEY,
    queryFn: async () => unwrap(await api.GET('/v1/members')),
  });

  const roles = useQuery({
    queryKey: ROLES_QUERY_KEY,
    queryFn: async () => unwrap(await api.GET('/v1/roles')),
  });

  const invites = useQuery({
    queryKey: INVITES_QUERY_KEY,
    queryFn: async () => unwrap(await api.GET('/v1/invites')),
  });

  const changeRole = useMutation({
    mutationFn: async ({
      idempotencyKey,
      userId,
      roleId,
    }: IdempotentVariables<{ userId: string; roleId: string }>) =>
      unwrap(
        await api.PATCH('/v1/members/{userId}', {
          body: { roleId },
          params: { path: { userId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: MEMBERS_QUERY_KEY });
    },
  });

  const removeMember = useMutation({
    // A 204 carries no body, so `unwrap` is the wrong helper — see `expectNoContent`.
    mutationFn: async ({ idempotencyKey, userId }: IdempotentVariables<{ userId: string }>) =>
      expectNoContent(
        await api.DELETE('/v1/members/{userId}', {
          params: { path: { userId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      setPendingRemoval(null);
      await queryClient.invalidateQueries({ queryKey: MEMBERS_QUERY_KEY });
    },
  });

  const invite = useMutation({
    mutationFn: async ({
      idempotencyKey,
      ...body
    }: IdempotentVariables<{ email: string; roleId: string }>) =>
      unwrap(
        await api.POST('/v1/invites', {
          body,
          params: { header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async (data) => {
      setIssued(data);
      setInviteOpen(false);
      await queryClient.invalidateQueries({ queryKey: INVITES_QUERY_KEY });
    },
  });

  const revoke = useMutation({
    mutationFn: async ({ idempotencyKey, inviteId }: IdempotentVariables<{ inviteId: string }>) =>
      unwrap(
        await api.POST('/v1/invites/{inviteId}/revoke', {
          params: { path: { inviteId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: INVITES_QUERY_KEY });
    },
  });

  const people = members.data?.members ?? [];
  const roleOptions = (roles.data?.roles ?? []).map((role) => ({
    value: role.id,
    label: role.name,
  }));

  const ownerCount = people.filter((person) => person.roleCode === OWNER_ROLE_CODE).length;
  const isSoleOwner = (person: OrgMember): boolean =>
    person.roleCode === OWNER_ROLE_CODE && ownerCount === 1;

  const lastOwnerRefusal =
    preconditionOf(changeRole.error) === 'last_owner_in_org' ||
    preconditionOf(removeMember.error) === 'last_owner_in_org';

  return (
    <SettingsSection
      title="People"
      description={
        <>
          Who belongs to this organization and what they may do in it. Removing someone leaves every
          entry they posted naming them — an actor on a posted entry is a fact, not a link.
        </>
      }
      actions={
        <Button
          variant="primary"
          disabled={roles.isPending}
          onClick={() => {
            invite.reset();
            setIssued(null);
            setInviteOpen(true);
          }}
        >
          Invite someone
        </Button>
      }
    >
      {members.isError && (
        <ErrorBanner
          error={members.error}
          onRetry={() => {
            void members.refetch();
          }}
        />
      )}
      {roles.isError && <ErrorBanner error={roles.error} />}

      {ownerCount === 1 && (
        <Notice tone="info" title="One Owner">
          An organization must keep at least one Owner, so the only one cannot be given a different
          role or removed. Make a second member an Owner first if either is what you want.
        </Notice>
      )}

      {lastOwnerRefusal && (
        <Notice tone="warning" title="That would have left the organization with no Owner">
          Another administrator may have changed the Owner set a moment ago. Reload the list, make
          someone else an Owner, and try again.
        </Notice>
      )}
      {!lastOwnerRefusal && changeRole.isError && <ErrorBanner error={changeRole.error} />}

      <ResponsiveTable>
        <table className={TABLE_CLASSES}>
          <caption className="sr-only">Members</caption>
          <thead>
            <tr>
              <th scope="col" className={TH_CLASSES}>
                Person
              </th>
              <th scope="col" className={TH_CLASSES}>
                Role
              </th>
              <th scope="col" className={TH_CLASSES}>
                Status
              </th>
              <th scope="col" className={cx(TH_CLASSES, 'text-right')}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {people.length === 0 && (
              <EmptyRow columns={4}>{members.isPending ? 'Loading…' : 'No members.'}</EmptyRow>
            )}
            {people.map((person) => {
              const sole = isSoleOwner(person);
              return (
                <tr key={person.userId}>
                  <td className={TD_CLASSES}>
                    <span className="text-text">{person.displayName}</span>
                    <span className="block text-xs text-text-subtle">{person.email}</span>
                  </td>
                  <td className={TD_CLASSES}>
                    <Select
                      aria-label={`Role for ${person.displayName}`}
                      value={person.roleId}
                      options={roleOptions}
                      disabled={sole || changeRole.isPending}
                      onValueChange={(roleId) => {
                        if (roleId === person.roleId) return;
                        changeRole.mutate({
                          userId: person.userId,
                          roleId,
                          idempotencyKey: newIdempotencyKey(),
                        });
                      }}
                      className="w-48"
                    />
                    {sole && (
                      <span className="mt-1 block text-xs text-text-subtle">
                        The only Owner. Promote someone else first.
                      </span>
                    )}
                  </td>
                  <td className={TD_CLASSES}>
                    <Pill tone={person.isActive ? 'positive' : 'muted'}>
                      {person.isActive ? 'Active' : 'Deactivated'}
                    </Pill>
                  </td>
                  <td className={cx(TD_CLASSES, 'text-right')}>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={sole}
                      aria-label={`Remove ${person.displayName}`}
                      onClick={() => {
                        removeMember.reset();
                        setPendingRemoval(person);
                      }}
                    >
                      Remove
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </ResponsiveTable>

      {issued !== null && <IssuedInviteNotice issued={issued} />}

      <InvitesTable
        invites={invites.data?.invites ?? []}
        loading={invites.isPending}
        error={invites.error}
        revoking={revoke.isPending ? (revoke.variables?.inviteId ?? null) : null}
        revokeError={revoke.error}
        onRevoke={(inviteId) => {
          revoke.mutate({ inviteId, idempotencyKey: newIdempotencyKey() });
        }}
      />

      <InviteDialog
        open={inviteOpen}
        roleOptions={roleOptions}
        pending={invite.isPending}
        error={invite.error}
        onClose={() => {
          setInviteOpen(false);
        }}
        onSubmit={(values) => {
          invite.mutate({ ...values, idempotencyKey: newIdempotencyKey() });
        }}
      />

      <Dialog
        open={pendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemoval(null);
        }}
      >
        <DialogContent
          title="Remove member"
          description="The membership goes; the user account and everything they posted do not."
          footer={
            <>
              <DialogClose asChild>
                <Button>Cancel</Button>
              </DialogClose>
              <Button
                variant="danger"
                disabled={removeMember.isPending}
                onClick={() => {
                  if (pendingRemoval === null) return;
                  removeMember.mutate({
                    userId: pendingRemoval.userId,
                    idempotencyKey: newIdempotencyKey(),
                  });
                }}
              >
                Remove
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            <p className="text-sm text-text">
              {pendingRemoval?.displayName ?? 'This person'} loses access to this organization
              immediately. Every journal they posted keeps naming them, and they can be invited
              back.
            </p>
            {removeMember.isError && <ErrorBanner error={removeMember.error} />}
          </div>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
}

function IssuedInviteNotice({ issued }: { readonly issued: IssuedInvitation }): ReactElement {
  if (issued.emailDelivered) {
    return (
      <Notice tone="success" title="Invitation sent">
        {issued.invitation.email} has been emailed a link. It expires{' '}
        {formatTimestamp(issued.invitation.expiresAt)}.
      </Notice>
    );
  }

  return (
    <Notice tone="warning" title="Invitation created — no message went out">
      The invitation for {issued.invitation.email} is valid and expires{' '}
      {formatTimestamp(issued.invitation.expiresAt)}, but nobody has been told. This is what a
      self-hosted install configured with the log email provider does: the message is written to the
      server log rather than delivered. Take the link from there and pass it on yourself — the token
      is a credential and is never returned to this page.
    </Notice>
  );
}

interface InvitesTableProps {
  readonly invites: readonly Invitation[];
  readonly loading: boolean;
  readonly error: unknown;
  readonly revoking: string | null;
  readonly revokeError: unknown;
  readonly onRevoke: (inviteId: string) => void;
}

function InvitesTable({
  invites,
  loading,
  error,
  revoking,
  revokeError,
  onRevoke,
}: InvitesTableProps): ReactElement {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-text">Invitations</h3>
      {error !== null && error !== undefined && <ErrorBanner error={error} />}
      {revokeError !== null && revokeError !== undefined && <ErrorBanner error={revokeError} />}
      <ResponsiveTable>
        <table className={TABLE_CLASSES}>
          <caption className="sr-only">Invitations</caption>
          <thead>
            <tr>
              <th scope="col" className={TH_CLASSES}>
                Address
              </th>
              <th scope="col" className={TH_CLASSES}>
                Role
              </th>
              <th scope="col" className={TH_CLASSES}>
                Status
              </th>
              <th scope="col" className={cx(TH_CLASSES, 'text-right')}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {invites.length === 0 && (
              <EmptyRow columns={4}>{loading ? 'Loading…' : 'No invitations.'}</EmptyRow>
            )}
            {invites.map((invitation) => (
              <tr key={invitation.id}>
                <td className={TD_CLASSES}>{invitation.email}</td>
                <td className={cx(TD_CLASSES, 'font-mono text-xs')}>{invitation.roleCode}</td>
                <td className={TD_CLASSES}>
                  <Pill tone={INVITE_TONES[invitation.status]}>{invitation.status}</Pill>
                  {invitation.status === 'pending' && (
                    <span className="ml-2 text-xs text-text-subtle">
                      expires {formatTimestamp(invitation.expiresAt)}
                    </span>
                  )}
                </td>
                <td className={cx(TD_CLASSES, 'text-right')}>
                  {invitation.status === 'accepted' ? (
                    /*
                     * Not a disabled button with no explanation: an accepted invitation is
                     * not revocable at all — the person is a member now, and the operation
                     * that undoes that is removing them, which carries the last-Owner rule.
                     */
                    <span className="text-xs text-text-subtle">
                      Accepted — remove the member instead
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      disabled={invitation.status === 'revoked' || revoking === invitation.id}
                      aria-label={`Revoke the invitation for ${invitation.email}`}
                      onClick={() => {
                        onRevoke(invitation.id);
                      }}
                    >
                      Revoke
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ResponsiveTable>
    </div>
  );
}

const INVITE_TONES: Readonly<Record<Invitation['status'], 'positive' | 'neutral' | 'muted'>> = {
  pending: 'neutral',
  accepted: 'positive',
  revoked: 'muted',
  expired: 'muted',
};

interface InviteDialogProps {
  readonly open: boolean;
  readonly roleOptions: readonly { readonly value: string; readonly label: string }[];
  readonly pending: boolean;
  readonly error: unknown;
  readonly onClose: () => void;
  readonly onSubmit: (values: { email: string; roleId: string }) => void;
}

function InviteDialog({
  open,
  roleOptions,
  pending,
  error,
  onClose,
  onSubmit,
}: InviteDialogProps): ReactElement {
  const formId = useId();
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState<string | null>(null);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        title="Invite someone"
        description="An address and the role it is invited to hold. The invitation names an address, not an account — whoever accepts must be signed in as that address."
        footer={
          <>
            <DialogClose asChild>
              <Button>Cancel</Button>
            </DialogClose>
            <Button
              variant="primary"
              type="submit"
              form={formId}
              disabled={pending || roleId === null}
            >
              Send invitation
            </Button>
          </>
        }
      >
        <form
          id={formId}
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (roleId === null) return;
            onSubmit({ email: email.trim(), roleId });
          }}
        >
          <Field>
            <FieldLabel>Email address</FieldLabel>
            <TextInput
              type="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
              }}
            />
          </Field>
          <Field hint="What they may do once they accept.">
            <FieldLabel>Role</FieldLabel>
            <Select
              value={roleId}
              options={roleOptions}
              onValueChange={(value) => {
                setRoleId(value);
              }}
            />
          </Field>
          {error !== null && error !== undefined && <ErrorBanner error={error} />}
        </form>
      </DialogContent>
    </Dialog>
  );
}
