import type { RequestContext } from '../../context';
import { getContext } from '../../context';
import type { OrgId } from '../../db';
import {
  bufferToUuid,
  newUuidBuffer,
  orgScope as toOrgId,
  tenantDb,
  tryUuidToBuffer,
  uuidToBuffer,
} from '../../db';
import {
  assertFound,
  ConflictError,
  NotFoundError,
  parseInput,
  PreconditionFailedError,
  UnauthenticatedError,
} from '../../errors';
import { selectOrg } from '../orgs';
import { requirePermission } from '../permissions';
import type { AcceptInviteRequest, InviteMemberRequest, RevokeInviteRequest } from './input';
import {
  acceptInviteRequestSchema,
  inviteMemberRequestSchema,
  revokeInviteRequestSchema,
} from './input';
import { deliverInvite } from './invite-email';
import type { InviteListRow, InviteRow } from './members.repository';
import {
  idBytes,
  insertInvite,
  insertMember,
  INVITE_RESOURCE,
  markInviteAccepted,
  markInviteRevoked,
  memberIdByEmail,
  orgScope,
  pendingInviteId,
  ROLE_RESOURCE,
  selectAssignableRole,
  selectInvite,
  selectInviteByTokenHashForUpdate,
  selectInvites,
  selectMembershipForUpdate,
  selectUser,
} from './members.repository';
import { INVITE_TTL_MS, inviteTokenHash, newInviteToken } from './tokens';

/**
 * Invitations (OB-040; spec §5).
 *
 * `org_invites` has been in the schema since M1 with nothing to write it and
 * nothing to send. This module is both halves — and the first consumer of an
 * `EmailProvider`, which is what D-07 was waiting for.
 *
 * ## The token is a credential
 *
 * It is 256 bits of CSPRNG output, stored only as a SHA-256 digest, single-use,
 * and it expires (see `tokens.ts`). It exists in plaintext exactly once, inside
 * the message that is sent; it is not returned to the inviter, not logged by
 * anything in this module, and cannot be recovered from the row. An inviter who
 * needs a new one revokes and re-invites.
 *
 * ## Acceptance is not permission-gated, and that is not an omission
 *
 * Every other operation here calls `requirePermission`. `acceptInvite` cannot: the
 * caller holds no role in the org they are joining, so there is no permission that
 * could be checked and no membership to check it against. The token *is* the
 * authorization, which is why it is treated as one everywhere above — and why
 * acceptance additionally requires the caller's registered address to match the
 * invited one. Without that, a forwarded or leaked link is a membership for whoever
 * opens it; with it, the credential names a single principal and a leak is inert.
 */

/** An invitation as the API reports it. The token is deliberately absent. */
export interface Invitation {
  readonly id: string;
  readonly orgId: string;
  readonly email: string;
  readonly roleId: string;
  readonly roleCode: string;
  readonly status: InvitationStatus;
  readonly invitedByUserId: string | null;
  readonly acceptedByUserId: string | null;
  readonly expiresAt: string;
  readonly createdAt: string;
}

/**
 * Derived on read rather than stored.
 *
 * `expired` is a fact about the clock, so a stored status would be wrong between
 * the moment an invite lapses and whatever job noticed — and there is no such job.
 * The other three are stored, as the timestamps that caused them.
 */
export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

/**
 * The invitation, plus whether the message actually left.
 *
 * A boolean and not an exception, because the send happens after the commit and
 * must never fail the write (see `invite-email.ts`). `false` means the row exists
 * and nobody was told: the client's move is to say so and offer to reissue, which
 * is far better than the two alternatives — failing a request whose effect is
 * already durable, or reporting success for an invitation nobody will ever see.
 */
export interface IssuedInvitation {
  readonly invitation: Invitation;
  readonly emailDelivered: boolean;
}

/** What acceptance produces: a membership, in the org the invite named. */
export interface AcceptedInvitation {
  readonly orgId: string;
  readonly userId: string;
  readonly roleId: string;
  readonly roleCode: string;
  /** False when the caller was already a member and the invite only got consumed. */
  readonly joined: boolean;
}

/**
 * Invites an address to the org, then sends the message.
 *
 * The transaction covers the two refusals and the insert. Both refusals are
 * pre-checks racing an unenforced condition — there is no unique index on
 * "one pending invite per address" — so a lost race produces a second pending
 * invite for the same person rather than a broken state: both tokens are valid,
 * whichever is accepted first consumes its own row, and the second then finds the
 * caller already a member and consumes itself without changing anything. Worth
 * knowing; not worth an index that would also have to encode "pending".
 *
 * The send is outside the transaction and cannot fail it. See `invite-email.ts` for
 * why it is there and why it is not a queued job.
 */
