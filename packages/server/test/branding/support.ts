import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll } from 'vitest';

import { createRequestContext, type RequestContext } from '../../src/context';
import { destroyDatabase, initializeDatabase, isDatabaseInitialized } from '../../src/db';
import { setStorageProvider } from '../../src/providers';
import { createLocalStorageProvider } from '../../src/providers/storage/local';
import type { SystemRoleName, TestDatabase } from '../db';
import { SYSTEM_ROLE_UUIDS, systemRoleId, useTestDatabase } from '../db';

/**
 * Support for the OB-124 suite.
 *
 * `useServiceDatabase`, `contextFor` and `actorIn` are the same three helpers
 * `test/settings/support.ts` and `test/members/support.ts` each carry their own
 * copy of, for the reason those files give: they are other tickets' fixtures, and
 * this suite should not break when one of theirs changes.
 *
 * `useLocalStorage` is the part that is new here — the `local` `StorageProvider`
 * pointed at a real temporary directory, installed as the process-wide provider
 * (`setStorageProvider`, `providers/index.ts`) for the duration of the file. Not a
 * mock (spec §11): `uploadLogo` writes through the real adapter, and a test proves
 * the bytes landed by reading them back through the same adapter's `get`.
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

/** Installs a `local` storage provider over a fresh temp directory for one file. */
export function useLocalStorage(): void {
  let basePath: string | undefined;

  beforeAll(async () => {
    basePath = await mkdtemp(join(tmpdir(), 'openbooks-branding-'));
    setStorageProvider(createLocalStorageProvider({ provider: 'local', basePath }));
  });

  afterAll(async () => {
    setStorageProvider(undefined);
    if (basePath !== undefined) await rm(basePath, { recursive: true, force: true });
  });
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
  readonly orgName: string;
  readonly userUuid: string;
  readonly userId: Buffer;
  readonly ctx: RequestContext;
}

/** An org, a member holding one of the six seeded roles, and a context for the pair. */
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
    orgName: org.name,
    userUuid: user.uuid,
    userId: user.id,
    ctx: contextFor(org.uuid, SYSTEM_ROLE_UUIDS[role], user.uuid),
  };
}
