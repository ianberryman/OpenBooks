import { sql, type Kysely } from 'kysely';

import { createRequestContext, runInContext, type RequestContext } from '../../src/context';
import type { DB } from '../../src/db/generated';
import { runInTransactionScope } from '../../src/db/transaction-scope';
import { OWNER_ROLE_ID } from '../../src/modules/orgs';
import type { AppConnection } from '../db';
import { uuidToBuffer } from '../db';

/**
 * Scaffolding for `last-owner-race.test.ts`.
 *
 * A copy of `test/enforcement/support.ts`, minus the ledger-shaped helpers and
 * plus `countOwners`. Copied rather than imported, following the convention that
 * file states for its own duplication of `test/idempotency/support.ts`: these are
 * two tickets' fixtures, and neither suite should break when the other's helper
 * changes.
 *
 * The mechanism is the whole point, so it is worth restating why it is shaped this
 * way. `changeMemberRole` and `removeMember` take no database handle — they reach
 * data through `tenantDb()`, which consults `ambientTransaction()` before falling
 * back to the process pool. Opening a transaction on a *chosen* connection and
 * entering its scope is therefore how a service call is pinned to that connection,
 * and parking before the outer commit parks it holding every lock it took. That is
 * not a test-only contrivance: it is the shape `withIdempotency(spec, () => …)`
 * has in production.
 */

/**
 * How long a blocked statement is given to prove it is blocked.
 *
 * One-directional: every assertion taken after it is about a state that must
 * *hold*, and "has not settled yet" is what a broken implementation fails
 * immediately. A too-short wait cannot turn a failing test into a passing one — it
 * can only fail to catch a mutation, and 750 ms is far longer than a lock
 * acquisition on a local container.
 */
export const CONTENTION_WAIT_MS = 750;

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/**
 * A request context for an `(org, role, user)` triple, through
 * `createRequestContext` rather than an object literal: the permission memo is a
 * `WeakMap` keyed on the frozen context object, so a literal would be a different
 * kind of key from the one the request path produces.
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

export async function connectionId(db: Kysely<DB>): Promise<string> {
  const { rows } = await sql<{ id: bigint }>`SELECT CONNECTION_ID() AS id`.execute(db);
  return String(rows[0]?.id);
}

/**
 * How many Owners the org has, read on a handle of the caller's choosing.
 *
 * Pointed at a *third* connection by the tests, so an uncommitted demotion is not
 * visible: counted from one of the racing connections, the parked transaction's
 * own write would show and the count would be a statement about read timing rather
 * than about what the org actually holds.
 */
export async function countOwners(db: Kysely<DB>, orgId: Buffer): Promise<number> {
  const row = await db
    .selectFrom('org_members')
    .select(({ fn }) => fn.countAll<string>().as('count'))
    .where('org_id', '=', orgId)
    .where('role_id', '=', uuidToBuffer(OWNER_ROLE_ID))
    .executeTakeFirstOrThrow();

  return Number(row.count);
}

/** A call in flight, with settlement observable without consuming the promise. */
export interface Attempt<T> {
  readonly promise: Promise<T>;
  /**
   * Whether `promise` has settled either way. The contention probe: a statement
   * waiting on another transaction's row lock cannot have settled.
   */
  hasSettled(): boolean;
}

/** An attempt held open after its body finished, still holding every lock it took. */
export interface ParkedAttempt<T> extends Attempt<T> {
  /**
   * Resolves once `body` has returned and the transaction is parked. Rejects if
   * `body` itself failed, so a test awaiting the park reports the real error
   * instead of timing out.
   */
  readonly parked: Promise<T>;
  commit(): void;
  rollback(reason: Error): void;
}

/**
 * Runs `body` in its own transaction on `connection`, inside `ctx`'s scope. The
 * racing side: started and then observed, and the only thing that can keep it from
 * finishing promptly is another transaction's lock.
 */
export function transactionOn<T>(
  connection: AppConnection,
  ctx: RequestContext,
  body: () => Promise<T>,
): Attempt<T> {
  return watch(runScoped(connection, ctx, body));
}

/** As `transactionOn`, but holds the transaction open until `commit()`/`rollback()`. */
export function parkedTransactionOn<T>(
  connection: AppConnection,
  ctx: RequestContext,
  body: () => Promise<T>,
): ParkedAttempt<T> {
  const parked = deferred<T>();
  const release = deferred<void>();

  const promise = runScoped(connection, ctx, async () => {
    const value = await body();
    parked.resolve(value);
    // Rejecting `release` throws from here, which is what rolls the transaction back.
    await release.promise;
    return value;
  });

  // A body that threw never parks. Forwarding the failure turns a hang into the
  // actual error, which is the difference between a diagnosable test and a timeout.
  promise.catch((error: unknown) => {
    parked.reject(error);
  });

  return {
    ...watch(promise),
    parked: parked.promise,
    commit: () => {
      release.resolve();
    },
    rollback: (reason: Error) => {
      release.reject(reason);
    },
  };
}

function runScoped<T>(
  connection: AppConnection,
  ctx: RequestContext,
  body: () => Promise<T>,
): Promise<T> {
  return connection.db
    .transaction()
    .execute((trx) => runInTransactionScope(trx, () => runInContext(ctx, body)));
}

function watch<T>(promise: Promise<T>): Attempt<T> {
  let settled = false;
  const mark = (): void => {
    settled = true;
  };
  // Attached without consuming the promise, so the caller can still await it. The
  // rejection handler keeps an expected failure from becoming an unhandled
  // rejection before the test gets to assert on it.
  void promise.then(mark, mark);
  return { promise, hasSettled: () => settled };
}
