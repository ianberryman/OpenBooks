import { describe, expect, it } from 'vitest';

import { newUuid, uuidToBuffer } from '../../src/db';
import { NotFoundError, toWireError, UnauthenticatedError } from '../../src/errors';
import type { IssuedSession } from '../../src/modules/auth';
import { logout, register, resolveSessionIdentity, switchActiveOrg } from '../../src/modules/auth';
import { SYSTEM_ROLE_UUIDS } from '../db';
import { cookieJar, runAsIdentity, useServiceDatabase, VALID_PASSWORD } from './support';

/**
 * The org switcher (spec §5, OB-015), and acceptance A7 applied to it.
 *
 * The switch is the operation A7 is most exposed by: it takes an org id straight from the
 * client, so "you are not a member of that org" and "there is no such org" have to be one
 * answer or the endpoint enumerates every tenant in the system.
 */
const db = useServiceDatabase();

let sequence = 0;

async function registerUser(): Promise<IssuedSession> {
  sequence += 1;
  return register({
    email: `switch-${sequence}@openbooks.test`,
    password: VALID_PASSWORD,
    displayName: `Switcher ${sequence}`,
    org: { name: `Switch Books ${sequence}` },
  });
}

/** The identity a request carrying `token` runs as. */
async function scopeFor(token: string) {
  const identity = await resolveSessionIdentity(cookieJar(token));
  expect(identity).not.toBeNull();
  return identity!;
}

