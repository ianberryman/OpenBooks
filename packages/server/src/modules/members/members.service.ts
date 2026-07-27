import type { RequestContext } from '../../context';
import { bufferToUuid, orgScope as toOrgId } from '../../db';
import { assertFound, parseInput, PreconditionFailedError } from '../../errors';
import { requirePermission } from '../permissions';
import type { ChangeMemberRoleRequest, RemoveMemberRequest } from './input';
import { changeMemberRoleRequestSchema, removeMemberRequestSchema } from './input';
import type { MemberRow, RoleRow } from './members.repository';
import {
  deleteMember,
  idBytes,
  isOwnerRole,
  lockOwnerIds,
  MEMBER_RESOURCE,
  orgScope,
  ROLE_RESOURCE,
  selectAssignableRole,
  selectAssignableRoles,
  selectMember,
  selectMembers,
  selectMembershipForUpdate,
  updateMemberRole,
} from './members.repository';

/**
 * Membership management (OB-040; spec §5, spec §1's "an owner and a bookkeeper").
 *
 * `org_members` has been many-to-many since M1 with no way to add a second row to
 * it. This module is that way, and the invite half is in `invites.service.ts`.
 *
 * Three things hold across every operation and are stated once here:
 *
 * 1. **`requirePermission` runs first**, before the payload is parsed. A caller
 *    without authority learns that and nothing else; validating first describes an
 *    API surface they are not entitled to. Enforcement is service-layer only (spec
 *    §2.4, §5) — no route may repeat or replace it.
 *
 * 2. **A miss is `assertFound`.** `tenantDb` has already confined every read to the
 *    context's org, so a user id belonging to another org's member returns no row
 *    and reaches the same line a nonexistent one reaches. There is no branch here
 *    that can tell them apart (A7).
 *
 * 3. **An org cannot lose its last Owner** — not by re-role and not by removal.
 *    Both paths go through `assertNotLastOwner` below, which runs against a locked
 *    read of the Owner set. See `lockOwnerIds` for why the lock is the rule rather
 *    than an optimization of it.
 */

