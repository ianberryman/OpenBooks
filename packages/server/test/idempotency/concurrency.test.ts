import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';

import type { DB } from '../../src/db/generated';
import { TenantDatabase } from '../../src/db';
import { runIdempotent } from '../../src/modules/idempotency';
import { useTestDatabase } from '../db/harness';
import { accountCodes, accountWriter, claimRows, deferred, delay } from './support';

/**
 * The concurrency behaviour is the deliverable (spec §11: "duplicate idempotency key
 * yields one journal"), so it is tested for real: two separate connections, both as
 * `openbooks_app`, contending on `uq_idempotency_org_key` in the live database.
 *
 * ## Why these cannot be simulated sequentially
 *
 * Running two calls one after another proves that a *committed* claim is replayed.
 * That is a different statement, and it is the easy half. The hard half is what
 * happens in the window where the first transaction has claimed the key and not yet
 * committed — and that window does not exist unless two connections are open at once.
 * The harness exists for this: `openAppConnection()` returns a genuinely distinct
 * connection (asserted below via `CONNECTION_ID()`), and isolation between tests is
 * truncation rather than a shared transaction precisely so committed rows are visible
 * across connections.
 *
 * ## How each test proves contention actually happened
 *
 * By observing that the second call **cannot finish** while the first holds the
 * uncommitted claim: `settled` stays false across a wait, then flips only after the
 * first transaction is released. A sequential simulation cannot produce that, and
 * neither can a version of the service that checks-then-acts without the unique
 * index — it would sail through and execute twice.
 *
 * The waits are generous and one-directional. They can make a test slow, never
 * flaky-passing: every assertion is about a state that has to hold, and the "did not
 * finish yet" assertion is the one a broken implementation fails immediately.
 */

const ENDPOINT = 'journals.post';
const REQUEST = { date: '2026-07-01', lines: [{ side: 'debit', amount: 100n }] };
const SPEC = { endpoint: ENDPOINT, request: REQUEST };

/** Long enough for a blocked INSERT to have definitely reached the index. */
const CONTENTION_WAIT_MS = 750;

async function connectionId(db: Kysely<DB>): Promise<string> {
  const { rows } = await sql<{ id: bigint }>`SELECT CONNECTION_ID() AS id`.execute(db);
  return String(rows[0]!.id);
}

/** Tracks settlement without consuming the promise, so it can still be awaited. */
function watch<T>(promise: Promise<T>): { readonly settled: () => boolean } {
  let settled = false;
  const mark = (): void => {
    settled = true;
  };
  void promise.then(mark, mark);
  return { settled: () => settled };
}

