import { afterAll, beforeAll } from 'vitest';

import { createRequestContext, type RequestContext } from '../../src/context';
import { destroyDatabase, initializeDatabase, isDatabaseInitialized } from '../../src/db';
import { runInContext } from '../../src/context';
import { useTestDatabase, type TestDatabase } from '../db';

/**
 * The ledger suites drive the real posting service, so the process database handle
 * must point at the harness container — `tenantDb()` reads the module-private client,
 * and pointing it here is what makes these tests statements about the production
 * write path rather than about a second query written for the test.
 *
 * The app user, not the migrator. If posting ever needed a privilege the app user
 * lacks, that is a finding and it should surface as a failure here — which is exactly
 * how the `FOR UPDATE`-on-journals limitation was found.
 */
export function useLedgerDatabase(): TestDatabase {
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

/**
 * Runs `body` inside the context scope.
 *
 * The services read the context ambiently (spec §4 forbids threading `orgId` as a
 * parameter), so a test that passed a context object without entering its scope would
 * exercise a path production never takes.
 */
export function withContext<T>(ctx: RequestContext, body: () => Promise<T>): Promise<T> {
  return runInContext(ctx, body);
}
