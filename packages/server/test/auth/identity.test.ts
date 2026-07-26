import { describe, expect, it } from 'vitest';

import { isAuthenticatedContext, UNAUTHENTICATED_ID } from '../../src/context';
import { newUuid, uuidToBuffer } from '../../src/db';
import { UnauthenticatedError } from '../../src/errors';
import type { IssuedSession } from '../../src/modules/auth';
import { logout, register, resolveSessionIdentity, SESSION_TTL_MS } from '../../src/modules/auth';
import { permissionsForContext, resolveMembership } from '../../src/modules/permissions';
import { SYSTEM_ROLE_UUIDS, systemRoleId } from '../db';
import { contextFor, cookieJar, NO_COOKIES, useServiceDatabase, VALID_PASSWORD } from './support';

/**
 * The `IdentityResolver` OB-022 left a seam for: cookie in, request scope out.
 *
 * The load-bearing claims here are that `sessions.active_org_id` is re-validated on every
 * call rather than trusted, and that nothing about a session or a role is cached across
 * calls. See `src/modules/auth/identity.ts` for the reasoning each case pins.
 */
const db = useServiceDatabase();

let sequence = 0;

async function registerUser(orgName = 'Resolver Books'): Promise<IssuedSession> {
  sequence += 1;
  return register({
    email: `resolver-${sequence}@openbooks.test`,
    password: VALID_PASSWORD,
    displayName: `Resolver ${sequence}`,
    org: { name: `${orgName} ${sequence}` },
  });
}

describe('no credentials is not an error', () => {
  it('returns null when there is no cookie', async () => {
    // Unauthenticated requests are legal: `/health` and the login routes run in the
    // pre-auth scope.
    await expect(resolveSessionIdentity(NO_COOKIES)).resolves.toBeNull();
  });

  it('returns null for an emptied cookie', async () => {
    await expect(resolveSessionIdentity(cookieJar(''))).resolves.toBeNull();
  });
});

