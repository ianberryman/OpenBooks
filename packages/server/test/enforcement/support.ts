import { sql, type Kysely } from 'kysely';

import { createRequestContext, runInContext, type RequestContext } from '../../src/context';
import type { DB } from '../../src/db/generated';
import { runInTransactionScope } from '../../src/db/transaction-scope';
import type { AppConnection } from '../db';

/**
 * Scaffolding for OB-026's enforcement and concurrency suites.
 *
 * ## The one thing this file exists for
 *
 * A9 — "posting racing a period lock leaves no half-written journal" — is a claim
 * about two transactions on two connections contending for one row. It cannot be
 * made against one connection, and it cannot be made by running two calls in
 * sequence: sequential calls prove what happens after a commit, which is the easy
 * half and is already covered by `test/ledger/posting.test.ts` (A4). The hard half is
 * the window in which one transaction holds the period row and the other has not yet
 * been told anything, and that window does not exist unless both are open at once.
 *
 * So every race here is built from `db.openAppConnection()` handles — one physical
 * connection each, asserted distinct via `connectionId()` — and one side is *parked*
 * mid-transaction while the other is observed failing to settle. See
 * `parkedTransactionOn` for how the parking works and `CONTENTION_WAIT_MS` for why
 * the wait can only make a test slow, never make it pass wrongly.
 *
 * ## Why the services run inside a transaction this file owns
 *
 * `postJournal` and `closePeriod` take no database handle. They reach data through
 * `tenantDb()` / `systemDb()`, which consult `ambientTransaction()` before falling
 * back to the process pool (`src/db/transaction-scope.ts`). Opening a transaction on
 * a chosen connection and entering its scope is therefore how a service call is
 * pinned to that connection — and it is not a test-only contrivance: it is exactly
 * the shape `withIdempotency(spec, () => postJournal(input, ctx))` has in production,
 * where the outer transaction belongs to the idempotency layer and the posting joins
 * it. Parking before the outer commit is parking in the same place a real request can
 * be parked.
 *
 * A consequence worth stating, because it is load-bearing: the suites that use this
 * deliberately do **not** call `initializeDatabase()`. With no process pool, any
 * query that escaped the ambient transaction would throw "Database not initialized"
 * rather than quietly running on a third connection — where it would see neither
 * side's uncommitted state and the race would appear to pass having proved nothing.
 *
 * Helpers duplicated from `test/idempotency/support.ts` (`deferred`, `delay`) and
 * from `test/ledger/support.ts` (`contextFor`) rather than imported, following the
 * convention `test/periods/support.ts` states: these are two tickets' fixtures, and
 * neither suite should break when the other's helper changes.
 */

/**
 * How long a blocked statement is given to prove it is blocked.
 *
 * One-directional, like the wait in `test/idempotency/concurrency.test.ts`: every
 * assertion taken after it is about a state that must *hold*, and "has not settled
 * yet" is the assertion a broken implementation fails immediately. A too-short wait
 * cannot make a passing test out of a failing one — it can only fail to catch a
 * mutation, and 750 ms is far longer than a lock acquisition on a local container.
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
 * Through `createRequestContext` rather than an object literal: the permission memo
 * in `permissions.service.ts` is a `WeakMap` keyed on the frozen context object, so a
 * literal would be a different kind of key from the one the request path produces.
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
   * Resolves once `body` has returned and the transaction is parked — every row it
   * locked is held, and every row it wrote is written but invisible to anyone else.
   *
   * Rejects if `body` itself failed, so a test awaiting the park reports the real
   * error instead of timing out.
   */
  readonly parked: Promise<T>;
  /** Commits the parked transaction. `promise` then resolves with the body's value. */
  commit(): void;
  /** Rolls the parked transaction back. `promise` then rejects with `reason`. */
  rollback(reason: Error): void;
}

/**
 * Runs `body` in its own transaction on `connection`, inside `ctx`'s scope.
 *
 * The transaction commits when `body` resolves, so this is the *racing* side: it is
 * started and then observed, and the only thing that can keep it from finishing
 * promptly is another transaction's lock.
 */
export function transactionOn<T>(
  connection: AppConnection,
  ctx: RequestContext,
  body: () => Promise<T>,
): Attempt<T> {
  return watch(runScoped(connection, ctx, body));
}

