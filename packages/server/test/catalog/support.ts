import { afterAll, beforeAll } from 'vitest';

import { createRequestContext, type RequestContext } from '../../src/context';
import {
  destroyDatabase,
  initializeDatabase,
  isDatabaseInitialized,
  newUuidBuffer,
} from '../../src/db';
import type { SystemRoleName, TestDatabase } from '../db';
import { SYSTEM_ROLE_UUIDS, systemRoleId, useTestDatabase } from '../db';

/**
 * Support for the CAT suites (the item catalog).
 *
 * A deliberate duplicate of `test/contacts/support.ts`, following the convention
 * that file states: reaching sideways into another suite's fixtures means this suite
 * breaks when that one is edited. `useServiceDatabase` initializes the *process*
 * pool, because the repository reaches data through `tenantDb()` and that reads the
 * module-private client — pointing it at the harness container is what makes these
 * statements about the production path.
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

/**
 * A request context for an `(org, role, user)` triple, through
 * `createRequestContext` so the permission memo's `WeakMap` key is the frozen object
 * the request path produces rather than a literal.
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

/**
 * A contact, inserted as the **app** user (the stronger position: a missing grant
 * surfaces here rather than in production). Written here rather than via the contacts
 * service so these tests do not depend on that module's permission surface.
 */
export async function contactIn(
  db: TestDatabase,
  orgId: Buffer,
  name = 'Acme Ltd',
): Promise<Buffer> {
  const id = newUuidBuffer();
  await db.app
    .insertInto('contacts')
    .values({ id, org_id: orgId, display_name: name, is_customer: 1, is_vendor: 1 })
    .execute();
  return id;
}