describe('switching org re-derives the scope', () => {
  it('moves the session and returns the role held in the new org', async () => {
    // Owner of their own books, Read-only on a client's — the accountant case spec §5's
    // many-to-many exists for. A role carried across the switch would be the whole failure.
    const owned = await registerUser();
    const ownedOrgId = owned.identity.memberships[0]?.org.id ?? '';
    const client = await db.factories.org({ name: 'Client Books', slug: `client-${newUuid()}` });
    await db.factories.orgMember({
      orgId: client.id,
      userId: uuidToBuffer(owned.identity.user.id),
      role: 'readOnly',
    });

    const before = await scopeFor(owned.sessionToken);
    expect(before.orgId).toBe(ownedOrgId);
    expect(before.roleId).toBe(SYSTEM_ROLE_UUIDS.owner);

    const switched = await runAsIdentity(before, () =>
      switchActiveOrg(owned.sessionToken, client.uuid),
    );

    expect(switched.org.id).toBe(client.uuid);
    expect(switched.roleId).toBe(SYSTEM_ROLE_UUIDS.readOnly);
    expect(switched.roleCode).toBe('read_only');

    // Persisted as the hint for the next request, and the next request re-derives from it.
    const session = await db.app
      .selectFrom('sessions')
      .select('active_org_id')
      .executeTakeFirstOrThrow();
    expect(session.active_org_id).toEqual(client.id);

    const after = await scopeFor(owned.sessionToken);
    expect(after.orgId).toBe(client.uuid);
    expect(after.roleId).toBe(SYSTEM_ROLE_UUIDS.readOnly);
  });

  it('accepts a switch to the org that is already active', async () => {
    // MySQL's `affectedRows` counts rows whose values *changed*, so an UPDATE here touches
    // nothing. Treating that as "no live session" would reject the most ordinary request
    // there is — see `updateSessionActiveOrg`.
    const issued = await registerUser();
    const orgId = issued.identity.memberships[0]?.org.id ?? '';
    const scope = await scopeFor(issued.sessionToken);

    const result = await runAsIdentity(scope, () => switchActiveOrg(issued.sessionToken, orgId));

    expect(result.org.id).toBe(orgId);
    expect(result.roleCode).toBe('owner');
  });

  it('refuses a session that was revoked after the request was scoped', async () => {
    const issued = await registerUser();
    const scope = await scopeFor(issued.sessionToken);
    await logout(issued.sessionToken);

    await expect(
      runAsIdentity(scope, () => switchActiveOrg(issued.sessionToken, scope.orgId)),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('refuses to switch a session belonging to another user', async () => {
    // The token alone identifies the session, so guarding on the context's user is
    // redundant against a correct caller — and is what keeps an incorrect one from being
    // cross-account.
    const mine = await registerUser();
    const theirs = await registerUser();
    const myScope = await scopeFor(mine.sessionToken);

    await expect(
      runAsIdentity(myScope, () => switchActiveOrg(theirs.sessionToken, myScope.orgId)),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});

describe('A7: a non-member org is indistinguishable from a nonexistent one', () => {
  it('produces byte-identical responses for both', async () => {
    // The claim, stated exactly: a cross-org request must not leak existence. A 403 here
    // would satisfy "returns nothing" and still fail A7 outright, because it confirms the
    // id is real — which is all an attacker enumerating ids needs.
    const issued = await registerUser();
    const scope = await scopeFor(issued.sessionToken);

    // A real org, created by somebody else, that this user is not a member of.
    const someoneElses = await db.factories.org({
      name: 'Somebody Else Books',
      slug: `else-${newUuid()}`,
    });
    await db.factories.orgMember({ orgId: someoneElses.id, role: 'owner' });

    const nonMember = await capture(
      runAsIdentity(scope, () => switchActiveOrg(issued.sessionToken, someoneElses.uuid)),
    );
    const nonExistent = await capture(
      runAsIdentity(scope, () => switchActiveOrg(issued.sessionToken, newUuid())),
    );
    const malformed = await capture(
      runAsIdentity(scope, () => switchActiveOrg(issued.sessionToken, 'not-a-uuid')),
    );

    expect(nonMember).toBeInstanceOf(NotFoundError);
    expect(toWireError(nonMember).status).toBe(404);

    const serialized = JSON.stringify(toWireError(nonMember));
    expect(serialized).toBe(JSON.stringify(toWireError(nonExistent)));
    // A malformed id is the same answer again, not a 500. `tryUuidToBuffer` exists for this.
    expect(serialized).toBe(JSON.stringify(toWireError(malformed)));

    // And the payload carries no identifier at all — `NotFoundError` has no channel for one.
    expect(toWireError(nonMember).details).toEqual({ resource: 'org' });
    expect(serialized).not.toContain(someoneElses.uuid);
    expect(serialized).not.toContain(someoneElses.name);
    expect(serialized).not.toContain(someoneElses.slug);
  });

  it('answers an org the user was removed from the same way', async () => {
    // `sessions.active_org_id` may still name it. Re-validation is what turns that into a
    // 404 rather than a scope.
    const issued = await registerUser();
    const scope = await scopeFor(issued.sessionToken);
    const orgId = scope.orgId;

    const stillHere = await db.factories.org({ name: 'Retained', slug: `retained-${newUuid()}` });
    await db.factories.orgMember({
      orgId: stillHere.id,
      userId: uuidToBuffer(issued.identity.user.id),
      role: 'owner',
    });
    await db.app.deleteFrom('org_members').where('org_id', '=', uuidToBuffer(orgId)).execute();

    const removed = await capture(
      runAsIdentity(scope, () => switchActiveOrg(issued.sessionToken, orgId)),
    );
    const nonExistent = await capture(
      runAsIdentity(scope, () => switchActiveOrg(issued.sessionToken, newUuid())),
    );

    expect(JSON.stringify(toWireError(removed))).toBe(JSON.stringify(toWireError(nonExistent)));
  });

  it('leaves the session pointing where it was when the switch is refused', async () => {
    const issued = await registerUser();
    const scope = await scopeFor(issued.sessionToken);
    const someoneElses = await db.factories.org({
      name: 'Untouched',
      slug: `untouched-${newUuid()}`,
    });

    await expect(
      runAsIdentity(scope, () => switchActiveOrg(issued.sessionToken, someoneElses.uuid)),
    ).rejects.toBeInstanceOf(NotFoundError);

    const session = await db.app
      .selectFrom('sessions')
      .select('active_org_id')
      .executeTakeFirstOrThrow();
    expect(session.active_org_id).toEqual(uuidToBuffer(scope.orgId));
  });
});

async function capture(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}