export async function inviteMember(
  input: InviteMemberRequest,
  ctx: RequestContext,
): Promise<IssuedInvitation> {
  await requirePermission(ctx, 'members.write');
  const request = parseInput(inviteMemberRequestSchema, input);

  const orgId = toOrgId(ctx.orgId);
  const roleKey = assertFound(idBytes(request.roleId), ROLE_RESOURCE);
  const role = assertFound(await selectAssignableRole(orgId, roleKey), ROLE_RESOURCE);

  const token = newInviteToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
  const id = newUuidBuffer();
  const invitedBy = ctx.userId === null ? null : uuidToBuffer(ctx.userId);

  const invitation = await orgScope(ctx).transaction(async (trx) => {
    if ((await memberIdByEmail(trx, request.email)) !== undefined) {
      throw new ConflictError(
        `${request.email} is already a member of this organization. Change their role instead ` +
          'of inviting them again.',
        { email: request.email },
      );
    }
    if ((await pendingInviteId(trx, request.email, now)) !== undefined) {
      throw new ConflictError(
        `An invitation to ${request.email} is already outstanding. Revoke it before issuing ` +
          'another, so that only one link is live at a time.',
        { email: request.email },
      );
    }

    await insertInvite(trx, {
      id,
      email: request.email,
      roleId: roleKey,
      tokenHash: inviteTokenHash(token),
      invitedByUserId: invitedBy,
      expiresAt,
    });

    // Read back rather than assembled, so `createdAt` is the value the database
    // wrote and not this process's opinion of when it did.
    return toInvitation(assertFound(await selectInvite(trx, id), INVITE_RESOURCE), {
      orgId: ctx.orgId,
      roleCode: role.code,
      now,
    });
  });

  // The message names the org, so the row is read after the commit rather than
  // inside the transaction: it is needed for the send and for nothing the write
  // depends on, and a `systemDb` read of `orgs` inside a tenant transaction would
  // hold that transaction open across a query it does not need.
  const org = assertFound(await selectOrg(ctx.orgId), 'org');
  const inviter = invitedBy === null ? undefined : await selectUser(invitedBy);

  const emailDelivered = await deliverInvite(
    {
      to: request.email,
      orgId: ctx.orgId,
      orgName: org.name,
      roleName: role.name,
      invitedBy: inviter?.display_name ?? null,
      token,
      expiresAt,
    },
    invitation.id,
  );

  return { invitation, emailDelivered };
}

export async function listInvites(ctx: RequestContext): Promise<readonly Invitation[]> {
  await requirePermission(ctx, 'members.read');

  const now = new Date();
  const rows = await selectInvites(orgScope(ctx));
  return rows.map((row: InviteListRow) =>
    toInvitation(row, { orgId: ctx.orgId, roleCode: row.role_code, now }),
  );
}

/**
 * Withdraws a pending invitation.
 *
 * Revoking an already-revoked invite succeeds and changes nothing: it is the same
 * request stated twice, and a client retrying after a dropped response should not
 * be told the withdrawal failed. Revoking an *accepted* one is refused, because it
 * is a different intention with a different remedy — the person is a member now,
 * and the operation that undoes that is `removeMember`, which has the last-Owner
 * rule attached to it. Silently doing nothing would be worse than either.
 *
 * An expired invite may still be revoked. It is already unusable; revoking is how
 * an administrator says so on the list.
 */
export async function revokeInvite(
  input: RevokeInviteRequest,
  ctx: RequestContext,
): Promise<Invitation> {
  await requirePermission(ctx, 'members.write');
  const request = parseInput(revokeInviteRequestSchema, input);

  const id = assertFound(idBytes(request.inviteId), INVITE_RESOURCE);
  const now = new Date();

  return orgScope(ctx).transaction(async (trx) => {
    const invite = assertFound(await selectInvite(trx, id), INVITE_RESOURCE);
    if (invite.accepted_at !== null) {
      throw new PreconditionFailedError(
        'invite_already_accepted',
        'This invitation has already been accepted, so there is nothing to withdraw. Remove ' +
          'the member instead.',
      );
    }

    if (invite.revoked_at === null) await markInviteRevoked(trx, id, now);

    const role = assertFound(await selectAssignableRole(trx.orgId, invite.role_id), ROLE_RESOURCE);
    return toInvitation(assertFound(await selectInvite(trx, id), INVITE_RESOURCE), {
      orgId: ctx.orgId,
      roleCode: role.code,
      now,
    });
  });
}

/**
 * Redeems an invite token and joins the org.
 *
 * ## What authorizes this
 *
 * The token, and the caller's registered email matching the invited one. There is
 * no permission check and there cannot be one — see the module header. The caller
 * must be a signed-in user: an invite names an address, not an account, and the
 * account it attaches to has to be one that already exists (registration is
 * `auth.service.ts`; an invite is not a second way to create a user).
 *
 * ## Why the org is a parameter here and nowhere else
 *
 * `org_invites` is a tenant table and the caller's context is scoped to some other
 * org or to none, so the scope has to come from the invite link. It is validated as
 * client-supplied input the way `src/db/org-scope.ts` requires: through
 * `tryUuidToBuffer`, so malformed, another tenant's, and nonexistent are one
 * indistinguishable 404. Every statement below still runs through `tenantDb`.
 *
 * ## Single use
 *
 * The invite row is read `FOR UPDATE` and consumed by an update predicated on it
 * still being unconsumed, both inside one transaction with the membership insert.
 * Two concurrent redemptions therefore serialize: the second reads the row *after*
 * the first commits, sees `accepted_at`, and is refused. Neither the lock nor the
 * predicate is redundant — see `markInviteAccepted`.
 *
 * ## Already a member
 *
 * The invite is consumed and the existing membership is returned unchanged, with
 * `joined: false`. Not an error, because a duplicate-key failure would leave the
 * user staring at a link that will never work again for a state that is already
 * what they wanted; and explicitly *not* a re-role, because an invite issued as
 * Read-only would otherwise be a way to demote an Owner who clicked it.
 */