/** One membership, with the identity and the role behind it. */
export interface OrgMember {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  /**
   * From `users`, not from the membership. A deactivated user keeps their
   * membership — deactivation is an account-level fact — and an administrator
   * looking at the member list is exactly who needs to see it.
   */
  readonly isActive: boolean;
  readonly roleId: string;
  /** The stable code (`owner`, `bookkeeper`, …), which a client may branch on. */
  readonly roleCode: string;
  readonly roleName: string;
  readonly invitedByUserId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A role this org may hand to a member. */
export interface AssignableRole {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string;
  /** False for a custom role belonging to this org (v2); true for the six seeded. */
  readonly isSystem: boolean;
}

export async function listMembers(ctx: RequestContext): Promise<readonly OrgMember[]> {
  await requirePermission(ctx, 'members.read');

  const rows = await selectMembers(orgScope(ctx));
  return rows.map(toMember);
}

/**
 * The roles a member may be given here, for the picker an invite or a re-role needs.
 *
 * `roles.read` rather than `members.read`: the catalog is a different subject from
 * the people, and the seeded Read-only role carries the first and not the second.
 * That is the shape spec §5 intends — an accountant on a client's books can see
 * what "Bookkeeper" means without being able to see who holds it.
 */
export async function listAssignableRoles(ctx: RequestContext): Promise<readonly AssignableRole[]> {
  await requirePermission(ctx, 'roles.read');

  const rows = await selectAssignableRoles(toOrgId(ctx.orgId));
  return rows.map(toRole);
}

/**
 * Changes what one member may do.
 *
 * The whole operation is one transaction because the last-Owner rule is a claim
 * about a set the statement is about to change: the Owner read, the target's
 * current role, and the update have to be indivisible, or two callers each
 * demoting the other's Owner both observe a survivor that is about to stop being
 * one.
 *
 * Promoting *to* Owner needs no check — the set only grows — but takes the same
 * lock, deliberately. A promotion that skipped it could interleave with a demotion
 * such that the demotion counted the new Owner before it committed, which is the
 * one reading of the count that is optimistic in the unsafe direction.
 *
 * Re-roling a member to the role they already hold is permitted and is a no-op on
 * the row. It is not refused, because a client reconciling state should not have to
 * know the current value to write the intended one — and MySQL reports zero
 * affected rows for it, which is indistinguishable from a row that was not there
 * (see `updateAccountRow`'s note on `CLIENT_FOUND_ROWS`), so existence is
 * established by the read this function performs anyway.
 */
export async function changeMemberRole(
  input: ChangeMemberRoleRequest,
  ctx: RequestContext,
): Promise<OrgMember> {
  await requirePermission(ctx, 'members.write');
  const request = parseInput(changeMemberRoleRequestSchema, input);

  const userId = assertFound(idBytes(request.userId), MEMBER_RESOURCE);
  const roleId = assertFound(idBytes(request.roleId), ROLE_RESOURCE);

  return orgScope(ctx).transaction(async (trx) => {
    const owners = await lockOwnerIds(trx);
    const membership = assertFound(await selectMembershipForUpdate(trx, userId), MEMBER_RESOURCE);

    // Resolved inside the transaction and against this org: `roles` is shared, so a
    // role id that names a row is not by itself a role this org may assign — see
    // `roleVisibleTo` in the repository.
    const role = assertFound(await selectAssignableRole(trx.orgId, roleId), ROLE_RESOURCE);

    if (!isOwnerRole(role.id)) assertNotLastOwner(owners, userId, membership.role_id);

    await updateMemberRole(trx, userId, roleId);

    // Read back rather than assembled from the request: the caller gets the row as
    // it now stands, including the `updated_at` the database wrote.
    return toMember(assertFound(await selectMember(trx, userId), MEMBER_RESOURCE));
  });
}

/**
 * Removes a member from the org.
 *
 * Nothing is written to `sessions`. A removed member's live session keeps working
 * as a *session* and grants nothing in this org from the next request onward,
 * because authorization re-resolves `org_members` every time — the property
 * `0001_tenancy` records for `active_org_id` ("a preference to be re-validated on
 * read, never trusted alone"). Revoking their sessions here would also be wrong in
 * the other direction: one login may hold memberships in several orgs, and being
 * removed from a client's books is not a reason to be signed out of your own.
 *
 * Self-removal is permitted. Leaving an org you are a member of is an ordinary
 * thing to do, and the only reason to forbid it — that you might be the last Owner
 * — is already the rule that applies to everybody.
 */
export async function removeMember(input: RemoveMemberRequest, ctx: RequestContext): Promise<void> {
  await requirePermission(ctx, 'members.write');
  const request = parseInput(removeMemberRequestSchema, input);

  const userId = assertFound(idBytes(request.userId), MEMBER_RESOURCE);

  await orgScope(ctx).transaction(async (trx) => {
    const owners = await lockOwnerIds(trx);
    const membership = assertFound(await selectMembershipForUpdate(trx, userId), MEMBER_RESOURCE);

    assertNotLastOwner(owners, userId, membership.role_id);

    await deleteMember(trx, userId);
  });
}

/**
 * The last-Owner rule, in one place so re-role and removal cannot answer it
 * differently.
 *
 * `owners` is the locked Owner set; `currentRoleId` is the target's role as read
 * under the same lock. A target who is not an Owner cannot reduce the set, so the
 * rule does not apply to them at all — including the case where they are being
 * promoted, which is why the caller checks the *incoming* role before calling.
 *
 * The refusal is a `PreconditionFailedError` rather than a `ConflictError`: the
 * request is well-formed and the caller is permitted to make it, and it is the
 * state that forbids it. `last_owner_in_org` is a stable token so a client can say
 * "promote someone else first" instead of parsing prose.
 */
function assertNotLastOwner(
  owners: readonly Buffer[],
  userId: Buffer,
  currentRoleId: Buffer,
): void {
  if (!isOwnerRole(currentRoleId)) return;
  if (owners.some((owner) => !owner.equals(userId))) return;

  throw new PreconditionFailedError(
    'last_owner_in_org',
    'This is the organization’s only Owner, so they cannot be removed or given a different ' +
      'role. An organization with no Owner cannot be administered by anyone and there is no ' +
      'way to repair it from outside. Make another member an Owner first.',
  );
}

function toMember(row: MemberRow): OrgMember {
  return {
    userId: bufferToUuid(row.user_id),
    email: row.email,
    displayName: row.display_name,
    isActive: row.is_active !== 0,
    roleId: bufferToUuid(row.role_id),
    roleCode: row.role_code,
    roleName: row.role_name,
    invitedByUserId: row.invited_by_user_id === null ? null : bufferToUuid(row.invited_by_user_id),
    // `timezone: 'Z'` on the pool and `DATETIME(3)` left as a `Date`
    // (`src/db/connection.ts`), so these are real instants.
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toRole(row: RoleRow): AssignableRole {
  return {
    id: bufferToUuid(row.id),
    code: row.code,
    name: row.name,
    description: row.description,
    isSystem: row.is_system !== 0,
  };
}

export { toMember };
