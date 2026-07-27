import { describe, expect, it, vi } from 'vitest';

import { runInContext } from '../../src/context';
import { currentPermissions, permissionsForContext } from '../../src/modules/permissions';
import { uuidToBuffer } from '../../src/db';
import { register, resolveSessionIdentity } from '../../src/modules/auth';
import { SYSTEM_ROLE_UUIDS } from '../db';
import {
  cookieJar,
  contextFor,
  runUnauthenticated,
  useServiceDatabase,
  VALID_PASSWORD,
} from './support';

// Type-only, so the `vi.mock` factory below has the real module's shape.
import type * as PermissionsRepository from '../../src/modules/permissions/permissions.repository';

/**
 * The permission set `GET /v1/auth/me` reports (OB-030; ROADMAP D-25; M2 criterion
 * B10).
 *
 * ## What is being asserted, and what deliberately is not
 *
 * That the list is *accurate* and that it is *the same resolution the gate uses*. What
 * is not asserted anywhere — because it must never become true — is that this list
 * decides anything. Enforcement is `requirePermission` in the service layer, and
 * OB-054's matrix asserts every operation against every seeded role there, where
 * hiding a button proves nothing. If a future change makes a service consult this
 * function, the test that catches it is the enforcement matrix, not this file.
 *
 * The spy wraps the real repository function, so every assertion below is still made
 * against real rows from the migrated container; only the call count is observed.
 */
vi.mock('../../src/modules/permissions/permissions.repository', async (importOriginal) => {
  const actual = await importOriginal<typeof PermissionsRepository>();

  return { ...actual, selectRolePermissionKeys: vi.fn(actual.selectRolePermissionKeys) };
});

import * as repository from '../../src/modules/permissions/permissions.repository';

const selectRolePermissionKeys = vi.mocked(repository.selectRolePermissionKeys);

const db = useServiceDatabase();

let sequence = 0;

async function registerUser() {
  sequence += 1;
  const issued = await runUnauthenticated(() =>
    register({
      email: `perms-${sequence}@openbooks.test`,
      password: VALID_PASSWORD,
      displayName: `Permitted ${sequence}`,
      org: { name: `Permitted Books ${sequence}` },
    }),
  );
  const identity = await resolveSessionIdentity(cookieJar(issued.sessionToken));
  expect(identity).not.toBeNull();
  return { issued, identity: identity! };
}

describe('the caller’s permission set', () => {
  it('is what the role actually carries, for the active org', async () => {
    const { identity } = await registerUser();
    const ctx = contextFor(identity);

    const permissions = await runInContext(ctx, () => currentPermissions());

    expect(identity.roleId).toBe(SYSTEM_ROLE_UUIDS.owner);
    // The Owner bundle, spot-checked rather than restated: the catalog's own drift
    // test in `test/permissions/` is the authority on what the 48 codes are, and a
    // second copy of the list here would be a second thing to update.
    expect(permissions).toContain('accounts.write');
    expect(permissions).toContain('journals.post');
    expect(permissions).toContain('periods.close');
    expect(permissions.length).toBeGreaterThan(0);
  });

  it('is sorted, so the wire body is stable across calls', async () => {
    const { identity } = await registerUser();
    const ctx = contextFor(identity);

    const permissions = await runInContext(ctx, () => currentPermissions());

    expect([...permissions].sort()).toEqual([...permissions]);
  });

  it('is the same set the gate resolves, from the same query', async () => {
    // The reuse requirement, stated as the thing that would break without it: two
    // resolution paths eventually disagree, and the one nobody is watching is the
    // advisory one that then hides an action the caller is entitled to.
    const { identity } = await registerUser();
    const ctx = contextFor(identity);
    selectRolePermissionKeys.mockClear();

    const [advisory, enforced] = await runInContext(ctx, async () => [
      await currentPermissions(),
      await permissionsForContext(ctx),
    ]);

    expect(new Set(advisory)).toEqual(new Set(enforced));
    // One query for both, because the memo is the context's and not a second cache.
    expect(selectRolePermissionKeys).toHaveBeenCalledTimes(1);
  });

  it('reflects a lesser role rather than the caller’s other memberships', async () => {
    // The accountant case (spec §5): Owner of their own books, read-only on a
    // client's. A screen rendered from this list must follow the org the session is
    // scoped to, not the union of everything the login can reach.
    const { issued, identity } = await registerUser();
    const client = await db.factories.org({ name: 'Client Books' });
    await db.factories.orgMember({
      orgId: client.id,
      userId: uuidToBuffer(issued.identity.user.id),
      role: 'readOnly',
    });

    const owner = await runInContext(contextFor(identity), () => currentPermissions());
    const readOnly = await runInContext(
      contextFor({ ...identity, orgId: client.uuid, roleId: SYSTEM_ROLE_UUIDS.readOnly }),
      () => currentPermissions(),
    );

    expect(readOnly).not.toContain('journals.post');
    expect(owner).toContain('journals.post');
    expect(readOnly.length).toBeLessThan(owner.length);
  });

  it('is empty for a caller with no active org, rather than an error', async () => {
    // A real state — a user removed from their last org — and the one `me()` exists
    // to answer for. "You may do nothing" is the honest response; a throw would send
    // a client to a login form that will succeed and change nothing.
    const permissions = await runUnauthenticated(() => currentPermissions());

    expect(permissions).toEqual([]);
  });
});
