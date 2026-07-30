import { beforeEach, describe, expect, it } from 'vitest';

import { toWireError } from '../../src/errors';
import { buildPendingPayment } from '../../src/modules/pay-bills';
import { useTestDatabase } from '../db';
import type { ApDocumentFixture, PbScene } from './support';
import {
  CONTENTION_WAIT_MS,
  committedForBillDirect,
  connectionId,
  delay,
  documentIn,
  parkedTransactionOn,
  sceneIn,
  transactionOn,
} from './support';

/**
 * D-68, proved rather than assumed: two pending payments cannot each commit a
 * remainder the other one already spent.
 *
 * `committedForBill` is a locking read for exactly the reason
 * `over-allocation-race.test.ts` measured for `allocatedToDocument`: the bill is
 * locked `FOR UPDATE` by the caller (`resolveIntents`'s `assertAvailable`), but
 * under REPEATABLE READ a plain `SELECT SUM(...)` would still be served from this
 * transaction's first consistent snapshot — established before the winner
 * committed — and a loser that blocked on the bill lock and then summed with a
 * plain read would see nothing committed and queue the same remainder twice. A
 * sequential test cannot catch this: "build, check, build again" passes against an
 * implementation with no lock at all, because the window the bug lives in only
 * exists between two transactions that are open at once (CLAUDE.md).
 *
 * So this runs on two `openAppConnection()` handles, asserted distinct, with one
 * side parked mid-transaction while the other is observed failing to settle. The
 * process pool is deliberately left uninitialized (`useTestDatabase`, not
 * `useServiceDatabase`): with no pool, a query that escaped the ambient
 * transaction throws rather than quietly running on a third connection, where it
 * would see neither side's uncommitted state and the race would appear to pass
 * having proved nothing. `db.app` is that third connection, used only to observe.
 */
const db = useTestDatabase();

let s: PbScene;
let bill: ApDocumentFixture;

beforeEach(async () => {
  s = await sceneIn(db);
  // 1,000.00 outstanding, nothing committed yet.
  bill = await documentIn(db, s, 'bill', 100_000n);
});

function buildRequest(payAmount: string) {
  return {
    contactId: s.vendorUuid,
    bankAccountId: s.bankAccountUuid,
    rail: 'check' as const,
    intents: [{ billId: bill.uuid, payAmount }],
  };
}

describe('two pending payments racing the same bill', () => {
  it('serialize on the bill row, and the loser is refused once it can see the winner', async () => {
    const first = await db.openAppConnection();
    const second = await db.openAppConnection();

    try {
      expect(await connectionId(first.db)).not.toBe(await connectionId(second.db));

      // 700.00 and 500.00 each fit alone against 1,000.00 outstanding, but
      // together they exceed it by 200.00 — exactly the shape D-68 exists to
      // refuse.
      const winner = parkedTransactionOn(first, s.ctx, () =>
        buildPendingPayment(buildRequest('70000'), s.ctx),
      );
      // The winner has read the bill `FOR UPDATE` in `assertAvailable`, found
      // 1,000.00 available, and inserted its intent — all uncommitted, still
      // holding the bill's row lock.
      expect((await winner.parked).totalAmount).toBe('70000');

      const loser = transactionOn(second, s.ctx, () =>
        buildPendingPayment(buildRequest('50000'), s.ctx),
      );
      await delay(CONTENTION_WAIT_MS);

      // The mechanism, asserted: `resolveIntents` takes the bill `FOR UPDATE`
      // before it computes `committedForBill`, so the loser is blocked before it
      // has read anything about what is already committed. Without that lock it
      // would sum zero committed, see 1,000.00 available, and insert alongside
      // the winner — 1,200.00 queued against a 1,000.00 bill.
      expect(loser.hasSettled()).toBe(false);

      // Nothing is visible from outside until the winner commits.
      expect(await committedForBillDirect(db.app, bill.id)).toBe(0n);

      winner.commit();
      await winner.promise;

      // The loser's `committedForBill` is a `FOR SHARE` read and therefore a
      // *current* one, so once the winner commits it sees the winner's 700.00 and
      // recomputes: only 300.00 is left, and 500.00 exceeds it.
      const error = await loser.promise.then(
        () => undefined,
        (thrown: unknown) => toWireError(thrown),
      );
      expect(error).toMatchObject({
        code: 'precondition_failed',
        details: { precondition: 'bill_over_committed' },
      });

      // The covered amount is never double-committed: only the winner's 700.00
      // stands, not 700.00 + 500.00.
      expect(await committedForBillDirect(db.app, bill.id)).toBe(70_000n);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('applies to different bills without waiting on each other', async () => {
    const first = await db.openAppConnection();
    const second = await db.openAppConnection();

    try {
      const other = await documentIn(db, s, 'bill', 100_000n);

      const parked = parkedTransactionOn(first, s.ctx, () =>
        buildPendingPayment(buildRequest('70000'), s.ctx),
      );
      await parked.parked;

      const concurrent = transactionOn(second, s.ctx, () =>
        buildPendingPayment(
          {
            contactId: s.vendorUuid,
            bankAccountId: s.bankAccountUuid,
            rail: 'check' as const,
            intents: [{ billId: other.uuid, payAmount: '40000' }],
          },
          s.ctx,
        ),
      );

      parked.commit();
      await parked.promise;

      await expect(concurrent.promise).resolves.toMatchObject({ totalAmount: '40000' });

      expect(await committedForBillDirect(db.app, bill.id)).toBe(70_000n);
      expect(await committedForBillDirect(db.app, other.id)).toBe(40_000n);
    } finally {
      await first.close();
      await second.close();
    }
  });
});
