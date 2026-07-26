import { describe, expect, it } from 'vitest';

import { uuidToBuffer } from '../../src/db';
import {
  ConflictError,
  toWireError,
  UnauthenticatedError,
  ValidationError,
} from '../../src/errors';
import { login, logout, me, register, resolveSessionIdentity } from '../../src/modules/auth';
import { OWNER_ROLE_ID } from '../../src/modules/orgs';
import { SYSTEM_ROLE_UUIDS, systemRoleId } from '../db';
import {
  cookieJar,
  runAsIdentity,
  runUnauthenticated,
  useServiceDatabase,
  VALID_PASSWORD,
} from './support';

/**
 * Register, login, logout, and `me` (spec §5, OB-015).
 *
 * The harness is registered once for the file: every case here needs the same container
 * and the same per-test reset.
 */
const db = useServiceDatabase();

type CountableTable = 'users' | 'orgs' | 'org_members' | 'sessions';

async function rowCount(table: CountableTable): Promise<number> {
  const row = await db.app
    .selectFrom(table)
    .select(({ fn }) => fn.countAll<number>().as('count'))
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

async function capture(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('register', () => {
  it('creates the user, the org, an Owner membership, and a session', async () => {
    const issued = await register({
      email: 'Founder@OpenBooks.test',
      password: VALID_PASSWORD,
      displayName: '  Founder  ',
      org: { name: 'Founder Books', fiscalYearStartMonth: 4 },
    });

    // Email lowercased and display name trimmed on the way in, so the stored value agrees
    // with the comparison rather than depending on the collation to.
    expect(issued.identity.user.email).toBe('founder@openbooks.test');
    expect(issued.identity.user.displayName).toBe('Founder');

    const user = await db.app.selectFrom('users').selectAll().executeTakeFirstOrThrow();
    expect(user.email).toBe('founder@openbooks.test');
    expect(user.password_hash).not.toContain(VALID_PASSWORD);

    const org = await db.app.selectFrom('orgs').selectAll().executeTakeFirstOrThrow();
    expect(org.name).toBe('Founder Books');
    expect(org.slug).toBe('founder-books');
    // ROADMAP D-17: the fiscal year's start month is a per-org setting.
    expect(org.fiscal_year_start_month).toBe(4);

    const membership = await db.app.selectFrom('org_members').selectAll().executeTakeFirstOrThrow();
    expect(membership.org_id).toEqual(org.id);
    expect(membership.user_id).toEqual(user.id);
    // The seeded system role's reserved id, not a lookup by code.
    expect(membership.role_id).toEqual(systemRoleId('owner'));

    expect(issued.identity.memberships).toHaveLength(1);
    expect(issued.identity.memberships[0]?.roleId).toBe(OWNER_ROLE_ID);
    expect(issued.identity.memberships[0]?.roleCode).toBe('owner');
    expect(issued.identity.memberships[0]?.org.fiscalYearStartMonth).toBe(4);

    const session = await db.app.selectFrom('sessions').selectAll().executeTakeFirstOrThrow();
    expect(session.user_id).toEqual(user.id);
    expect(session.active_org_id).toEqual(org.id);
    expect(issued.identity.activeOrgId).toBe(issued.identity.memberships[0]?.org.id);
  });

  it('defaults the fiscal year to January', async () => {
    await register({
      email: 'january@openbooks.test',
      password: VALID_PASSWORD,
      displayName: 'January',
      org: { name: 'January Books' },
    });

    const org = await db.app
      .selectFrom('orgs')
      .select('fiscal_year_start_month')
      .executeTakeFirstOrThrow();
    expect(org.fiscal_year_start_month).toBe(1);
  });

  it('rejects malformed input before anything is written', async () => {
    const base = {
      email: 'valid@openbooks.test',
      password: VALID_PASSWORD,
      displayName: 'Valid',
      org: { name: 'Valid Books' },
    };

    await expect(register({ ...base, email: 'not-an-email' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(register({ ...base, password: 'short' })).rejects.toBeInstanceOf(ValidationError);
    await expect(register({ ...base, password: 'x'.repeat(257) })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(register({ ...base, displayName: '   ' })).rejects.toBeInstanceOf(ValidationError);
    await expect(register({ ...base, org: { name: '' } })).rejects.toBeInstanceOf(ValidationError);
    await expect(
      register({ ...base, org: { name: 'Valid Books', fiscalYearStartMonth: 13 } }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(await rowCount('users')).toBe(0);
    expect(await rowCount('orgs')).toBe(0);
  });

  it('reports a taken email address', async () => {
    const first = {
      email: 'taken@openbooks.test',
      password: VALID_PASSWORD,
      displayName: 'First',
      org: { name: 'First Books' },
    };
    await register(first);

    // A disclosure, chosen knowingly: the privacy-preserving alternative needs an
    // EmailProvider adapter, which ROADMAP D-07 defers. See `emailTakenError`.
    await expect(register({ ...first, displayName: 'Second' })).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(await rowCount('users')).toBe(1);
    expect(await rowCount('orgs')).toBe(1);
  });

  it('leaves nothing behind when two registrations race for one email', async () => {
    // The failure path *inside* the transaction: the pre-check passes for both, one insert
    // wins `uq_users_email`, and the loser's org and session must not survive it. An org
    // with no members is unreachable forever, so a partial commit here is permanent litter.
    const input = {
      email: 'race@openbooks.test',
      password: VALID_PASSWORD,
      displayName: 'Racer',
      org: { name: 'Race Books' },
    };

    const results = await Promise.allSettled([register(input), register(input)]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await rowCount('users')).toBe(1);
    expect(await rowCount('orgs')).toBe(1);
    expect(await rowCount('org_members')).toBe(1);
    expect(await rowCount('sessions')).toBe(1);
  });
});

describe('login', () => {
  it('exchanges the right password for a session', async () => {
    await register({
      email: 'signin@openbooks.test',
      password: VALID_PASSWORD,
      displayName: 'Signin',
      org: { name: 'Signin Books' },
    });

    const issued = await login({ email: 'SIGNIN@openbooks.test', password: VALID_PASSWORD });

    expect(issued.identity.user.email).toBe('signin@openbooks.test');
    expect(issued.identity.memberships).toHaveLength(1);
    expect(issued.identity.activeOrgId).toBe(issued.identity.memberships[0]?.org.id);
    expect(await rowCount('sessions')).toBe(2);
  });

  it('refuses a wrong password', async () => {
    await register({
      email: 'wrongpass@openbooks.test',
      password: VALID_PASSWORD,
      displayName: 'Wrong Pass',
      org: { name: 'Wrong Pass Books' },
    });

    await expect(
      login({ email: 'wrongpass@openbooks.test', password: `${VALID_PASSWORD}!` }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('answers a wrong password and an unknown address identically', async () => {
    // `UnauthenticatedError` takes no message precisely so these cannot be told apart —
    // A7's reasoning applied one layer earlier. Compared as serialized bytes, because a
    // matching status with a differing body is still an enumeration oracle.
    await register({
      email: 'oracle@openbooks.test',
      password: VALID_PASSWORD,
      displayName: 'Oracle',
      org: { name: 'Oracle Books' },
    });

    const wrongPassword = await capture(
      login({ email: 'oracle@openbooks.test', password: 'not the one' }),
    );
    const noSuchUser = await capture(
      login({ email: 'nobody@openbooks.test', password: 'not the one' }),
    );
    const malformedEmail = await capture(login({ email: 'not-an-email', password: 'not the one' }));

    expect(JSON.stringify(toWireError(wrongPassword))).toBe(
      JSON.stringify(toWireError(noSuchUser)),
    );
    expect(JSON.stringify(toWireError(malformedEmail))).toBe(
      JSON.stringify(toWireError(noSuchUser)),
    );
    expect(toWireError(noSuchUser).status).toBe(401);
  });

  it('refuses a deactivated user', async () => {
    await register({
      email: 'deactivated@openbooks.test',
      password: VALID_PASSWORD,
      displayName: 'Deactivated',
      org: { name: 'Deactivated Books' },
    });
    await db.app.updateTable('users').set({ is_active: 0 }).execute();

    await expect(
      login({ email: 'deactivated@openbooks.test', password: VALID_PASSWORD }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('records the sign-in', async () => {
    await register({
      email: 'lastlogin@openbooks.test',
      password: VALID_PASSWORD,
      displayName: 'Last Login',
      org: { name: 'Last Login Books' },
    });
    const before = await db.app
      .selectFrom('users')
      .select('last_login_at')
      .executeTakeFirstOrThrow();
    expect(before.last_login_at).toBeNull();

    await login({ email: 'lastlogin@openbooks.test', password: VALID_PASSWORD });

    const after = await db.app
      .selectFrom('users')
      .select('last_login_at')
      .executeTakeFirstOrThrow();
    expect(after.last_login_at).not.toBeNull();
  });

  it('resolves a different role in each of two orgs (spec §5)', async () => {
    // The many-to-many is the reason a role cannot be cached against a user or a session:
    // an accountant is Owner of their own books and Read-only on a client's, in one login.
    const owned = await register({
      email: 'accountant@openbooks.test',
      password: VALID_PASSWORD,
      displayName: 'Accountant',
      org: { name: 'Alpha Books' },
    });
    const ownedOrgId = owned.identity.memberships[0]?.org.id;

    const client = await db.factories.org({ name: 'Beta Books', slug: 'beta-books' });
    await db.factories.orgMember({
      orgId: client.id,
      userId: uuidToBuffer(owned.identity.user.id),
      role: 'readOnly',
    });

    const issued = await login({ email: 'accountant@openbooks.test', password: VALID_PASSWORD });

    const byOrg = new Map(issued.identity.memberships.map((entry) => [entry.org.id, entry]));
    expect(byOrg.size).toBe(2);
    expect(byOrg.get(ownedOrgId ?? '')?.roleId).toBe(SYSTEM_ROLE_UUIDS.owner);
    expect(byOrg.get(ownedOrgId ?? '')?.roleCode).toBe('owner');
    expect(byOrg.get(client.uuid)?.roleId).toBe(SYSTEM_ROLE_UUIDS.readOnly);
    expect(byOrg.get(client.uuid)?.roleCode).toBe('read_only');

    // And the scope the session actually runs in carries the role of *that* org, not one
    // remembered from the login.
    const identity = await resolveSessionIdentity(cookieJar(issued.sessionToken));
    expect(identity?.orgId).toBe(ownedOrgId);
    expect(identity?.roleId).toBe(SYSTEM_ROLE_UUIDS.owner);
  });
});

describe('logout', () => {
  it('revokes the session the token names', async () => {
    const { sessionToken } = await register({
      email: 'logout@openbooks.test',
      password: VALID_PASSWORD,
      displayName: 'Logout',
      org: { name: 'Logout Books' },
    });

    await logout(sessionToken);

    const session = await db.app
      .selectFrom('sessions')
      .select('revoked_at')
      .executeTakeFirstOrThrow();
    expect(session.revoked_at).not.toBeNull();
  });

  it('is a no-op for a token that names nothing', async () => {
    // The one operation a client legitimately calls with a stale cookie. A 404 would both
    // break that and confirm which tokens were once real.
    await expect(logout('a token that was never issued')).resolves.toBeUndefined();
    expect(await rowCount('sessions')).toBe(0);
  });

  it("does not revoke the user's other sessions", async () => {
    await register({
      email: 'twobrowsers@openbooks.test',
      password: VALID_PASSWORD,
      displayName: 'Two Browsers',
      org: { name: 'Two Browsers Books' },
    });
    const first = await login({ email: 'twobrowsers@openbooks.test', password: VALID_PASSWORD });
    const second = await login({ email: 'twobrowsers@openbooks.test', password: VALID_PASSWORD });

    await logout(first.sessionToken);

    await expect(resolveSessionIdentity(cookieJar(first.sessionToken))).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
    expect((await resolveSessionIdentity(cookieJar(second.sessionToken)))?.userId).toBe(
      second.identity.user.id,
    );
  });
});

describe('me', () => {
  it('returns the user, the org menu, and the active org', async () => {
    const issued = await register({
      email: 'whoami@openbooks.test',
      password: VALID_PASSWORD,
      displayName: 'Who Am I',
      org: { name: 'Whoami Books' },
    });
    const identity = await resolveSessionIdentity(cookieJar(issued.sessionToken));
    expect(identity).not.toBeNull();

    const result = await runAsIdentity(identity!, () => me());

    expect(result.user).toEqual(issued.identity.user);
    expect(result.memberships).toHaveLength(1);
    expect(result.activeOrgId).toBe(issued.identity.activeOrgId);
  });

  it('refuses the pre-auth scope', async () => {
    await expect(runUnauthenticated(() => me())).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('works for a user who is a member of nothing', async () => {
    // Reached by being removed from the last org. The session is valid, there is no org
    // scope, and `me` is exactly the call that tells a client to say so rather than bounce
    // to a login form that will succeed and change nothing.
    const issued = await register({
      email: 'orphan@openbooks.test',
      password: VALID_PASSWORD,
      displayName: 'Orphan',
      org: { name: 'Orphan Books' },
    });
    await db.app.deleteFrom('org_members').execute();

    const identity = await resolveSessionIdentity(cookieJar(issued.sessionToken));
    const result = await runAsIdentity(identity!, () => me());

    expect(result.memberships).toEqual([]);
    expect(result.activeOrgId).toBeNull();
    expect(result.user.email).toBe('orphan@openbooks.test');
  });

  it('refuses a context whose user has been deactivated', async () => {
    const issued = await register({
      email: 'gone@openbooks.test',
      password: VALID_PASSWORD,
      displayName: 'Gone',
      org: { name: 'Gone Books' },
    });
    const identity = await resolveSessionIdentity(cookieJar(issued.sessionToken));
    await db.app.updateTable('users').set({ is_active: 0 }).execute();

    await expect(runAsIdentity(identity!, () => me())).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});