describe('a credential that was presented and is not usable', () => {
  it('rejects a token that names no session', async () => {
    // Nothing this system issues produces a digest matching no row: forged, mangled, or
    // from another deployment. Worth telling apart from ordinary expiry (spec §14's open
    // item on security-event logging).
    await expect(resolveSessionIdentity(cookieJar('never-issued'))).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  it('stops authorizing the moment a session is revoked mid-life', async () => {
    const issued = await registerUser();
    expect((await resolveSessionIdentity(cookieJar(issued.sessionToken)))?.userId).toBe(
      issued.identity.user.id,
    );

    await logout(issued.sessionToken);

    // Immediate, with no cache to wait out. This is the property ROADMAP D-03 chose
    // server-side sessions over signed stateless cookies for.
    await expect(resolveSessionIdentity(cookieJar(issued.sessionToken))).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  it('rejects a live session whose user has been deactivated', async () => {
    const issued = await registerUser();
    await db.app.updateTable('users').set({ is_active: 0 }).execute();

    await expect(resolveSessionIdentity(cookieJar(issued.sessionToken))).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });
});

describe('expiry is enforced', () => {
  it('treats an expired session as no credentials at all', async () => {
    const issued = await registerUser();

    await db.app
      .updateTable('sessions')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .execute();

    // `null`, not a 401, and deliberately: the hook runs for every route, so throwing here
    // would make `POST /v1/auth/login` refuse the user whose session merely aged out —
    // locking them out of the endpoint that fixes it.
    await expect(resolveSessionIdentity(cookieJar(issued.sessionToken))).resolves.toBeNull();
  });

  it('accepts a session one second from expiring', async () => {
    const issued = await registerUser();

    await db.app
      .updateTable('sessions')
      .set({ expires_at: new Date(Date.now() + 1000) })
      .execute();

    await expect(resolveSessionIdentity(cookieJar(issued.sessionToken))).resolves.not.toBeNull();
  });

  it('writes an expiry the configured lifetime away, not a database-clocked one', async () => {
    const issued = await registerUser();
    const row = await db.app.selectFrom('sessions').select('expires_at').executeTakeFirstOrThrow();

    // The application clock decides expiry because the application clock wrote it. Two
    // clocks on one question would make the session length depend on their skew.
    expect(row.expires_at.getTime()).toBe(issued.expiresAt.getTime());
    expect(row.expires_at.getTime() - Date.now()).toBeGreaterThan(SESSION_TTL_MS - 60_000);
  });
});

describe('active_org_id is a hint, re-validated every time', () => {
  it('uses the stored org when the membership still holds', async () => {
    const issued = await registerUser();
    const orgId = issued.identity.memberships[0]?.org.id;

    const identity = await resolveSessionIdentity(cookieJar(issued.sessionToken));

    expect(identity?.orgId).toBe(orgId);
    expect(identity?.roleId).toBe(SYSTEM_ROLE_UUIDS.owner);
    expect(identity?.actorType).toBe('user');
    expect(identity?.actorId).toBe(issued.identity.user.id);
    // plugin-api forbids defaulting this, and `chk_journals_invocation_mode` requires it
    // to be absent for a non-agent actor.
    expect('invocationMode' in identity!).toBe(false);
  });

  it('ignores a stored org the user is no longer a member of', async () => {
    // The exact case migration `0001_tenancy` says the column cannot be a foreign key for.
    const issued = await registerUser();
    const leftOrgId = issued.identity.memberships[0]?.org.id ?? '';
    const stillMine = await db.factories.org({ name: 'Kept Books', slug: `kept-${newUuid()}` });
    await db.factories.orgMember({
      orgId: stillMine.id,
      userId: uuidToBuffer(issued.identity.user.id),
      role: 'bookkeeper',
    });

    await db.app.deleteFrom('org_members').where('org_id', '=', uuidToBuffer(leftOrgId)).execute();

    const identity = await resolveSessionIdentity(cookieJar(issued.sessionToken));

    expect(identity?.orgId).toBe(stillMine.uuid);
    expect(identity?.roleId).toBe(SYSTEM_ROLE_UUIDS.bookkeeper);
    // Nothing is written back. The correction is recomputed per request, so two concurrent
    // requests cannot race to store different answers.
    const session = await db.app
      .selectFrom('sessions')
      .select('active_org_id')
      .executeTakeFirstOrThrow();
    expect(session.active_org_id).toEqual(uuidToBuffer(leftOrgId));
  });

  it('ignores a stored org that has been deleted', async () => {
    const issued = await registerUser();
    const secondary = await db.factories.org({ name: 'Second Books', slug: `second-${newUuid()}` });
    await db.factories.orgMember({
      orgId: secondary.id,
      userId: uuidToBuffer(issued.identity.user.id),
      role: 'owner',
    });

    // `fk_sessions_active_org` is ON DELETE SET NULL, so this leaves the hint null.
    await db.app
      .deleteFrom('orgs')
      .where('id', '=', uuidToBuffer(issued.identity.memberships[0]?.org.id ?? ''))
      .execute();

    const identity = await resolveSessionIdentity(cookieJar(issued.sessionToken));
    expect(identity?.orgId).toBe(secondary.uuid);
  });

  it('scopes a member of nothing to the pre-auth sentinel while keeping the user', async () => {
    // A valid session with no org. `RequestContext` requires an org, so the identity names
    // the sentinel from `src/context/` — which is the state that motivated moving it out of
    // `src/transport/`.
    const issued = await registerUser();
    await db.app.deleteFrom('org_members').execute();

    const identity = await resolveSessionIdentity(cookieJar(issued.sessionToken));

    expect(identity?.orgId).toBe(UNAUTHENTICATED_ID);
    expect(identity?.roleId).toBe(UNAUTHENTICATED_ID);
    expect(identity?.userId).toBe(issued.identity.user.id);

    // Every tenant route refuses this scope, and it resolves to no permissions at all: the
    // sentinel is a well-formed UUID naming no row, so the check fails closed.
    const context = contextFor(identity!);
    expect(isAuthenticatedContext(context)).toBe(false);
    expect((await permissionsForContext(context)).size).toBe(0);
  });

  it('drops a membership whose role is invisible from its own org', async () => {
    // Fail closed. `resolveMembership` applies the `roles.org_id = ? OR IS NULL` predicate,
    // so a membership pointing at another org's custom role resolves to nothing — and "a
    // scope with no role" must not be the alternative.
    const issued = await registerUser();
    const foreign = await db.factories.org({ name: 'Foreign Books', slug: `foreign-${newUuid()}` });
    const roleId = uuidToBuffer(newUuid());
    await db.app
      .insertInto('roles')
      .values({
        id: roleId,
        org_id: foreign.id,
        code: 'foreign_custom',
        name: 'Foreign Custom',
        description: 'Test-only custom role belonging to another org.',
        is_system: 0,
      })
      .execute();
    await db.app
      .updateTable('org_members')
      .set({ role_id: roleId })
      .where('user_id', '=', uuidToBuffer(issued.identity.user.id))
      .execute();

    const identity = await resolveSessionIdentity(cookieJar(issued.sessionToken));

    expect(identity?.orgId).toBe(UNAUTHENTICATED_ID);
    expect(identity?.userId).toBe(issued.identity.user.id);
  });
});

describe('a role changed between requests takes effect on the next one', () => {
  it('re-resolves org_members rather than caching the role', async () => {
    // The `sessions` commentary in `0001_tenancy.ts`: "a role changed mid-session would
    // otherwise keep its old permissions until the cookie expired… authorization
    // re-resolves `org_members` on every request already, and has to."
    const issued = await registerUser();
    const orgId = issued.identity.memberships[0]?.org.id ?? '';

    const asOwner = await resolveSessionIdentity(cookieJar(issued.sessionToken));
    expect(asOwner?.roleId).toBe(SYSTEM_ROLE_UUIDS.owner);
    expect((await resolveMembership(issued.identity.user.id, orgId)).isMember).toBe(true);

    await db.app
      .updateTable('org_members')
      .set({ role_id: systemRoleId('readOnly') })
      .where('user_id', '=', uuidToBuffer(issued.identity.user.id))
      .execute();

    // Same cookie, same session row, next request.
    const asReadOnly = await resolveSessionIdentity(cookieJar(issued.sessionToken));

    expect(asReadOnly?.orgId).toBe(orgId);
    expect(asReadOnly?.roleId).toBe(SYSTEM_ROLE_UUIDS.readOnly);

    const membership = await resolveMembership(issued.identity.user.id, orgId);
    expect(membership.isMember && membership.roleCode).toBe('read_only');
    expect(membership.isMember && membership.permissions.has('journals.post')).toBe(false);
  });
});
