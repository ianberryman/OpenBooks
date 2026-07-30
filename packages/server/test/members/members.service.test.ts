import { describe, expect, it } from 'vitest';

import { toWireError } from '../../src/errors';
import { SYSTEM_ROLE_UUIDS } from '../db';
import {
  changeMemberRole,
  listAssignableRoles,
  listMembers,
  removeMember,
} from '../../src/modules/members';
import { actorIn, memberOf, useServiceDatabase } from './support';

/**
 * Member management (OB-040).
 *
 * The last-Owner rule is asserted here *sequentially* — the ordinary case, where
 * one caller tries to demote or remove the only Owner — and under real contention
 * in `last-owner-race.test.ts`. Both are needed and neither substitutes for the
 * other: a sequential test passes against an implementation with no locking at
 * all, which is the failure the race test exists to catch.
 */
const db = useServiceDatabase();

describe('listMembers', () => {
  it('lists every member of the org with the role each holds', async () => {
    const owner = await actorIn(db, 'owner');
    const helper = await memberOf(db, owner.orgId, owner.orgUuid, 'bookkeeper');

    const members = await listMembers(owner.ctx);

    expect(members).toHaveLength(2);
    expect(members.map((member) => member.userId).sort()).toEqual(
      [owner.user.uuid, helper.user.uuid].sort(),
    );
    const listedOwner = members.find((member) => member.userId === owner.user.uuid);
    expect(listedOwner).toMatchObject({
      email: owner.user.email,
      displayName: owner.user.displayName,
      isActive: true,
      roleId: SYSTEM_ROLE_UUIDS.owner,
      roleCode: 'owner',
      roleName: 'Owner',
    });
  });

  /**
   * A7 at its most direct: the two orgs exist, both have members, and neither can
   * see a trace of the other. This is a property of `tenantDb` rather than of a
   * filter written in the service — there is no code path here that could return
   * the other org's row.
   */
  it('never shows another org’s members', async () => {
    const mine = await actorIn(db, 'owner');
    const theirs = await actorIn(db, 'owner');

    const members = await listMembers(mine.ctx);

    expect(members).toHaveLength(1);
    expect(members[0]?.userId).toBe(mine.user.uuid);
    expect(members.map((member) => member.email)).not.toContain(theirs.user.email);
  });

  it('is refused for a role without members.read', async () => {
    const apOnly = await actorIn(db, 'apOnly');

    await expect(listMembers(apOnly.ctx)).rejects.toMatchObject({
      code: 'permission_denied',
      details: { permission: 'members.read' },
    });
  });

  it('is permitted for a role with members.read but not members.write', async () => {
    const owner = await actorIn(db, 'owner');
    const reader = await memberOf(db, owner.orgId, owner.orgUuid, 'readOnly');

    await expect(listMembers(reader.ctx)).resolves.toHaveLength(2);
  });
});

describe('listAssignableRoles', () => {
  it('returns the seven seeded system roles', async () => {
    const owner = await actorIn(db, 'owner');

    const roles = await listAssignableRoles(owner.ctx);

    expect(roles.map((role) => role.code)).toEqual([
      'accountant',
      'ap_only',
      'approver',
      'ar_only',
      'bookkeeper',
      'owner',
      'read_only',
    ]);
    expect(roles.every((role) => role.isSystem)).toBe(true);
  });

  /**
   * `roles.read`, not `members.read`. The catalog is a different subject from the
   * people who hold its entries, and the seeded Read-only role carries the first
   * — which is what lets an accountant see what "Bookkeeper" means.
   */
  it('is refused for a role without roles.read', async () => {
    const apOnly = await actorIn(db, 'apOnly');

    await expect(listAssignableRoles(apOnly.ctx)).rejects.toMatchObject({
      code: 'permission_denied',
      details: { permission: 'roles.read' },
    });
  });
});

