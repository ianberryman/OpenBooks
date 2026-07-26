import { afterAll, beforeAll } from 'vitest';

import { createRequestContext, type RequestContext } from '../../src/context';
import { destroyDatabase, initializeDatabase, isDatabaseInitialized } from '../../src/db';
import { useTestDatabase, type TestDatabase } from '../db';

/**
 * The OB-016 suites exercise the real service, so they need the *process* database
 * handle initialized as well as the harness's own pools: `requirePermission` reaches
 * data through `systemDb()`, which reads the module-private client
 * (`src/db/client.ts`). Pointing that client at the harness container is what makes
 * these tests statements about the production path rather than about a second query
 * written for the test.
 *
 * The app user, not the migrator — the identity the application runs as (spec §12).
 * If the permission reads ever needed a privilege the app user lacks, that is a
 * finding, and it should surface here.
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
 * tests use the same frozen object the request path produces — the memoization is
 * keyed on that object's identity, and a literal would silently be a different kind
 * of key.
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
