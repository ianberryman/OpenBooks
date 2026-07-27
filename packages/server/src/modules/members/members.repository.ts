import type { Expression, SqlBool } from 'kysely';
import { sql } from 'kysely';

import type { RequestContext } from '../../context';
import type { OrgId, TenantDatabase } from '../../db';
import { orgScope as toOrgId, systemDb, tenantDb, tryUuidToBuffer, uuidToBuffer } from '../../db';
import { OWNER_ROLE_ID } from '../orgs';

/**
 * Data access for `org_members` and `org_invites`.
 *
 * Both are tenant tables, so every statement here goes through `TenantDatabase`
 * and carries `org_id = <scope>` before this file adds a predicate (OB-013). That
 * is what makes A7 structural rather than careful: another org's member is not a
 * row this module can reach, so a cross-org user id and a user id that never
 * existed arrive at the same `assertFound`.
 *
 * ## Why `roles` is read through `systemDb` and with a hand-written predicate
 *
 * `roles` is the one table deliberately excluded from the tenant set: its `org_id`
 * is nullable and NULL means "system role, shared by every org", so the wrapper's
 * bare `org_id = ?` would hide all six seeded roles. The predicate
 * `(org_id = <org> OR org_id IS NULL)` is therefore written by hand — and this is
 * the *second* copy of it in the tree. The first,
 * `permissions.repository.ts:roleVisibleToOrg`, answers a different question
 * ("what does this role grant the caller, here") and remains the only authority on
 * authorization; this one answers "may this org hand this role to a member", which
 * is a question about assignment. They agree today and are two lines apart from
 * disagreeing, so the pair wants hoisting into `src/db` or a shared roles module —
 * OB-040 does not own `modules/permissions/` and reaching sideways into another
 * module's repository would be the worse of the two. Flagged in the report.
 */

/** The scope every operation in this module runs in (spec §4 — never a parameter). */
export function orgScope(ctx: RequestContext): TenantDatabase {
  return tenantDb(toOrgId(ctx.orgId));
}

/**
 * The Owner role as bytes, computed once.
 *
 * A module-level constant rather than a per-call conversion because it is compared
 * against on every membership write — and because the id is a fixed reserved UUID
 * (`0001_tenancy`), not a lookup, for the reason `modules/orgs` records.
 */
const OWNER_ROLE_KEY = uuidToBuffer(OWNER_ROLE_ID);

/** The resource token for a member miss (A7). One constant, so misses cannot drift. */
export const MEMBER_RESOURCE = 'member';

/** The resource token for an invite miss, including a token that names nothing. */
export const INVITE_RESOURCE = 'invite';

export const ROLE_RESOURCE = 'role';

