import { afterAll, beforeAll } from 'vitest';

import { createRequestContext, type RequestContext } from '../../src/context';
import { destroyDatabase, initializeDatabase, isDatabaseInitialized } from '../../src/db';
import type { SystemRoleName, TestDatabase } from '../db';
import { SYSTEM_ROLE_UUIDS, systemRoleId, useTestDatabase } from '../db';

/**
 * Support for the OB-066a suite.
 *
 * The fifth copy of `test/accounts/support.ts`'s three helpers, copied rather than
 * imported for the reason those files state: they are other tickets' fixtures, and
 * neither suite should break when the other's helper changes.
 *
 * The process pool is initialized because these tests drive the real service, which
 * reaches data through `tenantDb()` — the module-private client in
 * `src/db/client.ts`. As the **app** user, which is what makes the writes here a
 * statement about the grant `org_accounting_settings` was given in
 * `0999_app_grants` rather than about the migrator's privileges.
 */
export function useServiceDatabase(): TestDatabase {
  const db = useTestDatabase();

  beforeAll(() => {
    if (!isDatabaseInitialized()) initializeDatabase(db.appConnectionConfig);
  });

  afterAll(async () => {
    await destroyDatabase();
  });

  return db;
}

export function contextFor(orgUuid: string, roleUuid: string, userUuid: string): RequestContext {
  return createRequestContext({
    orgId: orgUuid,
    roleId: roleUuid,
    userId: userUuid,
    actorType: 'user',
    actorId: userUuid,
  });
}

export interface ActorFixture {
  readonly orgUuid: string;
  readonly orgId: Buffer;
  readonly userUuid: string;
  readonly userId: Buffer;
  readonly ctx: RequestContext;
}

/**
 * An org, a member holding one of the six seeded roles, and a context.
 *
 * Real seeded roles rather than a custom bundle, because what the permission
 * assertions are about is what a *shipped* role can do. `bookkeeper` is the one
 * that matters here: it holds `accounts.write` and not `orgs.write`
 * (`0001_tenancy`), which is exactly the boundary this setting was put behind.
 */
export async function actorIn(
  db: TestDatabase,
  role: SystemRoleName = 'owner',
): Promise<ActorFixture> {
  const org = await db.factories.org();
  const user = await db.factories.user();
  await db.factories.orgMember({ orgId: org.id, userId: user.id, roleId: systemRoleId(role) });

  return {
    orgUuid: org.uuid,
    orgId: org.id,
    userUuid: user.uuid,
    userId: user.id,
    ctx: contextFor(org.uuid, SYSTEM_ROLE_UUIDS[role], user.uuid),
  };
}
