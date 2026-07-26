import { beforeEach, describe, expect, it } from 'vitest';

import type { RequestContext } from '../../src/context';
import { postJournal } from '../../src/modules/ledger';
import { OWNER_ROLE_ID } from '../../src/modules/orgs';
import { closePeriod } from '../../src/modules/periods';
import { useTestDatabase } from '../db';
import {
  CONTENTION_WAIT_MS,
  connectionId,
  contextFor,
  delay,
  EMPTY_LEDGER,
  parkedTransactionOn,
  readLedgerState,
  transactionOn,
} from './support';

/**
 * **Acceptance A9 — a posting racing a period lock leaves no half-written journal.**
 *
 * This is the one M1 acceptance criterion that no other suite can make. A4 (posting
 * into an already-closed period is refused) is covered sequentially by
 * `test/ledger/posting.test.ts` and at the route surface by
 * `test/transport/v1.test.ts`; both start from a period that was closed and committed
 * before the posting began. A9 is about the *interval* between those two states, and
 * it has two halves that a sequential test cannot separate:
 *
 *  - the close commits first, so the posting's locking read sees `closed` and rejects
 *    **having written nothing**;
 *  - the posting wins, so the close blocks until the posting commits or rolls back.
 *
 * `src/modules/ledger/posting.service.ts` states this as the reason its steps are
 * ordered (period lock at step 4, sequence lock at 5, inserts at 6) and
 * `assertPostable` takes `FOR UPDATE` by default precisely so the race is decidable
 * rather than resolved by whichever transaction happened to read first. These tests
 * are the evidence for both claims.
 *
 * ## How contention is proved rather than assumed
 *
 * One side is parked mid-transaction, holding the `fiscal_periods` row lock; the other
 * is started and observed *failing to settle* across `CONTENTION_WAIT_MS`, the same
 * technique `test/idempotency/concurrency.test.ts` uses. That assertion is what
 * distinguishes a real race from two calls that merely ran in some order: a posting
 * whose period read took no lock settles immediately, and the wait catches it.
 *
 * ## Why there is no `initializeDatabase()` here
 *
 * Every other database-backed suite points the process-wide pool at the container so
 * `tenantDb()` resolves. This one must not: with no pool, a query that escaped the
 * ambient transaction throws "Database not initialized" instead of silently running on
 * a third connection, where it would see neither racer's uncommitted state and the
 * race would appear to pass having proved nothing. See `./support.ts`.
 */
const db = useTestDatabase();

interface Scene {
  readonly ctx: RequestContext;
  readonly orgId: Buffer;
  readonly periodUuid: string;
  readonly date: string;
  readonly debit: string;
  readonly credit: string;
}

let s: Scene;

beforeEach(async () => {
  const ledger = await db.factories.ledger();
  s = {
    ctx: contextFor(ledger.org.uuid, OWNER_ROLE_ID, ledger.user.uuid),
    orgId: ledger.org.id,
    periodUuid: ledger.period.uuid,
    date: ledger.period.startDate,
    debit: ledger.debitAccount.uuid,
    credit: ledger.creditAccount.uuid,
  };
});

/**
 * A balanced posting with `pairs` debit/credit pairs.
 *
 * More than one pair matters for the rollback case: `insertJournalLines` writes the
 * whole line set in one statement, so a *shorter than expected* line set is a
 * distinguishable outcome only when the expected length is greater than one.
 */
function balanced(pairs = 1): Parameters<typeof postJournal>[0] {
  const amount = 150_000n;
  return {
    date: s.date,
    memo: 'Cash sale',
    actorType: 'user' as const,
    actorId: s.ctx.actorId,
    lines: Array.from({ length: pairs }).flatMap((_, index) => [
      { accountId: s.debit, side: 'debit' as const, amount, memo: `debit ${String(index)}` },
      { accountId: s.credit, side: 'credit' as const, amount, memo: `credit ${String(index)}` },
    ]),
  };
}

