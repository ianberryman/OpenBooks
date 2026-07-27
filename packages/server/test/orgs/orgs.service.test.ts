import { describe, expect, it } from 'vitest';

import { UNAUTHENTICATED_ID } from '../../src/context';
import { newUuid, uuidToBuffer } from '../../src/db';
import {
  NotFoundError,
  toWireError,
  UnauthenticatedError,
  ValidationError,
} from '../../src/errors';
import { CHART_TEMPLATES } from '../../src/modules/accounts';
import { register } from '../../src/modules/auth';
import { withGlobalIdempotency } from '../../src/modules/idempotency';
import type { OrgCreationInput } from '../../src/modules/orgs';
import {
  createOrg,
  listMemberships,
  OWNER_ROLE_ID,
  resolveOrgMembership,
} from '../../src/modules/orgs';
import { bufferToUuid, SYSTEM_ROLE_UUIDS, systemRoleId } from '../db';
import {
  runAsIdentity,
  runAsIdentityWithKey,
  runUnauthenticated,
  useServiceDatabase,
  VALID_PASSWORD,
} from '../auth/support';

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

/**
 * Read from the table rather than through `listAccounts`, so the assertion does not
 * depend on the org being reachable from a context — which is the thing under test in
 * the rollback case, where there is no org to build one for.
 */
async function chartCodes(orgUuid: string): Promise<readonly string[]> {
  const rows = await db.app
    .selectFrom('accounts')
    .select('code')
    .where('org_id', '=', uuidToBuffer(orgUuid))
    .execute();

  return rows.map((row) => row.code);
}

/** The slugs of every org carrying `name`, which is how a rolled-back org is looked for. */
async function slugsOfOrgsNamed(name: string): Promise<readonly string[]> {
  const rows = await db.app.selectFrom('orgs').select('slug').where('name', '=', name).execute();
  return rows.map((row) => row.slug);
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

/**
 * The opt-in starter chart at org creation (OB-039, ROADMAP D-23).
 *
 * Two claims, and the second is the one that matters. The first is that a template
 * named at creation is applied. The second is that nothing else changed: an org
 * created without one has no accounts, exactly as it did before this field existed,
 * because D-23's argument is that a chart arriving uninvited is a chart the user
 * deletes account by account.
 *
 * The third suite below is the one that could not be written as an afterthought. The
 * chart is applied inside `createOrgIn`'s transaction, and a happy-path test passes
 * just as well against two separate transactions — so the boundary is proven by
 * making the application fail and looking for the org.
 */
describe('the starter chart at org creation (D-23)', () => {
  it('applies the named template into the new org', async () => {
    const { scope } = await asNewUser();

    const created = await runAsIdentity(scope, () =>
      createOrg({ name: 'Chartered Books', chartTemplateId: 'general_small_business' }),
    );

    const codes = await chartCodes(created.org.id);
    const template = CHART_TEMPLATES.general_small_business;
    expect(codes).toHaveLength(template.accounts.length);
    expect([...codes].sort()).toEqual(template.accounts.map((entry) => entry.code).sort());
  });

  it('creates no accounts at all when no template is named', async () => {
    // The load-bearing half of D-23. An org that did not ask for a chart gets none —
    // not a default template, not a partial one.
    const { scope } = await asNewUser();

    const created = await runAsIdentity(scope, () => createOrg({ name: 'Bare Books' }));

    expect(await chartCodes(created.org.id)).toEqual([]);
  });

  it('applies it on the registration path too, from the pre-auth scope', async () => {
    // `register` creates the user, the org and the membership in one transaction and
    // reaches the same `createOrgIn`. Its surrounding scope is the pre-auth sentinel,
    // which is what the derived org scope has to be built from — there is no
    // authenticated context to inherit at signup.
    const issued = await runUnauthenticated(() =>
      register({
        email: 'chartered@openbooks.test',
        password: VALID_PASSWORD,
        displayName: 'Chartered',
        org: { name: 'Registered Books', chartTemplateId: 'general_small_business' },
      }),
    );

    const orgId = issued.identity.activeOrgId;
    expect(orgId).not.toBeNull();

    const codes = await chartCodes(orgId ?? '');
    expect(codes).toHaveLength(CHART_TEMPLATES.general_small_business.accounts.length);
  });
});

describe('the chart is applied inside the org’s own transaction', () => {
  it('creates no org when the template cannot be applied', async () => {
    // Nothing in `orgs.service.ts` inspects `chartTemplateId`; the only thing that can
    // refuse it is `applyChartTemplate`'s `parseInput`, which runs *after* `insertOrg`
    // and `insertMembership` have written their rows. So an org surviving this call is
    // a direct observation of two transactions rather than one.
    const { scope } = await asNewUser();
    const input = {
      name: 'Rolled Back Books',
      chartTemplateId: 'no_such_template',
    } as unknown as OrgCreationInput;

    const thrown = await runAsIdentity(scope, () =>
      createOrg(input).then(
        () => undefined,
        (error: unknown) => error,
      ),
    );

    expect(thrown).toBeInstanceOf(ValidationError);
    expect(toWireError(thrown).status).toBe(400);
    expect(await slugsOfOrgsNamed('Rolled Back Books')).toEqual([]);
  });

  it('leaves the slug free, so the rolled-back row is gone rather than hidden', async () => {
    // A name query answering "none" would also be the answer if the row had committed
    // under a different name. The slug is the independent witness: `uq_orgs_slug` is
    // global, so a surviving row would push this create onto a random suffix.
    const { scope } = await asNewUser();
    const input = {
      name: 'Contested Books',
      chartTemplateId: 'no_such_template',
    } as unknown as OrgCreationInput;

    await expect(runAsIdentity(scope, () => createOrg(input))).rejects.toBeInstanceOf(
      ValidationError,
    );
    const created = await runAsIdentity(scope, () => createOrg({ name: 'Contested Books' }));

    expect(created.org.slug).toBe('contested-books');
  });

  it('yields one org with one chart when the create is retried under a key', async () => {
    // OB-028's claim opens the transaction the chart then joins. A second application
    // would collide on `uq_accounts_org_code` and be refused, so a duplicated chart is
    // not the failure mode here — a second *org* is.
    const { user, scope } = await asNewUser();
    const input = { name: 'Retried Books', chartTemplateId: 'general_small_business' as const };
    const spec = { endpoint: 'createOrg', request: input, successStatus: 201 };

    const first = await runAsIdentityWithKey(scope, 'create-org-with-chart', () =>
      withGlobalIdempotency(spec, () => createOrg(input)),
    );
    const second = await runAsIdentityWithKey(scope, 'create-org-with-chart', () =>
      withGlobalIdempotency(spec, () => createOrg(input)),
    );

    expect(first.outcome).toBe('executed');
    expect(second.outcome).toBe('replayed');
    expect(await slugsOfOrgsNamed('Retried Books')).toEqual(['retried-books']);

    const orgs = await listMemberships(user.uuid);
    const retried = orgs.find((entry) => entry.org.name === 'Retried Books');
    expect(retried).toBeDefined();
    expect(await chartCodes(retried?.org.id ?? '')).toHaveLength(
      CHART_TEMPLATES.general_small_business.accounts.length,
    );
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
