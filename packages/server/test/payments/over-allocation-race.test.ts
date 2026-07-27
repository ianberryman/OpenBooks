import { beforeEach, describe, expect, it } from 'vitest';

import type { RequestContext } from '../../src/context';
import { toWireError } from '../../src/errors';
import { allocatePayment, recordPayment } from '../../src/modules/payments';
import { useTestDatabase } from '../db';
import type { DocumentFixture, Scene } from './support';
import {
  CONTENTION_WAIT_MS,
  connectionId,
  delay,
  documentIn,
  outstandingOf,
  parkedTransactionOn,
  readLedgerState,
  sceneIn,
  transactionOn,
} from './support';

/**
 * **C3, proved rather than assumed**: over-allocating a document is refused, and
 * it is refused under contention.
 *
 * This file exists because the sequential test in `allocations.service.test.ts`
 * cannot prove it. "Read what is outstanding, decide, insert" passes every
 * sequential test against an implementation that takes no lock at all — the
 * failure it is meant to catch is a second caller arriving *between* the read and
 * the insert, and that window does not exist unless two transactions are open at
 * once. CLAUDE.md states the rule the hard way: a sequential simulation of a race
 * passes against code that has no locking.
 *
 * So every case here runs on two `openAppConnection()` handles, asserted distinct,
 * with one side parked mid-transaction while the other is observed *failing to
 * settle*. `db.app` is a third connection, used only to observe — an uncommitted
 * row read from one of the racing pair is not evidence of anything.
 *
 * The process pool is deliberately left uninitialized (`useTestDatabase`, not
 * `useServiceDatabase`): with no pool, a query that escaped the ambient
 * transaction throws rather than quietly running on a third connection, where it
 * would see neither side's uncommitted state and the race would appear to pass
 * having proved nothing.
 *
 * ## What this file caught, and what removing each half does
 *
 * It was written against an implementation that took the document row `FOR UPDATE`
 * and then recomputed the outstanding amount with a plain `SELECT SUM(...)`, which
 * reads like the obviously correct thing. **It over-allocated anyway.** The loser
 * blocked on the row lock for the full contention wait, resumed after the winner
 * committed, summed the allocations from the consistent snapshot its transaction
 * had established at its *first* non-locking read — before the winner committed —
 * saw nothing applied, and settled a 100.00 invoice a second time. Both
 * transactions committed. The fix is in `allocations.repository.ts`: the sums are
 * locking reads, because a locking read is always a current read.
 *
 * Both mutations were run, and only one of them fails — which is itself the
 * finding:
 *
 *  - **`.forShare()` removed from `allocatedToDocument`**: the contention probe
 *    still passes, and the outcome is wrong. The loser blocks, resumes, recomputes
 *    from its stale snapshot, and is *accepted*: two allocations against a 100.00
 *    invoice. A test that asserted only "the loser blocks" would have passed here,
 *    which is why this file asserts what the loser is finally told and what the
 *    tables hold.
 *  - **`.forUpdate()` removed from `selectDocumentByIdForUpdate`**: the whole file
 *    still passes. The shared lock the sum takes on the allocation rows serializes
 *    the pair as a side effect — the loser's scan meets the winner's uncommitted
 *    row and waits there instead. The document lock is kept regardless, and not as
 *    superstition: it is the explicit, legible serialization point, and it is what
 *    orders an allocation against a concurrent *void or approval* of the same
 *    document, which is a race this file does not cover and which the other M3
 *    modules own the other side of.
 */
const db = useTestDatabase();

let s: Scene;
let invoice: DocumentFixture;

beforeEach(async () => {
  s = await sceneIn(db);
  invoice = await documentIn(db, s, 'invoice', { amountMinor: 10000n });
});

type Connection = Awaited<ReturnType<typeof db.openAppConnection>>;

/** A recorded, committed receipt on a chosen connection. */
async function receiptOn(connection: Connection, ctx: RequestContext): Promise<string> {
  const payment = await transactionOn(connection, ctx, () =>
    recordPayment(
      {
        direction: 'received',
        contactId: s.contact.uuid,
        date: s.date,
        amount: '10000',
        accountId: s.bank.uuid,
      },
      ctx,
    ),
  ).promise;

  return payment.id;
}

function settleWhole(paymentId: string, ctx: RequestContext, documentUuid: string) {
  return allocatePayment(
    paymentId,
    { allocations: [{ targetType: 'invoice', targetId: documentUuid, amount: '10000' }] },
    ctx,
  );
}

