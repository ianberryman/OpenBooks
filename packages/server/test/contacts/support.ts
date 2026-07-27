import { afterAll, beforeAll } from 'vitest';

import { createRequestContext, type RequestContext } from '../../src/context';
import { destroyDatabase, initializeDatabase, isDatabaseInitialized } from '../../src/db';
import type { SystemRoleName, TestDatabase } from '../db';
import { SYSTEM_ROLE_UUIDS, systemRoleId, useTestDatabase } from '../db';

/**
 * Support for the OB-036 suites.
 *
 * These exercise the real service, so the *process* database handle has to be
 * initialized as well as the harness's own pools: the contacts repository reaches
 * data through `tenantDb()`, which reads the module-private client in
 * `src/db/client.ts`. Pointing that client at the harness container is what makes
 * these tests statements about the production path rather than about a second
 * query written for the test.
 *
 * The app user, not the migrator — the identity the application runs as (spec
 * §12). If any contact operation needed a privilege the app user lacks, that is a
 * finding and it surfaces here. `contacts` joined `0999_app_grants`'s
 * `MUTABLE_TABLES` with OB-032, which is what lets the delete and deactivate paths
 * run as the application at all; `test/contacts/schema.test.ts` predates that and
 * says so.
 *
 * `useServiceDatabase` and `contextFor` are the third copy of
 * `test/accounts/support.ts` — see the note there, and `src/modules/contacts/
 * input.ts` for the same trade made in `src`. A suite reaching sideways into
 * another suite's support file is worse than a visible duplicate.
 */
export function useServiceDatabase(): TestDatabase {
  const db = useTestDatabase();

  // Registered after the harness's own `beforeAll`, so `appConnectionConfig` is
  // live by the time this runs.
  beforeAll(() => {
    if (!isDatabaseInitialized()) initializeDatabase(db.appConnectionConfig);
  });

  afterAll(async () => {
    await destroyDatabase();
  });

  return db;
}

/**
 * A request context for a `(org, role, user)` triple.
 *
 * Built through `createRequestContext` rather than as an object literal so these
 * tests use the same frozen object the request path produces — the permission memo
 * is keyed on that object's identity, and a literal would silently be a different
 * kind of key.
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

export interface ActorFixture {
  readonly orgUuid: string;
  readonly orgId: Buffer;
  readonly userUuid: string;
  readonly userId: Buffer;
  readonly ctx: RequestContext;
}

/**
 * An org, a member holding one of the six seeded system roles, and a context for
 * the pair.
 *
 * Roles are real seeded roles rather than a custom bundle, because the point of
 * most of these assertions is what a *shipped* role can do: `read_only` holds
 * `contacts.read` and not `contacts.write` (migration `0001_tenancy`), which is
 * exactly the pair the enforcement assertions need.
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
