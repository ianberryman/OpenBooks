import { afterAll, beforeAll } from 'vitest';

import { createRequestContext, type RequestContext } from '../../src/context';
import {
  destroyDatabase,
  initializeDatabase,
  isDatabaseInitialized,
  systemDb,
  uuidToBuffer,
} from '../../src/db';
import type { PermissionKey } from '../../src/modules/permissions';
import { newUuid, SYSTEM_ROLE_UUIDS, useTestDatabase, type TestDatabase } from '../db';

/**
 * Fixtures for the OB-019 suites.
 *
 * The tests drive the real service, so the *process* database handle has to point at
 * the harness container: `tenantDb()` and `systemDb()` read the module-private client
 * in `src/db/client.ts`, and without this they would connect to nothing. Same reason
 * and same shape as `test/permissions/support.ts` — duplicated rather than imported
 * so neither ticket's suite breaks when the other's helper changes.
 *
 * The app user, not the migrator. If any period operation needed a privilege the
 * application does not hold, that is a finding and it should surface here.
 */
export function usePeriodsDatabase(): TestDatabase {
  const db = useTestDatabase();

  beforeAll(() => {
    if (!isDatabaseInitialized()) initializeDatabase(db.appConnectionConfig);
  });

  afterAll(async () => {
    await destroyDatabase();
  });

  return db;
}

/**
 * A request context for an `(org, role, user)` triple.
 *
 * Through `createRequestContext`, not an object literal: the permission memo in
 * `permissions.service.ts` is a `WeakMap` keyed on the frozen context object, so a
 * literal would be a different kind of key from the one the request path produces.
 */
export function contextFor(orgUuid: string, roleUuid: string, userUuid: string): RequestContext {
  return createRequestContext({
    orgId: orgUuid,
    roleId: roleUuid,
    userId: userUuid,
    actorType: 'user',
    actorId: userUuid,
  });
}

export const OWNER_ROLE_UUID = SYSTEM_ROLE_UUIDS.owner;

/**
 * A custom role holding exactly `permissions`, for one org.
 *
 * Needed because the six seeded roles cannot separate `periods.close` from
 * `periods.reopen` — Owner and Bookkeeper hold both, everyone else holds neither
 * (`0001_tenancy`) — so the distinction the two codes exist to express is not
 * expressible with a system role. Spec §5 reserves a non-null `roles.org_id` for
 * exactly this, and `permissions.repository.ts` resolves such a role under its own
 * org's context via `org_id = ? OR org_id IS NULL`.
 *
 * Written through `systemDb()`, not `db.app`, because `roles` is deliberately outside
 * `TenantTableName` (its `org_id` is nullable) and because these rows must be visible
 * to the service's own connection. The harness reset removes custom roles between
 * tests, so nothing accumulates.
 */
export async function customRole(
  orgUuid: string,
  permissions: readonly PermissionKey[],
): Promise<string> {
  const roleUuid = newUuid();
  const roleId = uuidToBuffer(roleUuid);

  await systemDb()
    .insertInto('roles')
    .values({
      id: roleId,
      org_id: uuidToBuffer(orgUuid),
      code: `test-role-${roleUuid.slice(0, 8)}`,
      name: 'Test role',
      description: 'Created by the OB-019 suite.',
      is_system: 0,
    })
    .execute();

  if (permissions.length > 0) {
    await systemDb()
      .insertInto('role_permissions')
      .values(permissions.map((code) => ({ role_id: roleId, permission_code: code })))
      .execute();
  }

  return roleUuid;
}