describe('two payments racing for the last of one invoice', () => {
  it('serialize on the document row, and exactly one is applied', async () => {
    const first = await db.openAppConnection();
    const second = await db.openAppConnection();

    try {
      expect(await connectionId(first.db)).not.toBe(await connectionId(second.db));

      const winnerPayment = await receiptOn(first, s.ctx);
      const loserPayment = await receiptOn(second, s.ctx);

      // The winner has read the invoice `FOR UPDATE`, found 100.00 outstanding, and
      // inserted its allocation — all uncommitted, still holding the row lock.
      const winner = parkedTransactionOn(first, s.ctx, () =>
        settleWhole(winnerPayment, s.ctx, invoice.uuid),
      );
      expect(await winner.parked).toHaveLength(1);

      const loser = transactionOn(second, s.ctx, () =>
        settleWhole(loserPayment, s.ctx, invoice.uuid),
      );
      await delay(CONTENTION_WAIT_MS);

      // **The mechanism, asserted.** The loser is blocked on the invoice's row
      // lock, which it takes before it has read a single allocation — so it cannot
      // have decided anything from a stale sum. Without the lock it would read its
      // own snapshot, see 100.00 outstanding, and insert.
      expect(loser.hasSettled()).toBe(false);

      // And nothing is visible from outside until the winner commits.
      expect(await outstandingOf(db.app, 'invoice', invoice.id)).toBe(10000n);

      winner.commit();
      await winner.promise;

      // The loser's locking read is a *current* read, so once the winner commits it
      // sees the winner's allocation and recomputes: nothing is outstanding.
      const error = await loser.promise.then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      expect(toWireError(error)).toMatchObject({
        code: 'precondition_failed',
        details: { precondition: 'document_over_allocated' },
      });

      expect(await outstandingOf(db.app, 'invoice', invoice.id)).toBe(0n);
      expect(await readLedgerState(db.app, s.orgId)).toMatchObject({
        // One allocation, not two. The second payment is untouched and its money is
        // still available as credit on the contact (D-37) — which is the right
        // outcome, and the reason refusing is not a loss.
        arAllocations: 1,
        payments: 2,
      });
    } finally {
      await first.close();
      await second.close();
    }
  });

  /**
   * Two allocations to *different* invoices both apply — and the measurement that
   * goes with it, which is the price of the current read above.
   *
   * The second one does not proceed while the first is parked. That is not the
   * document row lock, which is a primary-key equality and takes no gap: it is the
   * `FOR SHARE` sum in `allocatedToDocument`, which is an equality range on a
   * **non-unique** index and therefore takes a next-key lock. While the allocation
   * tables are nearly empty that gap covers most of the index, so an insert for any
   * other document waits.
   *
   * Written as an outcome assertion rather than a timing one on purpose. The
   * serialization is a consequence of InnoDB's locking rules and of how little data
   * there is, not a guarantee this module makes, and pinning it would turn a
   * measurement into a contract that a fuller table would break. What must hold, and
   * is asserted, is that both allocations apply and neither is lost.
   */
  it('applies allocations to different documents, one after the other', async () => {
    const first = await db.openAppConnection();
    const second = await db.openAppConnection();

    try {
      const other = await documentIn(db, s, 'invoice', { amountMinor: 10000n });
      const onePayment = await receiptOn(first, s.ctx);
      const twoPayment = await receiptOn(second, s.ctx);

      const parked = parkedTransactionOn(first, s.ctx, () =>
        settleWhole(onePayment, s.ctx, invoice.uuid),
      );
      await parked.parked;

      const concurrent = transactionOn(second, s.ctx, () =>
        settleWhole(twoPayment, s.ctx, other.uuid),
      );

      parked.commit();
      await parked.promise;

      await expect(concurrent.promise).resolves.toHaveLength(1);

      expect(await outstandingOf(db.app, 'invoice', invoice.id)).toBe(0n);
      expect(await outstandingOf(db.app, 'invoice', other.id)).toBe(0n);
      expect(await readLedgerState(db.app, s.orgId)).toMatchObject({ arAllocations: 2 });
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('rolls the allocation back with the transaction that failed after it', async () => {
    const connection = await db.openAppConnection();

    try {
      const paymentId = await receiptOn(connection, s.ctx);

      const attempt = parkedTransactionOn(connection, s.ctx, () =>
        settleWhole(paymentId, s.ctx, invoice.uuid),
      );
      await attempt.parked;

      expect(await outstandingOf(db.app, 'invoice', invoice.id)).toBe(10000n);

      // A failure downstream of the allocation — an idempotency claim is the real
      // one — aborts the transaction.
      attempt.rollback(new Error('downstream failure after the allocation'));
      await expect(attempt.promise).rejects.toThrow('downstream failure');

      expect(await outstandingOf(db.app, 'invoice', invoice.id)).toBe(10000n);
      expect(await readLedgerState(db.app, s.orgId)).toMatchObject({ arAllocations: 0 });
    } finally {
      await connection.close();
    }
  });
});