/**
 * As `transactionOn`, but pauses after `body` resolves and holds the transaction
 * open until `commit()` or `rollback()`.
 *
 * `rollback` works by throwing out of the transaction callback, which is the only
 * way to make Kysely roll back — and it is the right mechanism rather than a
 * workaround, because it is how a real failure downstream of a posting (a failing
 * idempotency claim, a serialization error) aborts one.
 */
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
  // rejection handler is what keeps an expected failure from becoming an unhandled
  // rejection before the test gets to assert on it.
  void promise.then(mark, mark);
  return { promise, hasSettled: () => settled };
}

/**
 * Everything about one org's ledger that a partial write would disturb.
 *
 * A9's claim is negative — "leaves no half-written journal" — and a negative claim
 * needs every way it could be false enumerated in one place, or a test asserts the
 * absence it happened to think of. The four counts below are the four shapes a
 * partial journal can take: a header with no lines, lines with no header, a line set
 * shorter than the posting that wrote it, and a sequence number consumed by a
 * posting that no longer exists (which would make the gapless guarantee of D-14
 * false without any journal row being wrong).
 *
 * Read on a handle of the caller's choosing so it can be pointed at a *third*
 * connection: asserted from one of the racing connections, an uncommitted row would
 * be visible and the absence would not be an absence.
 *
 * `bigint`s are stringified so a failing `toEqual` prints a readable diff and so the
 * shape can be written as a literal in the test.
 */
export interface LedgerState {
  readonly journals: number;
  readonly lines: number;
  readonly headersWithoutLines: number;
  readonly orphanLines: number;
  /** Line count per journal, ordered by `sequence_number`. */
  readonly linesPerJournal: readonly number[];
  readonly sequenceNumbers: readonly string[];
  /** `journal_sequences.next_value`, or null when the counter row does not exist. */
  readonly nextSequenceValue: string | null;
}

export async function readLedgerState(db: Kysely<DB>, orgId: Buffer): Promise<LedgerState> {
  const journals = await db
    .selectFrom('journals')
    .leftJoin('journal_lines', (join) =>
      join
        .onRef('journal_lines.org_id', '=', 'journals.org_id')
        .onRef('journal_lines.journal_id', '=', 'journals.id'),
    )
    // `eb` is not destructured: `ref` taken off the expression builder is an unbound
    // method, which `@typescript-eslint/unbound-method` correctly refuses.
    .select((eb) => [
      'journals.sequence_number as sequence_number',
      eb.fn.count<string>(eb.ref('journal_lines.id')).as('lines'),
    ])
    .where('journals.org_id', '=', orgId)
    .groupBy('journals.sequence_number')
    .orderBy('journals.sequence_number')
    .execute();

  // Counted independently of the join above rather than summed from it, so a line
  // whose parent is missing is visible as a discrepancy instead of being dropped.
  const lines = await db
    .selectFrom('journal_lines')
    .select(({ fn }) => fn.countAll<string>().as('count'))
    .where('org_id', '=', orgId)
    .executeTakeFirstOrThrow();

  const orphans = await db
    .selectFrom('journal_lines')
    .leftJoin('journals', (join) =>
      join
        .onRef('journals.org_id', '=', 'journal_lines.org_id')
        .onRef('journals.id', '=', 'journal_lines.journal_id'),
    )
    .select(({ fn }) => fn.countAll<string>().as('count'))
    .where('journal_lines.org_id', '=', orgId)
    .where('journals.id', 'is', null)
    .executeTakeFirstOrThrow();

  const counter = await db
    .selectFrom('journal_sequences')
    .select('next_value')
    .where('org_id', '=', orgId)
    .executeTakeFirst();

  const linesPerJournal = journals.map((row) => Number(row.lines));

  return {
    journals: journals.length,
    lines: Number(lines.count),
    headersWithoutLines: linesPerJournal.filter((count) => count === 0).length,
    orphanLines: Number(orphans.count),
    linesPerJournal,
    sequenceNumbers: journals.map((row) => String(row.sequence_number)),
    nextSequenceValue: counter === undefined ? null : String(counter.next_value),
  };
}

/** The state of an org that has never been posted to. Nothing written, nothing consumed. */
export const EMPTY_LEDGER: LedgerState = {
  journals: 0,
  lines: 0,
  headersWithoutLines: 0,
  orphanLines: 0,
  linesPerJournal: [],
  sequenceNumbers: [],
  nextSequenceValue: null,
};
