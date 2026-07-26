import { beforeEach, describe, expect, it, vi } from 'vitest';

import { deriveContext, runInContext } from '../../src/context';
import {
  hasPermission,
  permissionsForContext,
  requirePermission,
} from '../../src/modules/permissions';
import { bufferToUuid, newUuid, newUuidBuffer, SYSTEM_ROLE_UUIDS } from '../db';
import { contextFor, useServiceDatabase } from './support';

// Type-only, purely to give the `vi.mock` factory below the real module's shape
// without an inline `import()` type.
import type * as PermissionsRepository from '../../src/modules/permissions/permissions.repository';

/**
 * Per-request memoization of role → permissions (ROADMAP OB-016).
 *
 * The claim has two halves and they pull in opposite directions, which is why both
 * are tested here rather than only the cheap one:
 *
 *  1. Repeated checks inside one request issue **one** query.
 *  2. The memo does not outlive the request. A process-lifetime cache would serve a
 *     stale role after a re-role — the same failure the server-side session design in
 *     `0001_tenancy.ts` exists to prevent.
 *
 * "One query" is asserted by spying on the repository function that issues it. The
 * spy wraps the real implementation, so every assertion below is still made against
 * real rows from the migrated container; only the call count is observed.
 */
vi.mock('../../src/modules/permissions/permissions.repository', async (importOriginal) => {
  const actual = await importOriginal<typeof PermissionsRepository>();

  return { ...actual, selectRolePermissionKeys: vi.fn(actual.selectRolePermissionKeys) };
});

// Imported after the mock declaration for readability only — `vi.mock` is hoisted
// above every import in the file.
import * as repository from '../../src/modules/permissions/permissions.repository';

const resolveQuery = vi.mocked(repository.selectRolePermissionKeys);

describe('one query per request, however many checks', () => {
  const db = useServiceDatabase();

  beforeEach(() => {
    resolveQuery.mockClear();
  });

  it('resolves once for many sequential checks', async () => {
    const org = await db.factories.org();
    const ctx = contextFor(org.uuid, SYSTEM_ROLE_UUIDS.owner, newUuid());

    await requirePermission(ctx, 'journals.post');
    await requirePermission(ctx, 'accounts.read');
    await requirePermission(ctx, 'periods.close');
    expect(await hasPermission(ctx, 'reports.read')).toBe(true);
    await permissionsForContext(ctx);

    expect(resolveQuery).toHaveBeenCalledTimes(1);
  });

  it('resolves once for concurrent checks', async () => {
    // The reason the in-flight promise is cached rather than the resolved value:
    // two service calls under one `Promise.all` would otherwise both miss.
    const org = await db.factories.org();
    const ctx = contextFor(org.uuid, SYSTEM_ROLE_UUIDS.bookkeeper, newUuid());

    await Promise.all([
      requirePermission(ctx, 'journals.post'),
      requirePermission(ctx, 'accounts.write'),
      hasPermission(ctx, 'reports.read'),
      permissionsForContext(ctx),
    ]);

    expect(resolveQuery).toHaveBeenCalledTimes(1);
  });

  it('returns the identical promise to concurrent callers', async () => {
    const org = await db.factories.org();
    const ctx = contextFor(org.uuid, SYSTEM_ROLE_UUIDS.owner, newUuid());

    const first = permissionsForContext(ctx);
    const second = permissionsForContext(ctx);

    expect(second).toBe(first);
    await first;
    expect(resolveQuery).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed resolution for the rest of the request', async () => {
    // A transient database error must not turn into a request in which every
    // authorization check fails for a reason that no longer applies.
    const org = await db.factories.org();
    const ctx = contextFor(org.uuid, SYSTEM_ROLE_UUIDS.owner, newUuid());

    resolveQuery.mockRejectedValueOnce(new Error('connection reset'));

    await expect(permissionsForContext(ctx)).rejects.toThrow('connection reset');
    await expect(requirePermission(ctx, 'journals.post')).resolves.toBeUndefined();
    expect(resolveQuery).toHaveBeenCalledTimes(2);
  });
});

describe('the memo does not outlive the context that owns it', () => {
  const db = useServiceDatabase();

  beforeEach(() => {
    resolveQuery.mockClear();
  });

  it('re-resolves for a second context with identical fields', async () => {
    // The load-bearing assertion. A module-level `Map<roleId, permissions>` would
    // pass every test in the block above and fail this one, because these two
    // contexts differ only in identity — same org, same role, same user.
    const org = await db.factories.org();
    const user = await db.factories.user();
    const first = contextFor(org.uuid, SYSTEM_ROLE_UUIDS.owner, user.uuid);
    const second = contextFor(org.uuid, SYSTEM_ROLE_UUIDS.owner, user.uuid);

    await permissionsForContext(first);
    await permissionsForContext(second);

    expect(resolveQuery).toHaveBeenCalledTimes(2);
  });

  it('observes a role whose bundle changed between two requests', async () => {
    // The re-role case, stated as behaviour rather than as a cache property. A
    // process-lifetime cache keyed by role id would still be serving the old bundle
    // here, which is exactly what the sessions commentary in 0001_tenancy.ts
    // refuses: "authorization re-resolves org_members on every request already, and
    // has to".
    const org = await db.factories.org();
    const roleId = newUuidBuffer();
    await db.app
      .insertInto('roles')
      .values({
        id: roleId,
        org_id: org.id,
        code: 'widening',
        name: 'Widening',
        description: 'Test-only custom role that gains a permission mid-suite.',
        is_system: 0,
      })
      .execute();
    await db.app
      .insertInto('role_permissions')
      .values({ role_id: roleId, permission_code: 'bills.read' })
      .execute();

    const roleUuid = bufferToUuid(roleId);
    const firstRequest = contextFor(org.uuid, roleUuid, newUuid());
    await expect(requirePermission(firstRequest, 'bills.write')).rejects.toThrow();

    await db.app
      .insertInto('role_permissions')
      .values({ role_id: roleId, permission_code: 'bills.write' })
      .execute();

    // Same role, same org, new request.
    const secondRequest = contextFor(org.uuid, roleUuid, newUuid());
    await expect(requirePermission(secondRequest, 'bills.write')).resolves.toBeUndefined();
  });

  it('re-resolves in a derived scope rather than inheriting the parent bundle', async () => {
    // `deriveContext` keeps the parent's requestId on purpose (provenance), so a memo
    // keyed by requestId would hand an org switch the previous org's permissions.
    // Keyed by the frozen object, the derived scope is simply a different key.
    const [ownBooks, client] = await Promise.all([db.factories.org(), db.factories.org()]);
    const user = await db.factories.user();
    const parent = contextFor(ownBooks.uuid, SYSTEM_ROLE_UUIDS.owner, user.uuid);

    const derived = runInContext(parent, () =>
      deriveContext({ orgId: client.uuid, roleId: SYSTEM_ROLE_UUIDS.readOnly }),
    );

    expect(derived.requestId).toBe(parent.requestId);
    expect(await hasPermission(parent, 'journals.post')).toBe(true);
    expect(await hasPermission(derived, 'journals.post')).toBe(false);
    expect(resolveQuery).toHaveBeenCalledTimes(2);
  });
});