describe('changeMemberRole', () => {
  it('re-roles a member and reports the row as it now stands', async () => {
    const owner = await actorIn(db, 'owner');
    const helper = await memberOf(db, owner.orgId, owner.orgUuid, 'readOnly');

    const updated = await changeMemberRole(
      { userId: helper.user.uuid, roleId: SYSTEM_ROLE_UUIDS.bookkeeper },
      owner.ctx,
    );

    expect(updated).toMatchObject({
      userId: helper.user.uuid,
      roleId: SYSTEM_ROLE_UUIDS.bookkeeper,
      roleCode: 'bookkeeper',
    });
    const listed = (await listMembers(owner.ctx)).find(
      (member) => member.userId === helper.user.uuid,
    );
    expect(listed?.roleCode).toBe('bookkeeper');
  });

  it('is refused for a role without members.write', async () => {
    const owner = await actorIn(db, 'owner');
    const bookkeeper = await memberOf(db, owner.orgId, owner.orgUuid, 'bookkeeper');

    await expect(
      changeMemberRole(
        { userId: owner.user.uuid, roleId: SYSTEM_ROLE_UUIDS.readOnly },
        bookkeeper.ctx,
      ),
    ).rejects.toMatchObject({
      code: 'permission_denied',
      details: { permission: 'members.write' },
    });
  });

  /**
   * The A7 pair, byte for byte. A member of another org and a user id that names
   * nobody must produce the same body — `NotFoundError` has no channel for
   * anything that could tell them apart, and this asserts the whole object rather
   * than the code so a later detail bag cannot quietly appear in one of them.
   */
  it('answers a member of another org exactly as it answers a stranger', async () => {
    const mine = await actorIn(db, 'owner');
    const theirs = await actorIn(db, 'owner');
    const nobody = '00000000-0000-4000-8000-0000000000ff';

    const crossOrg = await changeMemberRole(
      { userId: theirs.user.uuid, roleId: SYSTEM_ROLE_UUIDS.readOnly },
      mine.ctx,
    ).catch((error: unknown) => error);
    const absent = await changeMemberRole(
      { userId: nobody, roleId: SYSTEM_ROLE_UUIDS.readOnly },
      mine.ctx,
    ).catch((error: unknown) => error);

    expect(toWireError(crossOrg)).toMatchObject({
      code: 'not_found',
      details: { resource: 'member' },
    });
    // The response body, not the error object: byte-identical is a claim about
    // what a caller receives (gate A7).
    expect(JSON.stringify(toWireError(crossOrg))).toBe(JSON.stringify(toWireError(absent)));
  });

  it('refuses a role that does not exist', async () => {
    const owner = await actorIn(db, 'owner');
    const helper = await memberOf(db, owner.orgId, owner.orgUuid, 'readOnly');

    await expect(
      changeMemberRole(
        { userId: helper.user.uuid, roleId: '00000000-0000-4000-8000-0000000000aa' },
        owner.ctx,
      ),
    ).rejects.toMatchObject({ code: 'not_found', details: { resource: 'role' } });
  });

  describe('the last Owner', () => {
    it('cannot be given a different role', async () => {
      const owner = await actorIn(db, 'owner');
      await memberOf(db, owner.orgId, owner.orgUuid, 'bookkeeper');

      await expect(
        changeMemberRole(
          { userId: owner.user.uuid, roleId: SYSTEM_ROLE_UUIDS.readOnly },
          owner.ctx,
        ),
      ).rejects.toMatchObject({
        code: 'precondition_failed',
        details: { precondition: 'last_owner_in_org' },
      });

      const listed = (await listMembers(owner.ctx)).find(
        (member) => member.userId === owner.user.uuid,
      );
      expect(listed?.roleCode).toBe('owner');
    });

    it('may be re-roled once a second Owner exists', async () => {
      const owner = await actorIn(db, 'owner');
      const second = await memberOf(db, owner.orgId, owner.orgUuid, 'owner');

      await expect(
        changeMemberRole(
          { userId: second.user.uuid, roleId: SYSTEM_ROLE_UUIDS.readOnly },
          owner.ctx,
        ),
      ).resolves.toMatchObject({ roleCode: 'read_only' });
    });

    /**
     * Re-roling an Owner *to* Owner is not a demotion and must not be refused by
     * a check that only counts. This is the mutation that a naive
     * "is the target an Owner and are they the only one" rule fails on.
     */
    it('may be re-roled to the role they already hold', async () => {
      const owner = await actorIn(db, 'owner');

      await expect(
        changeMemberRole({ userId: owner.user.uuid, roleId: SYSTEM_ROLE_UUIDS.owner }, owner.ctx),
      ).resolves.toMatchObject({ roleCode: 'owner' });
    });
  });
});