export interface MemberRow {
  readonly user_id: Buffer;
  readonly email: string;
  readonly display_name: string;
  readonly is_active: number;
  readonly role_id: Buffer;
  readonly role_code: string;
  readonly role_name: string;
  readonly invited_by_user_id: Buffer | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface InviteRow {
  readonly id: Buffer;
  readonly email: string;
  readonly role_id: Buffer;
  readonly invited_by_user_id: Buffer | null;
  readonly expires_at: Date;
  readonly accepted_at: Date | null;
  readonly accepted_by_user_id: Buffer | null;
  readonly revoked_at: Date | null;
  readonly created_at: Date;
}

export interface InviteListRow extends InviteRow {
  readonly role_code: string;
}

export interface RoleRow {
  readonly id: Buffer;
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly is_system: number;
}

const INVITE_COLUMNS = [
  'id',
  'email',
  'role_id',
  'invited_by_user_id',
  'expires_at',
  'accepted_at',
  'accepted_by_user_id',
  'revoked_at',
  'created_at',
] as const;

/**
 * A client-supplied id as bytes, or `undefined` when it is not a UUID.
 *
 * Undefined rather than a throw so the service routes a malformed id through
 * `assertFound` to the 404 a nonexistent one produces — "malformed", "not yours",
 * and "does not exist" have to be one answer (A7).
 */
export function idBytes(value: string): Buffer | undefined {
  return tryUuidToBuffer(value);
}

/**
 * Every member of the scoped org, with the identity and role behind the membership.
 *
 * Not paginated, unlike the chart of accounts (D-21). The row count here is the
 * number of *people* who can sign in to one set of books — spec §1's target is a
 * small business with an owner and a bookkeeper, and even an accounting firm's
 * client org is a handful — so a cursor would add a contract for a page nobody
 * reaches. Accounts, contacts, and journals are unbounded in a way this is not.
 *
 * The join to `roles` carries the visibility predicate rather than matching on
 * `role_id` alone. A membership whose role does not resolve in this org is
 * therefore absent from the list, which is the fail-closed direction and matches
 * `listMemberships` in `modules/orgs`. It cannot happen today — every seeded role
 * is `org_id IS NULL` and the custom-role editor is v2 — and the alternative,
 * listing a member with an unresolvable role, would offer an administrator a row
 * whose authority the system cannot state.
 */
function memberQuery(db: TenantDatabase) {
  return db
    .selectFrom('org_members')
    .innerJoin('users', 'users.id', 'org_members.user_id')
    .innerJoin('roles', (join) =>
      join.onRef('roles.id', '=', 'org_members.role_id').on(roleVisibleTo(db.orgId)),
    )
    .select([
      'org_members.user_id as user_id',
      'users.email as email',
      'users.display_name as display_name',
      'users.is_active as is_active',
      'roles.id as role_id',
      'roles.code as role_code',
      'roles.name as role_name',
      'org_members.invited_by_user_id as invited_by_user_id',
      'org_members.created_at as created_at',
      'org_members.updated_at as updated_at',
    ]);
}

export async function selectMembers(db: TenantDatabase): Promise<readonly MemberRow[]> {
  return (
    memberQuery(db)
      // Total, including the tiebreak: two memberships created in the same
      // millisecond are the normal case (registration writes one, an accepted
      // invite another), and a list whose order varies between calls is a list a
      // client cannot diff.
      .orderBy('users.email', 'asc')
      .orderBy('org_members.user_id', 'asc')
      .execute()
  );
}

export async function selectMember(
  db: TenantDatabase,
  userId: Buffer,
): Promise<MemberRow | undefined> {
  return memberQuery(db).where('org_members.user_id', '=', userId).executeTakeFirst();
}

/**
 * The membership row alone, under an exclusive lock.
 *
 * Deliberately not the joined read above: a locking read on a join takes locks on
 * every table in it, so the joined form would lock a `users` row and a `roles` row
 * as a side effect of asking about a membership — and `roles` rows are shared by
 * every org in the system, so locking one would serialize unrelated tenants
 * against each other.
 */
export async function selectMembershipForUpdate(
  db: TenantDatabase,
  userId: Buffer,
): Promise<{ readonly role_id: Buffer } | undefined> {
  return db
    .selectFrom('org_members')
    .select('role_id')
    .where('user_id', '=', userId)
    .forUpdate()
    .executeTakeFirst();
}

/**
 * Every Owner of the scoped org, locked for the duration of the transaction.
 *
 * **This is the last-Owner rule.** An org that loses its final Owner is
 * unadministrable — nobody can invite, re-role, or remove anyone, and there is no
 * support path that reaches inside one tenant to fix it — so both `changeRole` and
 * `removeMember` refuse when they would be the removal of the last one.
 *
 * The check has to be a *locking* read, and a sequential test cannot tell whether
 * it is. With two Owners, two concurrent "demote the other one" calls both read a
 * count of two, both conclude that one Owner remains, and both commit; the org
 * ends with zero. `FOR UPDATE` over `(org_id, role_id = owner)` makes the second
 * transaction queue behind the first on `idx_org_members_org_role`, so it re-reads
 * *after* the first has committed and sees the count it will actually leave
 * behind. `test/members/last-owner-race.test.ts` parks one side mid-transaction
 * and asserts the other has not settled, which is what distinguishes this from two
 * calls that merely happened to run in some order.
 *
 * Under REPEATABLE READ the range lock also blocks a concurrent *insert* of a new
 * Owner into the range. That is conservative in the safe direction: the worst it
 * can do is make an admission wait, and it removes the third interleaving where
 * one transaction demotes the last Owner while another is halfway through
 * promoting a replacement.
 *
 * `org_members` may be locked at all only because it is in `0999_app_grants`'
 * mutable allowlist — MySQL requires UPDATE/DELETE rights for a locking read, which
 * is exactly why no journal row in this codebase is ever locked (D-14).
 */
export async function lockOwnerIds(db: TenantDatabase): Promise<readonly Buffer[]> {
  const rows = await db
    .selectFrom('org_members')
    .select('user_id')
    .where('role_id', '=', OWNER_ROLE_KEY)
    .forUpdate()
    .execute();

  return rows.map((row) => row.user_id);
}

export function isOwnerRole(roleId: Buffer): boolean {
  return roleId.equals(OWNER_ROLE_KEY);
}

export async function updateMemberRole(
  db: TenantDatabase,
  userId: Buffer,
  roleId: Buffer,
): Promise<void> {
  await db
    .updateTable('org_members')
    .set({ role_id: roleId })
    .where('user_id', '=', userId)
    .execute();
}

export async function deleteMember(db: TenantDatabase, userId: Buffer): Promise<void> {
  await db.deleteFrom('org_members').where('user_id', '=', userId).execute();
}

export async function insertMember(
  db: TenantDatabase,
  userId: Buffer,
  roleId: Buffer,
  invitedByUserId: Buffer | null,
): Promise<void> {
  await db
    .insertInto('org_members')
    .values({ user_id: userId, role_id: roleId, invited_by_user_id: invitedByUserId })
    .execute();
}

/** Whether any member of the scoped org signs in with this address. */
export async function memberIdByEmail(
  db: TenantDatabase,
  email: string,
): Promise<Buffer | undefined> {
  const row = await db
    .selectFrom('org_members')
    .innerJoin('users', 'users.id', 'org_members.user_id')
    .select('org_members.user_id as user_id')
    .where('users.email', '=', email)
    .limit(1)
    .executeTakeFirst();

  return row?.user_id;
}

export interface NewInviteRow {
  readonly id: Buffer;
  readonly email: string;
  readonly roleId: Buffer;
  readonly tokenHash: string;
  readonly invitedByUserId: Buffer | null;
  readonly expiresAt: Date;
}

export async function insertInvite(db: TenantDatabase, row: NewInviteRow): Promise<void> {
  await db
    .insertInto('org_invites')
    .values({
      id: row.id,
      email: row.email,
      role_id: row.roleId,
      token_hash: row.tokenHash,
      invited_by_user_id: row.invitedByUserId,
      expires_at: row.expiresAt,
    })
    .execute();
}

/**
 * Every invite this org has issued, newest first, with the role each carries.
 *
 * Joined to `roles` — unlike the locking reads below, which take the invite row
 * alone. A locking read on a join locks a `roles` row too, and `roles` rows are
 * shared by every org in the system, so one org's acceptance would serialize
 * against another's. This read takes no locks, so the join costs nothing.
 *
 * Accepted and revoked invites are listed rather than filtered out. The list is
 * how an administrator answers "did that invitation ever land", and an invite that
 * silently vanishes on acceptance takes the answer with it. `status` on the
 * service type is what a client filters on.
 */
export async function selectInvites(db: TenantDatabase): Promise<readonly InviteListRow[]> {
  return db
    .selectFrom('org_invites')
    .innerJoin('roles', (join) =>
      join.onRef('roles.id', '=', 'org_invites.role_id').on(roleVisibleTo(db.orgId)),
    )
    .select([
      'org_invites.id as id',
      'org_invites.email as email',
      'org_invites.role_id as role_id',
      'roles.code as role_code',
      'org_invites.invited_by_user_id as invited_by_user_id',
      'org_invites.expires_at as expires_at',
      'org_invites.accepted_at as accepted_at',
      'org_invites.accepted_by_user_id as accepted_by_user_id',
      'org_invites.revoked_at as revoked_at',
      'org_invites.created_at as created_at',
    ])
    .orderBy('org_invites.created_at', 'desc')
    .orderBy('org_invites.id', 'asc')
    .execute();
}

export async function selectInvite(db: TenantDatabase, id: Buffer): Promise<InviteRow | undefined> {
  return db
    .selectFrom('org_invites')
    .select(INVITE_COLUMNS)
    .where('id', '=', id)
    .executeTakeFirst();
}

export async function selectInviteForUpdate(
  db: TenantDatabase,
  id: Buffer,
): Promise<InviteRow | undefined> {
  return db
    .selectFrom('org_invites')
    .select(INVITE_COLUMNS)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
}

/**
 * The invite a presented token names, locked.
 *
 * Locked rather than read plainly because acceptance must be single-use: two
 * concurrent redemptions of the same token would otherwise both see
 * `accepted_at IS NULL` and both insert a membership, and the second would fail on
 * the primary key — which is the right outcome reached by accident, and only
 * because the membership happens to be keyed `(org_id, user_id)`. Accepting the
 * same invite as *two different users* has no such key behind it. The lock is what
 * makes single-use a property of the invite rather than of the membership.
 *
 * Matched on the digest, never on the token: `uq_org_invites_token` indexes the
 * hash, so this is an index probe, and the token itself exists only in the message
 * that was sent (see `tokens.ts`).
 */
export async function selectInviteByTokenHashForUpdate(
  db: TenantDatabase,
  tokenHash: string,
): Promise<InviteRow | undefined> {
  return db
    .selectFrom('org_invites')
    .select(INVITE_COLUMNS)
    .where('token_hash', '=', tokenHash)
    .forUpdate()
    .executeTakeFirst();
}

/**
 * Consumes the invite, conditionally on it still being unconsumed.
 *
 * The `accepted_at IS NULL` predicate is redundant given the lock above and is
 * written anyway: it is the half of single-use that survives someone later
 * deciding the lock is an optimization. Returns whether it took effect, so the
 * caller can treat "somebody else consumed it" as the same refusal a replay gets
 * rather than proceeding on a row it no longer owns.
 */
export async function markInviteAccepted(
  db: TenantDatabase,
  id: Buffer,
  acceptedByUserId: Buffer,
  now: Date,
): Promise<boolean> {
  const result = await db
    .updateTable('org_invites')
    .set({ accepted_at: now, accepted_by_user_id: acceptedByUserId })
    .where('id', '=', id)
    .where('accepted_at', 'is', null)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();

  return result.numUpdatedRows > 0n;
}

export async function markInviteRevoked(
  db: TenantDatabase,
  id: Buffer,
  now: Date,
): Promise<boolean> {
  const result = await db
    .updateTable('org_invites')
    .set({ revoked_at: now })
    .where('id', '=', id)
    .where('accepted_at', 'is', null)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();

  return result.numUpdatedRows > 0n;
}

/** A pending invite for this address, if one is outstanding. */
export async function pendingInviteId(
  db: TenantDatabase,
  email: string,
  now: Date,
): Promise<Buffer | undefined> {
  const row = await db
    .selectFrom('org_invites')
    .select('id')
    .where('email', '=', email)
    .where('accepted_at', 'is', null)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', now)
    .limit(1)
    .executeTakeFirst();

  return row?.id;
}

/**
 * The roles this org may assign, newest-seeded last.
 *
 * `is_system` is returned rather than filtered on, so the v2 custom-role editor
 * needs no change here: a custom role belonging to this org is assignable by the
 * same rule that makes a shared one assignable, and the flag is what lets a client
 * say which is which.
 */
export async function selectAssignableRoles(orgId: OrgId): Promise<readonly RoleRow[]> {
  return systemDb()
    .selectFrom('roles')
    .select(['id', 'code', 'name', 'description', 'is_system'])
    .where(roleVisibleTo(orgId))
    .orderBy('code', 'asc')
    .execute();
}

export async function selectAssignableRole(
  orgId: OrgId,
  roleId: Buffer,
): Promise<RoleRow | undefined> {
  return systemDb()
    .selectFrom('roles')
    .select(['id', 'code', 'name', 'description', 'is_system'])
    .where('id', '=', roleId)
    .where(roleVisibleTo(orgId))
    .executeTakeFirst();
}

/** The identity behind a user id, for the accept path and the invite message. */
export async function selectUser(userId: Buffer): Promise<
  | {
      readonly id: Buffer;
      readonly email: string;
      readonly display_name: string;
      readonly is_active: number;
    }
  | undefined
> {
  return systemDb()
    .selectFrom('users')
    .select(['id', 'email', 'display_name', 'is_active'])
    .where('id', '=', userId)
    .executeTakeFirst();
}

/**
 * `(roles.org_id = <org> OR roles.org_id IS NULL)`.
 *
 * A function rather than two inlined copies so the `IS NULL` half — which is what
 * admits the six seeded roles at all — cannot be dropped from one call site and
 * left in the other. The `= <org>` half is not decoration either: it is what stops
 * a custom role belonging to another org from becoming assignable here, which
 * would turn a role id into a cross-tenant capability.
 */
function roleVisibleTo(orgId: OrgId): Expression<SqlBool> {
  return sql<SqlBool>`(${sql.ref('roles.org_id')} = ${orgId} OR ${sql.ref('roles.org_id')} IS NULL)`;
}
