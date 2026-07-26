import { describe, expect, it } from 'vitest';

import { UNAUTHENTICATED_ID } from '../../src/context';
import { newUuid, uuidToBuffer } from '../../src/db';
import {
  NotFoundError,
  toWireError,
  UnauthenticatedError,
  ValidationError,
} from '../../src/errors';
import {
  createOrg,
  listMemberships,
  OWNER_ROLE_ID,
  resolveOrgMembership,
} from '../../src/modules/orgs';
import { bufferToUuid, SYSTEM_ROLE_UUIDS, systemRoleId } from '../db';
import { runAsIdentity, runUnauthenticated, useServiceDatabase } from '../auth/support';

/**
 * Org creation and the `org_members` many-to-many (spec §5, OB-015).
 */
const db = useServiceDatabase();

/** A scope for a user who exists but is not yet a member of anything. */
async function asNewUser() {
  const user = await db.factories.user();
  return {
    user,
    scope: {
      orgId: UNAUTHENTICATED_ID,
      roleId: UNAUTHENTICATED_ID,
      userId: user.uuid,
      actorType: 'user' as const,
      actorId: user.uuid,
    },
  };
}

describe('createOrg', () => {
  it('seeds the creating user as Owner', async () => {
    const { user, scope } = await asNewUser();

    const created = await runAsIdentity(scope, () => createOrg({ name: 'Seeded Books' }));

    expect(created.roleId).toBe(OWNER_ROLE_ID);
    expect(created.roleCode).toBe('owner');
    // The reserved id from `0001_tenancy`, which is why it can be a literal rather than a
    // lookup by code.
    expect(OWNER_ROLE_ID).toBe('00000000-0000-4000-8000-000000000001');

    const membership = await db.app
      .selectFrom('org_members')
      .selectAll()
      .where('user_id', '=', user.id)
      .executeTakeFirstOrThrow();
    expect(membership.role_id).toEqual(systemRoleId('owner'));
    expect(membership.org_id).toEqual(uuidToBuffer(created.org.id));
  });

  it('accepts a fiscal year start month and defaults it to January (D-17)', async () => {
    const { scope } = await asNewUser();

    const july = await runAsIdentity(scope, () =>
      createOrg({ name: 'July Books', fiscalYearStartMonth: 7 }),
    );
    const january = await runAsIdentity(scope, () => createOrg({ name: 'January Books' }));

    expect(july.org.fiscalYearStartMonth).toBe(7);
    expect(january.org.fiscalYearStartMonth).toBe(1);

    const row = await db.app
      .selectFrom('orgs')
      .select('fiscal_year_start_month')
      .where('id', '=', uuidToBuffer(july.org.id))
      .executeTakeFirstOrThrow();
    expect(row.fiscal_year_start_month).toBe(7);
  });

  it('rejects a month outside 1–12 as a validation failure, not a driver error', async () => {
    // `chk_orgs_fiscal_year_start_month` is the guarantee; this check is what makes a bad
    // value a 400 naming the field instead of a 500.
    const { scope } = await asNewUser();

    for (const month of [0, 13, -1, 1.5]) {
      const thrown = await runAsIdentity(scope, () =>
        createOrg({ name: 'Bad Month Books', fiscalYearStartMonth: month }).then(
          () => undefined,
          (error: unknown) => error,
        ),
      );
      expect(thrown).toBeInstanceOf(ValidationError);
      expect(toWireError(thrown).status).toBe(400);
    }
  });

  it('rejects an empty or over-long name', async () => {
    const { scope } = await asNewUser();

    await expect(runAsIdentity(scope, () => createOrg({ name: '  ' }))).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      runAsIdentity(scope, () => createOrg({ name: 'x'.repeat(256) })),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('refuses the pre-auth scope', async () => {
    // There is no permission that would fit — every entry in the catalog is authority
    // *within* an org, and this runs before the org exists. Being a real user is the gate.
    await expect(
      runUnauthenticated(() => createOrg({ name: 'Nobody Books' })),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});

describe('slug derivation', () => {
  it('derives the slug from the name', async () => {
    const { scope } = await asNewUser();

    const created = await runAsIdentity(scope, () =>
      createOrg({ name: "  Ada's Bookkeeping & Co.  " }),
    );

    expect(created.org.slug).toBe('ada-s-bookkeeping-co');
  });

  it('disambiguates a collision with entropy rather than reporting it', async () => {
    // `uq_orgs_slug` is global, so "that slug is taken" would be a probe for whether any
    // tenant in the system is called something — A7's oracle applied to names. Two orgs with
    // the same name is an ordinary thing (there is more than one "Consulting").
    const { scope } = await asNewUser();

    const first = await runAsIdentity(scope, () => createOrg({ name: 'Consulting' }));
    const second = await runAsIdentity(scope, () => createOrg({ name: 'Consulting' }));

    expect(first.org.slug).toBe('consulting');
    expect(second.org.slug).toMatch(/^consulting-[0-9a-f]{6}$/);
    expect(second.org.name).toBe('Consulting');
  });

  it('falls back to a placeholder for a name with no ASCII alphanumerics', async () => {
    // An ordinary name in most of the world's scripts. The slug is a URL convenience;
    // `orgs.id` is the identity.
    const { scope } = await asNewUser();

    const created = await runAsIdentity(scope, () => createOrg({ name: '簿記' }));

    expect(created.org.slug).toBe('org');
    expect(created.org.name).toBe('簿記');
  });

  it('keeps the slug inside the column width', async () => {
    const { scope } = await asNewUser();

    const created = await runAsIdentity(scope, () => createOrg({ name: 'a'.repeat(255) }));

    expect(created.org.slug.length).toBeLessThanOrEqual(120);
  });
});

describe('listMemberships', () => {
  it('gives one login a different role in each org (spec §5)', async () => {
    const user = await db.factories.user();
    const own = await db.factories.org({ name: 'Own Books', slug: `own-${newUuid()}` });
    const client = await db.factories.org({ name: 'Client Books', slug: `client-${newUuid()}` });
    await db.factories.orgMember({ orgId: own.id, userId: user.id, role: 'owner' });
    await db.factories.orgMember({ orgId: client.id, userId: user.id, role: 'readOnly' });

    const memberships = await listMemberships(user.uuid);

    const byOrg = new Map(memberships.map((entry) => [entry.org.id, entry]));
    expect(byOrg.size).toBe(2);
    expect(byOrg.get(own.uuid)?.roleId).toBe(SYSTEM_ROLE_UUIDS.owner);
    expect(byOrg.get(client.uuid)?.roleCode).toBe('read_only');
  });

  it('is empty for a user who belongs to nothing, and for a malformed id', async () => {
    const user = await db.factories.user();

    expect(await listMemberships(user.uuid)).toEqual([]);
    expect(await listMemberships('not-a-uuid')).toEqual([]);
  });

  it("never lists another user's orgs", async () => {
    const mine = await db.factories.orgMember();
    const theirs = await db.factories.orgMember();

    const memberships = await listMemberships(bufferToUuid(mine.userId));

    expect(memberships.map((entry) => entry.org.id)).toEqual([bufferToUuid(mine.orgId)]);
    expect(memberships.map((entry) => entry.org.id)).not.toContain(bufferToUuid(theirs.orgId));
  });

  it('drops a membership whose role belongs to another org', async () => {
    // Fail closed. Offering an org the user cannot act in is worse than not offering it:
    // the switch would succeed and every subsequent request would be denied.
    const user = await db.factories.user();
    const org = await db.factories.org({ name: 'Foreign Role', slug: `foreign-${newUuid()}` });
    const other = await db.factories.org({ name: 'Other', slug: `other-${newUuid()}` });
    const roleId = uuidToBuffer(newUuid());

    await db.app
      .insertInto('roles')
      .values({
        id: roleId,
        org_id: other.id,
        code: 'other_orgs_role',
        name: "Other Org's Role",
        description: 'Test-only custom role belonging to a different org.',
        is_system: 0,
      })
      .execute();
    await db.factories.orgMember({ orgId: org.id, userId: user.id, roleId });

    expect(await listMemberships(user.uuid)).toEqual([]);
  });
});

describe('resolveOrgMembership is the A7 conversion', () => {
  it('answers a non-member org exactly as a nonexistent one', async () => {
    const user = await db.factories.user();
    const someoneElses = await db.factories.org({ name: 'Theirs', slug: `theirs-${newUuid()}` });
    await db.factories.orgMember({ orgId: someoneElses.id, role: 'owner' });

    const nonMember = await resolveOrgMembership(user.uuid, someoneElses.uuid).then(
      () => undefined,
      (error: unknown) => error,
    );
    const nonExistent = await resolveOrgMembership(user.uuid, newUuid()).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(nonMember).toBeInstanceOf(NotFoundError);
    expect(JSON.stringify(toWireError(nonMember))).toBe(JSON.stringify(toWireError(nonExistent)));
    expect(toWireError(nonMember).status).toBe(404);
  });

  it('returns the membership for a member', async () => {
    const member = await db.factories.orgMember({ role: 'bookkeeper' });
    const userUuid = bufferToUuid(member.userId);
    const orgUuid = bufferToUuid(member.orgId);

    const membership = await resolveOrgMembership(userUuid, orgUuid);

    expect(membership.org.id).toBe(orgUuid);
    expect(membership.roleCode).toBe('bookkeeper');
    expect(membership.roleId).toBe(SYSTEM_ROLE_UUIDS.bookkeeper);
  });
});