describe('A9 — a posting racing a period close', () => {
  it('is refused, and writes nothing, when the close commits first', async () => {
    const closer = await db.openAppConnection();
    const poster = await db.openAppConnection();

    try {
      // The harness's guarantee restated as an assertion: two handles that shared a
      // physical connection would serialize instead of racing, and every "did not
      // settle" assertion below would then be measuring the driver, not InnoDB.
      expect(await connectionId(closer.db)).not.toBe(await connectionId(poster.db));

      // The close has run and holds an exclusive lock on the period row. Its new
      // `status = 'closed'` exists but is committed to nobody.
      const close = parkedTransactionOn(closer, s.ctx, () =>
        closePeriod({ periodId: s.periodUuid }),
      );
      await close.parked;

      const post = transactionOn(poster, s.ctx, () => postJournal(balanced()));
      await delay(CONTENTION_WAIT_MS);

      // The proof that the lock is doing the work: `assertPostable`'s `FOR UPDATE`
      // read is queued behind the close and cannot answer either way. Without the
      // lock this read would return the pre-close snapshot and the posting would
      // already have succeeded.
      expect(post.hasSettled()).toBe(false);

      close.commit();
      expect((await close.promise).status).toBe('closed');

      // A locking read in InnoDB reads the latest committed row rather than the
      // transaction's snapshot, so the posting now learns the truth — A4's answer,
      // reached from inside the race.
      await expect(post.promise).rejects.toMatchObject({
        code: 'precondition_failed',
        details: { precondition: 'period_closed' },
      });

      // A9 itself, and stated as the whole absence rather than as "no journal row":
      // `readLedgerState` enumerates every shape a partial write could take, so this
      // one literal also says no orphan lines, no header without lines, and —
      // `nextSequenceValue: null` — no journal number consumed, which is what keeps
      // D-14's gaplessness true of a ledger that has lost a race.
      expect(await readLedgerState(db.app, s.orgId)).toEqual(EMPTY_LEDGER);
    } finally {
      await closer.close();
      await poster.close();
    }
  });

  it('blocks the close until it commits, and the journal is whole', async () => {
    const poster = await db.openAppConnection();
    const closer = await db.openAppConnection();

    try {
      expect(await connectionId(poster.db)).not.toBe(await connectionId(closer.db));

      // The posting has taken the period lock, allocated its number, and written its
      // header and lines — all uncommitted.
      const post = parkedTransactionOn(poster, s.ctx, () => postJournal(balanced(3)));
      const posted = await post.parked;
      expect(posted.lines).toHaveLength(6);

      // Nothing of it is visible from a third connection yet, which is what makes the
      // "no partial journal" assertion after the commit an assertion about the
      // database's atomicity rather than about read timing.
      expect(await readLedgerState(db.app, s.orgId)).toEqual(EMPTY_LEDGER);

      const close = transactionOn(closer, s.ctx, () => closePeriod({ periodId: s.periodUuid }));
      await delay(CONTENTION_WAIT_MS);

      // The other direction of the same guarantee: a close cannot slip past a posting
      // that is already in flight, so the period it closes has every posting dated
      // inside it accounted for.
      expect(close.hasSettled()).toBe(false);

      post.commit();
      await post.promise;
      expect((await close.promise).status).toBe('closed');

      expect(await readLedgerState(db.app, s.orgId)).toEqual({
        journals: 1,
        lines: 6,
        headersWithoutLines: 0,
        orphanLines: 0,
        linesPerJournal: [6],
        sequenceNumbers: ['1'],
        nextSequenceValue: '2',
      });
    } finally {
      await poster.close();
      await closer.close();
    }
  });

  it('leaves no header, no lines, and no partial line set when it rolls back', async () => {
    // The negative half of A9, and the one a passing posting cannot demonstrate: the
    // header and the six lines are two separate statements, and the claim is that
    // neither survives without the other. The abort is injected after the posting
    // returned, which is where a real failure downstream of the kernel arrives —
    // a rejected idempotency claim, a serialization failure, a request that died.
    const poster = await db.openAppConnection();
    const closer = await db.openAppConnection();

    try {
      const post = parkedTransactionOn(poster, s.ctx, () => postJournal(balanced(3)));
      await post.parked;

      const close = transactionOn(closer, s.ctx, () => closePeriod({ periodId: s.periodUuid }));
      await delay(CONTENTION_WAIT_MS);
      expect(close.hasSettled()).toBe(false);

      const abandoned = new Error('the request that made this posting died');
      post.rollback(abandoned);
      await expect(post.promise).rejects.toBe(abandoned);

      // The close was waiting on the posting's period lock and proceeds the moment the
      // rollback releases it — so a failed posting does not strand a close either.
      expect((await close.promise).status).toBe('closed');

      expect(await readLedgerState(db.app, s.orgId)).toEqual(EMPTY_LEDGER);
    } finally {
      await poster.close();
      await closer.close();
    }
  });
});
