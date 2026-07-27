import { afterAll, beforeAll } from 'vitest';

import { createRequestContext, runInContext, type RequestContext } from '../../src/context';
import { destroyDatabase, initializeDatabase, isDatabaseInitialized } from '../../src/db';
import type { SystemRoleName, TestDatabase } from '../db';
import { SYSTEM_ROLE_UUIDS, systemRoleId, useTestDatabase } from '../db';

/**
 * Support for the OB-037 suites.
 *
 * These drive the real service, so the *process* database handle has to be
 * initialized as well as the harness's own pools: the dimensions repository
 * reaches data through `tenantDb()`, which reads the module-private client in
 * `src/db/client.ts`. Pointing that client at the harness container is what makes
 * these tests statements about the production path rather than about a second
 * query written for the test.
 *
 * The app user, not the migrator — the identity the application runs as (spec
 * §12). The tagging path is where that matters most: `journal_line_dimensions` is
 * in `0004_app_grants`'s mutable list and `journal_lines` is not, so a retag that
 * needed a privilege the app user lacks would fail here rather than in production.
 *
 * `useServiceDatabase`, `contextFor`, and `actorIn` duplicate
 * `test/accounts/support.ts`, and `delay` / `parkedInsert` duplicate the shape of
 * `test/enforcement/support.ts`. Copied rather than imported, following the
 * convention those files state: they are other tickets' fixtures, and neither
 * suite should break when the other's helper changes.
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
 * A request context for an `(org, role, user)` triple.
 *
 * Through `createRequestContext` rather than an object literal, because the
 * permission memo is keyed on that frozen object's identity.
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

/**
 * Runs `body` inside the context scope.
 *
 * Needed for the ledger fixtures the tagging suite posts: `postJournal` reaches
 * the period lock through `assertPostable`, which reads the context ambiently
 * (spec §4 forbids threading `orgId` as a parameter). The dimensions service
 * itself takes its context as an argument and needs no scope.
 */
export function withContext<T>(ctx: RequestContext, body: () => Promise<T>): Promise<T> {
  return runInContext(ctx, body);
}

export interface ActorFixture {
  readonly orgUuid: string;
  readonly orgId: Buffer;
  readonly userUuid: string;
  readonly ctx: RequestContext;
}

/**
 * An org, a member holding one of the six seeded system roles, and a context.
 *
 * Real seeded roles rather than a custom bundle, because the point of the
 * enforcement assertions is what a *shipped* role can do: `read_only` holds
 * `dimensions.read` and not `dimensions.write` (migration `0001_tenancy`), which
 * is exactly the pair those tests need.
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

/**
 * How long a blocked statement is given to prove it is blocked.
 *
 * One-directional, as `test/enforcement/support.ts` argues: every assertion taken
 * after this wait is about a state that must *hold*, so a too-short wait can only
 * fail to catch a mutation — it can never turn a failing implementation into a
 * passing test.
 */
export const CONTENTION_WAIT_MS = 750;

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A call in flight, with settlement observable without consuming the promise. */
export interface Attempt<T> {
  readonly promise: Promise<T>;
  hasSettled(): boolean;
}

export function watch<T>(promise: Promise<T>): Attempt<T> {
  let settled = false;
  const mark = (): void => {
    settled = true;
  };
  // Attached without consuming the promise, so the caller can still await it, and
  // the rejection handler keeps an expected failure from becoming an unhandled
  // rejection before the test asserts on it.
  void promise.then(mark, mark);
  return { promise, hasSettled: () => settled };
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}
