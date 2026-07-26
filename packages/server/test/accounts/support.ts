import { afterAll, beforeAll } from 'vitest';

import { createRequestContext, type RequestContext } from '../../src/context';
import { destroyDatabase, initializeDatabase, isDatabaseInitialized } from '../../src/db';
import type { SystemRoleName, TestDatabase } from '../db';
import { SYSTEM_ROLE_UUIDS, systemRoleId, useTestDatabase } from '../db';

/**
 * Support for the OB-018 suites.
 *
 * These exercise the real service, so the *process* database handle has to be
 * initialized as well as the harness's own pools: the accounts repository reaches
 * data through `tenantDb()`, which reads the module-private client in
 * `src/db/client.ts`. Pointing that client at the harness container is what makes
 * these tests statements about the production path rather than about a second query
 * written for the test.
 *
 * The app user, not the migrator — the identity the application runs as (spec §12).
 * If any account operation needed a privilege the app user lacks, that is a finding
 * and it surfaces here rather than in production.
 *
 * `useServiceDatabase` and `contextFor` duplicate `test/permissions/support.ts`
 * almost exactly. They want to be one `test/support/service.ts` that every service
 * suite imports; this ticket does not own `test/permissions/`, and reaching sideways
 * into another suite's support file would be worse than one noted duplicate. See the
 * OB-018 report.
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
  readonly ctx: RequestContext;
}

/**
 * An org, a member holding one of the six seeded system roles, and a context for
 * the pair.
 *
 * Roles are real seeded roles rather than a custom bundle, because the point of most
 * of these assertions is what a *shipped* role can do: `read_only` holds
 * `accounts.read` and not `accounts.write` (migration `0001_tenancy`), which is
 * exactly the pair the enforcement test needs.
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
    ctx: contextFor(org.uuid, SYSTEM_ROLE_UUIDS[role], user.uuid),
  };
}