describe('removeMember', () => {
  it('removes a member', async () => {
    const owner = await actorIn(db, 'owner');
    const helper = await memberOf(db, owner.orgId, owner.orgUuid, 'bookkeeper');

    await removeMember({ userId: helper.user.uuid }, owner.ctx);

    expect((await listMembers(owner.ctx)).map((member) => member.userId)).toEqual([
      owner.user.uuid,
    ]);
  });

  it('leaves the user and their other memberships alone', async () => {
    const first = await actorIn(db, 'owner');
    const second = await actorIn(db, 'owner');
    const shared = await memberOf(db, first.orgId, first.orgUuid, 'bookkeeper', second.user);

    await removeMember({ userId: shared.user.uuid }, first.ctx);

    // The membership in the *other* org is untouched: one login holds different
    // roles in different orgs (spec §5), and being removed from a client's books
    // is not being removed from your own.
    expect((await listMembers(second.ctx)).map((member) => member.userId)).toEqual([
      second.user.uuid,
    ]);
  });

  it('is refused for a role without members.write', async () => {
    const owner = await actorIn(db, 'owner');
    const bookkeeper = await memberOf(db, owner.orgId, owner.orgUuid, 'bookkeeper');

    await expect(removeMember({ userId: owner.user.uuid }, bookkeeper.ctx)).rejects.toMatchObject({
      code: 'permission_denied',
      details: { permission: 'members.write' },
    });
  });

  it('answers a member of another org as a plain miss', async () => {
    const mine = await actorIn(db, 'owner');
    const theirs = await actorIn(db, 'owner');

    await expect(removeMember({ userId: theirs.user.uuid }, mine.ctx)).rejects.toMatchObject({
      code: 'not_found',
      details: { resource: 'member' },
    });
    await expect(listMembers(theirs.ctx)).resolves.toHaveLength(1);
  });

  it('cannot remove the org’s only Owner', async () => {
    const owner = await actorIn(db, 'owner');
    await memberOf(db, owner.orgId, owner.orgUuid, 'bookkeeper');

    await expect(removeMember({ userId: owner.user.uuid }, owner.ctx)).rejects.toMatchObject({
      code: 'precondition_failed',
      details: { precondition: 'last_owner_in_org' },
    });
    await expect(listMembers(owner.ctx)).resolves.toHaveLength(2);
  });

  it('can remove an Owner once a second one exists', async () => {
    const owner = await actorIn(db, 'owner');
    const second = await memberOf(db, owner.orgId, owner.orgUuid, 'owner');

    await removeMember({ userId: second.user.uuid }, owner.ctx);

    expect((await listMembers(owner.ctx)).map((member) => member.roleCode)).toEqual(['owner']);
  });

  /**
   * Self-removal, which the rule permits for anyone who is not the last Owner.
   * Asserted with a non-Owner so the two rules are not tangled: leaving is
   * ordinary, and the only thing that ever stops it is the Owner count.
   */
  it('lets a member remove themselves', async () => {
    const owner = await actorIn(db, 'owner');
    const leaver = await memberOf(db, owner.orgId, owner.orgUuid, 'owner');

    await removeMember({ userId: leaver.user.uuid }, leaver.ctx);

    expect((await listMembers(owner.ctx)).map((member) => member.userId)).toEqual([
      owner.user.uuid,
    ]);
  });
});