describe('two concurrent requests with the same idempotency key', () => {
  const db = useTestDatabase();

  it('execute exactly once, and the loser observes the committed outcome', async () => {
    const org = await db.factories.org();
    const first = await db.openAppConnection();
    const second = await db.openAppConnection();

    try {
      // The harness's guarantee, restated as an assertion: two pooled handles could
      // land on one physical connection and serialize instead of racing.
      expect(await connectionId(first.db)).not.toBe(await connectionId(second.db));

      const entered = deferred();
      const release = deferred();
      const write = accountWriter(async (execution) => {
        // Only the winner ever gets here. If the loser does too, `executions` says so.
        if (execution === 1) {
          entered.resolve();
          await release.promise;
        }
      });

      const winner = runIdempotent(
        new TenantDatabase(first.db, org.id),
        'raced-key',
        SPEC,
        write.operation,
      );
      // The winner now holds an uncommitted claim row and is parked inside its
      // transaction.
      await entered.promise;

      const loser = runIdempotent(
        new TenantDatabase(second.db, org.id),
        'raced-key',
        SPEC,
        write.operation,
      );
      const loserState = watch(loser);
      await delay(CONTENTION_WAIT_MS);

      // The proof of a real race: the loser's INSERT is blocked on the winner's
      // index lock and cannot resolve either way until the winner commits.
      expect(loserState.settled()).toBe(false);
      expect(write.executions()).toBe(1);

      release.resolve();
      const [winnerResult, loserResult] = await Promise.all([winner, loser]);

      expect(winnerResult.outcome).toBe('executed');
      expect(loserResult.outcome).toBe('replayed');
      // The whole point of OB-017, in three assertions: one execution, one claim,
      // one row written.
      expect(write.executions()).toBe(1);
      expect(await claimRows(db.app, org.id)).toHaveLength(1);
      expect(await accountCodes(db.app, org.id)).toEqual(['IDEM-1']);
      // And the loser returned the winner's response rather than an empty one.
      expect(loserResult.body).toEqual(winnerResult.body);
      expect(loserResult.status).toBe(winnerResult.status);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('lets the loser execute when the winner rolls back, rather than poisoning the key', async () => {
    // Both halves of the design in one test: the claim is released by the rollback,
    // and the request that was waiting on it is the one that then does the work.
    const org = await db.factories.org();
    const first = await db.openAppConnection();
    const second = await db.openAppConnection();

    try {
      const entered = deferred();
      const release = deferred();
      const failure = new Error('period is closed');
      const write = accountWriter(async (execution) => {
        if (execution === 1) {
          entered.resolve();
          await release.promise;
          throw failure;
        }
      });

      const doomed = runIdempotent(
        new TenantDatabase(first.db, org.id),
        'released-key',
        SPEC,
        write.operation,
      );
      await entered.promise;

      const waiting = runIdempotent(
        new TenantDatabase(second.db, org.id),
        'released-key',
        SPEC,
        write.operation,
      );
      const waitingState = watch(waiting);
      await delay(CONTENTION_WAIT_MS);

      expect(waitingState.settled()).toBe(false);

      release.resolve();
      await expect(doomed).rejects.toBe(failure);

      // The second request's INSERT now succeeds — there is no committed row to
      // collide with — so it runs the operation instead of replaying a failure.
      const result = await waiting;

      expect(result.outcome).toBe('executed');
      expect(write.executions()).toBe(2);
      // The failed attempt left nothing: one claim, one account, both the survivor's.
      expect(await claimRows(db.app, org.id)).toHaveLength(1);
      expect(await accountCodes(db.app, org.id)).toEqual(['IDEM-2']);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('does not serialize writes that carry different keys', async () => {
    // The complement, and a guard against "fix" the race by locking more: if
    // contention were on anything coarser than (org_id, idempotency_key), two
    // unrelated writes would queue behind each other and the API would be serial.
    const org = await db.factories.org();
    const first = await db.openAppConnection();
    const second = await db.openAppConnection();

    try {
      const bothInside = deferred();
      const release = deferred();
      let inside = 0;
      const write = accountWriter(async () => {
        inside += 1;
        if (inside === 2) bothInside.resolve();
        await release.promise;
      });

      const a = runIdempotent(new TenantDatabase(first.db, org.id), 'key-a', SPEC, write.operation);
      const b = runIdempotent(
        new TenantDatabase(second.db, org.id),
        'key-b',
        SPEC,
        write.operation,
      );

      // Both operation bodies are inside their transactions at the same time. With a
      // coarser lock this never resolves and the test times out.
      await bothInside.promise;
      release.resolve();

      const results = await Promise.all([a, b]);

      expect(results.map((result) => result.outcome)).toEqual(['executed', 'executed']);
      expect(write.executions()).toBe(2);
      expect(await claimRows(db.app, org.id)).toHaveLength(2);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('keeps the same key in two orgs from contending at all', async () => {
    // Org scoping under contention: the unique index is (org_id, idempotency_key), so
    // one org's in-flight claim must not block another org's identical key. If it did,
    // any tenant could stall another tenant's writes with a guessed key.
    const orgA = await db.factories.org();
    const orgB = await db.factories.org();
    const first = await db.openAppConnection();
    const second = await db.openAppConnection();

    try {
      const bothInside = deferred();
      const release = deferred();
      let inside = 0;
      const write = accountWriter(async () => {
        inside += 1;
        if (inside === 2) bothInside.resolve();
        await release.promise;
      });

      const a = runIdempotent(
        new TenantDatabase(first.db, orgA.id),
        'cross-org-key',
        SPEC,
        write.operation,
      );
      const b = runIdempotent(
        new TenantDatabase(second.db, orgB.id),
        'cross-org-key',
        SPEC,
        write.operation,
      );

      await bothInside.promise;
      release.resolve();

      const results = await Promise.all([a, b]);

      expect(results.map((result) => result.outcome)).toEqual(['executed', 'executed']);
      expect(await claimRows(db.app, orgA.id)).toHaveLength(1);
      expect(await claimRows(db.app, orgB.id)).toHaveLength(1);
    } finally {
      await first.close();
      await second.close();
    }
  });
});
