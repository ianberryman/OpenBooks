import { afterAll, beforeAll } from 'vitest';

import { createRequestContext, type RequestContext } from '../../src/context';
import { destroyDatabase, initializeDatabase, isDatabaseInitialized } from '../../src/db';
import { runInContext } from '../../src/context';
import { newUuidBuffer, useTestDatabase, type TestDatabase } from '../db';

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

/**
 * A contact, and an axis with values, for the lines OB-059 lets a posting carry.
 *
 * Deliberate duplicates of `test/drafts/support.ts`, following the convention that
 * file states: contacts and dimensions belong to OB-036 and OB-037, and reaching
 * sideways into another suite's fixtures means this suite breaks when that one is
 * edited. They insert as the **app** user, which is the stronger position — a
 * missing grant surfaces here rather than in production.
 */
export async function contactIn(
  db: TestDatabase,
  orgId: Buffer,
  name = 'Acme Ltd',
): Promise<Buffer> {
  const id = newUuidBuffer();
  await db.app
    .insertInto('contacts')
    .values({ id, org_id: orgId, display_name: name, is_customer: 1 })
    .execute();
  return id;
}

export interface DimensionFixture {
  readonly dimensionId: Buffer;
  readonly valueIds: readonly Buffer[];
}

export async function dimensionIn(
  db: TestDatabase,
  orgId: Buffer,
  code: string,
  valueCodes: readonly string[],
): Promise<DimensionFixture> {
  const dimensionId = newUuidBuffer();
  await db.app
    .insertInto('dimensions')
    .values({ id: dimensionId, org_id: orgId, code, name: code })
    .execute();

  const valueIds = valueCodes.map(() => newUuidBuffer());
  await db.app
    .insertInto('dimension_values')
    .values(
      valueCodes.map((valueCode, index) => ({
        // Present by construction: the ids are generated from the same list.
        id: valueIds[index] ?? newUuidBuffer(),
        org_id: orgId,
        dimension_id: dimensionId,
        code: valueCode,
        name: valueCode,
      })),
    )
    .execute();

  return { dimensionId, valueIds };
}