export async function acceptInvite(input: AcceptInviteRequest): Promise<AcceptedInvitation> {
  const { userId } = getContext('acceptInvite()');
  if (userId === null) throw new UnauthenticatedError();

  const request = parseInput(acceptInviteRequestSchema, input);
  const orgId: OrgId = assertFound(tryUuidToBuffer(request.orgId), INVITE_RESOURCE);
  const userKey = uuidToBuffer(userId);
  const now = new Date();

  const user = await selectUser(userKey);
  // The context named a user that is gone or deactivated: their credential is void,
  // and nothing about the invite should be revealed to it.
  if (user === undefined || user.is_active === 0) throw new UnauthenticatedError();

  return tenantDb(orgId).transaction(async (trx) => {
    const invite = assertFound(
      await selectInviteByTokenHashForUpdate(trx, inviteTokenHash(request.token)),
      INVITE_RESOURCE,
    );

    // Revoked reads as "no such invitation" rather than as its own precondition.
    // The inviter withdrew it, and there is nothing for the holder to act on: a
    // distinct answer would only confirm that the token was once real.
    if (invite.revoked_at !== null) throw new NotFoundError(INVITE_RESOURCE);

    if (invite.accepted_at !== null) {
      throw new PreconditionFailedError(
        'invite_already_accepted',
        'This invitation has already been used. Invitations can be accepted once; ask for a ' +
          'new one.',
      );
    }
    if (invite.expires_at.getTime() <= now.getTime()) {
      throw new PreconditionFailedError(
        'invite_expired',
        'This invitation has expired. Ask whoever invited you to send another.',
      );
    }
    // Compared against the *registered* address, both normalized to lowercase on
    // the way in (`input.ts`). Told plainly, and without naming the invited
    // address: the holder of the token needs to know that signing in as somebody
    // else is the problem, and does not need to be told whose invitation it is.
    if (user.email !== invite.email) {
      throw new PreconditionFailedError(
        'invite_email_mismatch',
        'This invitation was issued to a different email address than the one you are signed ' +
          'in with. Sign in with the address the invitation was sent to.',
      );
    }

    const role = assertFound(await selectAssignableRole(trx.orgId, invite.role_id), ROLE_RESOURCE);
    const existing = await selectMembershipForUpdate(trx, userKey);

    const consumed = await markInviteAccepted(trx, invite.id, userKey, now);
    // Only reachable if another transaction consumed the row between the locking
    // read and here, which the lock forbids. Answered as a replay rather than as an
    // internal error, since that is what it would mean if the lock ever stopped
    // holding.
    if (!consumed) {
      throw new PreconditionFailedError(
        'invite_already_accepted',
        'This invitation has already been used. Invitations can be accepted once; ask for a ' +
          'new one.',
      );
    }

    if (existing !== undefined) {
      const held = assertFound(
        await selectAssignableRole(trx.orgId, existing.role_id),
        ROLE_RESOURCE,
      );
      return {
        orgId: request.orgId,
        userId,
        roleId: bufferToUuid(existing.role_id),
        roleCode: held.code,
        joined: false,
      };
    }

    await insertMember(trx, userKey, invite.role_id, invite.invited_by_user_id);

    return {
      orgId: request.orgId,
      userId,
      roleId: bufferToUuid(invite.role_id),
      roleCode: role.code,
      joined: true,
    };
  });
}

interface InvitationView {
  readonly orgId: string;
  readonly roleCode: string;
  readonly now: Date;
}

function toInvitation(row: InviteRow, view: InvitationView): Invitation {
  return {
    id: bufferToUuid(row.id),
    orgId: view.orgId,
    email: row.email,
    roleId: bufferToUuid(row.role_id),
    roleCode: view.roleCode,
    status: statusOf(row, view.now),
    invitedByUserId: row.invited_by_user_id === null ? null : bufferToUuid(row.invited_by_user_id),
    acceptedByUserId:
      row.accepted_by_user_id === null ? null : bufferToUuid(row.accepted_by_user_id),
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Order matters. Revocation is checked first because an invite can be revoked
 * after it lapses, and "revoked" is the fact an administrator acted on; expiry is
 * checked last because it is the only one that becomes true without anybody doing
 * anything.
 */
function statusOf(row: InviteRow, now: Date): InvitationStatus {
  if (row.revoked_at !== null) return 'revoked';
  if (row.accepted_at !== null) return 'accepted';
  if (row.expires_at.getTime() <= now.getTime()) return 'expired';
  return 'pending';
}
