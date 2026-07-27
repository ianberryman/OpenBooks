import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll } from 'vitest';

import { createRequestContext, runInContext, type RequestContext } from '../../src/context';
import { destroyDatabase, initializeDatabase, isDatabaseInitialized } from '../../src/db';
import type { DB } from '../../src/db/generated';
import { runInTransactionScope } from '../../src/db/transaction-scope';
import type { AppConnection, SystemRoleName, TestDatabase } from '../db';
import { newUuidBuffer, SYSTEM_ROLE_UUIDS, systemRoleId, useTestDatabase } from '../db';

/**
 * Support for the OB-038 suites.
 *
 * The helpers here are deliberate duplicates of `test/accounts/support.ts` (the
 * service harness and `contextFor`) and of `test/enforcement/support.ts` (the
 * two-connection race scaffolding), following the convention those files state:
 * these are other tickets' fixtures, and reaching sideways into another suite's
 * support file means this suite breaks when that one is edited.
 *
 * Two harnesses, and choosing the wrong one makes a test prove nothing:
 *
 *  - `useServiceDatabase` initializes the *process* pool, because the drafts
 *    repository reaches data through `tenantDb()` and that reads the
 *    module-private client. Ordinary service tests use it.
 *  - `useTestDatabase` alone, which the concurrency suite uses, deliberately does
 *    **not**. With no process pool, a query that escaped the ambient transaction
 *    throws "Database not initialized" rather than quietly running on a third
 *    connection — where it would see neither side's uncommitted state and the
 *    race would appear to pass having proved nothing.
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
 * How long a blocked statement is given to prove it is blocked.
 *
 * One-directional, as in `test/enforcement/support.ts`: every assertion taken
 * after this wait is about a state that must *hold*, and "has not settled yet" is
 * what a broken implementation fails immediately. A too-short wait cannot turn a
 * failing test into a passing one — it can only fail to catch a mutation.
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
 * A request context for an `(org, role, user)` triple.
 *
 * Through `createRequestContext` rather than an object literal: the permission
 * memo is a `WeakMap` keyed on the frozen context object, so a literal would be a
 * different kind of key from the one the request path produces.
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
 * Not optional for anything that posts, and the reason is worth knowing: the
 * services accept a context *parameter*, but `assertPostable` — reached through
 * `postJournal` — takes none and reads the ambient one, because spec §4 forbids
 * threading `orgId` through signatures. A test that passed a context object
 * without entering its scope would exercise a path production never takes, and
 * would fail with a `ContextUnavailableError` rather than the thing it asserts.
 */
export function withContext<T>(ctx: RequestContext, body: () => Promise<T>): Promise<T> {
  return runInContext(ctx, body);
}

export interface ActorFixture {
  readonly orgUuid: string;
  readonly orgId: Buffer;
  readonly userUuid: string;
  readonly userId: Buffer;
  readonly ctx: RequestContext;
}

/** An org, a member holding one of the six seeded system roles, and a context for the pair. */
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
 * A contact, and a dimension with two values.
 *
 * Written here rather than added to `test/db/factories.ts`: contacts and
 * dimensions are OB-036's and OB-037's, and their factories belong with the
 * services that own those tables. These insert as the **app** user, which is the
 * stronger position — a missing grant surfaces here rather than in production.
 */
export async function contactIn(
  db: TestDatabase,
  orgId: Buffer,
  name = 'Acme Ltd',
): Promise<Buffer> {
  const id = newUuidBuffer();
  await db.app
    .insertInto('contacts')
    .values({ id, org_id: orgId, display_name: name, is_vendor: 1 })
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

export async function connectionId(db: Kysely<DB>): Promise<string> {
  const { rows } = await sql<{ id: bigint }>`SELECT CONNECTION_ID() AS id`.execute(db);
  return String(rows[0]?.id);
}

/** A call in flight, with settlement observable without consuming the promise. */
export interface Attempt<T> {
  readonly promise: Promise<T>;
  /** The contention probe: a statement waiting on a row lock cannot have settled. */
  hasSettled(): boolean;
}

/** An attempt held open after its body finished, still holding every lock it took. */
export interface ParkedAttempt<T> extends Attempt<T> {
  readonly parked: Promise<T>;
  commit(): void;
  rollback(reason: Error): void;
}

/**
 * Runs `body` in its own transaction on `connection`, inside `ctx`'s scope.
 *
 * Opening the transaction here and entering its scope is how a service call is
 * pinned to a chosen connection — the services take no handle and consult
 * `ambientTransaction()`. It is not a test-only contrivance: it is the shape
 * `withIdempotency(spec, () => postDraft(id))` has in production.
 */
export function transactionOn<T>(
  connection: AppConnection,
  ctx: RequestContext,
  body: () => Promise<T>,
): Attempt<T> {
  return watch(runScoped(connection, ctx, body));
}

/** As `transactionOn`, but holds the transaction open until `commit()` or `rollback()`. */
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
    // Rejecting `release` throws from here, which is what rolls the transaction
    // back — the same mechanism a real downstream failure uses.
    await release.promise;
    return value;
  });

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
  void promise.then(mark, mark);
  return { promise, hasSettled: () => settled };
}

/**
 * Everything about one org's drafts and ledger that a half-applied post would
 * disturb.
 *
 * D-19's claim is that posting a draft and discarding it are one transaction, and
 * that claim is negative in both directions: after a successful post there is a
 * journal and *no* draft, and after a failed one there is a draft and *no*
 * journal. Neither is provable from a count of journals alone, so the two are
 * always read together, from a connection that is not one of the racing pair.
 */
export interface DraftLedgerState {
  readonly drafts: number;
  readonly draftLines: number;
  readonly draftTags: number;
  readonly journals: number;
  readonly journalLines: number;
  readonly sequenceNumbers: readonly string[];
}

export async function readDraftLedgerState(
  db: Kysely<DB>,
  orgId: Buffer,
): Promise<DraftLedgerState> {
  const count = async (
    table:
      | 'journal_drafts'
      | 'journal_draft_lines'
      | 'journal_draft_line_dimensions'
      | 'journals'
      | 'journal_lines',
  ): Promise<number> => {
    const { rows } = await sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM ${sql.table(table)} WHERE org_id = ${orgId}
    `.execute(db);
    return Number(rows[0]?.count ?? 0);
  };

  const journals = await db
    .selectFrom('journals')
    .select('sequence_number')
    .where('org_id', '=', orgId)
    .orderBy('sequence_number')
    .execute();

  return {
    drafts: await count('journal_drafts'),
    draftLines: await count('journal_draft_lines'),
    draftTags: await count('journal_draft_line_dimensions'),
    journals: await count('journals'),
    journalLines: await count('journal_lines'),
    sequenceNumbers: journals.map((row) => String(row.sequence_number)),
  };
}
