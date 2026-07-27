import type { CreateBillRequest } from '@openbooks/shared-types';
import { beforeEach, describe, expect, it } from 'vitest';

import { toWireError } from '../../src/errors';
import { approveBill, createBill, getBill } from '../../src/modules/bills';
import { useTestDatabase } from '../db';
import type { ApScene } from './support';
import {
  CONTENTION_WAIT_MS,
  connectionId,
  delay,
  parkedTransactionOn,
  readApLedgerState,
  sceneIn,
  transactionOn,
} from './support';

/**
 * Approval's two guarantees, proved rather than assumed.
 *
 *  1. **Numbering a document and posting its journal are one transaction.** A
 *     failure anywhere leaves no number and no journal, and a success makes both
 *     visible at the same instant.
 *  2. **Two callers approving one bill produce one journal and one number.**
 *
 * Neither is provable sequentially. A test that approves, checks, and approves
 * again passes against an implementation that uses two transactions and no lock at
 * all — the failure it is meant to catch is a crash *between* them and a second
 * caller arriving *during* them, and neither window exists unless two transactions
 * are open at once. So every case here runs on two `openAppConnection()` handles,
 * asserted distinct, with one side parked mid-transaction while the other is
 * observed failing to settle.
 *
 * The process pool is deliberately left uninitialized (`useTestDatabase`, not
 * `useServiceDatabase`): with no pool, a query that escaped the ambient
 * transaction throws rather than quietly running on a third connection, where it
 * would see neither side's uncommitted state and the race would appear to pass
 * having proved nothing. `db.app` is that third connection, used only to
 * *observe*.
 */
const db = useTestDatabase();

let s: ApScene;

beforeEach(async () => {
  s = await sceneIn(db);
});

function billRequest(reference?: string): CreateBillRequest {
  return {
    contactId: s.vendorUuid,
    issueDate: s.date,
    dueDate: '2026-02-15',
    taxMode: 'exclusive',
    ...(reference === undefined ? {} : { reference }),
    lines: [
      {
        description: 'Paper',
        quantity: '1',
        unitAmount: '150000',
        accountId: s.expenseUuid,
        taxRateId: s.taxRateUuid,
      },
    ],
  };
}

describe('two callers approving the same bill', () => {
  it('serialize on the document row and produce one journal and one number', async () => {
    const first = await db.openAppConnection();
    const second = await db.openAppConnection();

    try {
      expect(await connectionId(first.db)).not.toBe(await connectionId(second.db));

      const created = await transactionOn(first, s.ctx, () => createBill(billRequest(), s.ctx))
        .promise;

      // The winner has numbered the bill and posted its journal, uncommitted, and
      // holds the document's row lock and the bill counter's.
      const winner = parkedTransactionOn(first, s.ctx, () => approveBill(created.id, s.ctx));
      expect((await winner.parked).documentNumber).toBe('1');

      const loser = transactionOn(second, s.ctx, () => approveBill(created.id, s.ctx));
      await delay(CONTENTION_WAIT_MS);

      // The mechanism, asserted: `approveDocument` claims the bill counter as its
      // first statement and reads the document `FOR UPDATE` as its second, so the
      // loser is blocked before it has read anything about the document. Without
      // those locks it would price a document that is about to be approved and
      // post a second journal from it — and both would commit, because nothing
      // else on the path is shared between two documents with the same date.
      expect(loser.hasSettled()).toBe(false);

      // Nothing is visible from outside until the winner commits, which is the
      // other half of "one transaction": the number and the journal become visible
      // together or not at all.
      expect(await readApLedgerState(db.app, s.orgId)).toMatchObject({
        documents: 1,
        documentNumbers: [],
        journals: 0,
      });

      winner.commit();
      await winner.promise;

      // The loser's read of the document is a locking one and therefore a
      // *current* read, so once the winner commits it sees `journal_id` set and
      // reports the refusal a second approval gets. A consistent read would not
      // have — which is the bug this suite found in the duplicate-reference check
      // below.
      const error = await loser.promise.then(
        () => undefined,
        (thrown: unknown) => toWireError(thrown),
      );
      expect(error).toMatchObject({
        code: 'precondition_failed',
        details: { precondition: 'document_already_approved' },
      });

      expect(await readApLedgerState(db.app, s.orgId)).toMatchObject({
        documents: 1,
        // One document number consumed, not two, and one journal number: the loser
        // never reached either counter.
        documentNumbers: ['1'],
        journals: 1,
        journalSequenceNumbers: ['1'],
        journalLines: 3,
      });
    } finally {
      await first.close();
      await second.close();
    }
  });
});

describe('two callers approving different bills', () => {
  it('serialize on the bill counter and issue consecutive numbers with no gap', async () => {
    const first = await db.openAppConnection();
    const second = await db.openAppConnection();

    try {
      const a = await transactionOn(first, s.ctx, () => createBill(billRequest('A'), s.ctx))
        .promise;
      const b = await transactionOn(first, s.ctx, () => createBill(billRequest('B'), s.ctx))
        .promise;

      const winner = parkedTransactionOn(first, s.ctx, () => approveBill(a.id, s.ctx));
      await winner.parked;

      // Different document rows, so the document lock does not serialize these.
      // The bill counter row does, and it is claimed *before* the document row
      // precisely so this case cannot deadlock against the one above — see
      // `approveDocument`'s lock order. It is also what makes the series gapless
      // and what puts the duplicate-reference check inside a serialized region.
      const other = transactionOn(second, s.ctx, () => approveBill(b.id, s.ctx));
      await delay(CONTENTION_WAIT_MS);
      expect(other.hasSettled()).toBe(false);

      winner.commit();
      await winner.promise;
      const approvedB = await other.promise;

      expect(approvedB.documentNumber).toBe('2');
      expect(await readApLedgerState(db.app, s.orgId)).toMatchObject({
        documentNumbers: ['1', '2'],
        journalSequenceNumbers: ['1', '2'],
      });
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('refuses the second of two identical vendor references under contention', async () => {
    const first = await db.openAppConnection();
    const second = await db.openAppConnection();

    try {
      const a = await transactionOn(first, s.ctx, () => createBill(billRequest('INV-1001'), s.ctx))
        .promise;
      const b = await transactionOn(first, s.ctx, () => createBill(billRequest('INV-1001'), s.ctx))
        .promise;

      const winner = parkedTransactionOn(first, s.ctx, () => approveBill(a.id, s.ctx));
      await winner.parked;

      const loser = transactionOn(second, s.ctx, async () => {
        // A consistent read taken before the approval, and it is not a
        // contrivance: `withIdempotency(spec, () => approveBill(id))` reads
        // `idempotency_keys` first, and a transport handler that fetches before
        // it acts does the same. What it does is establish this transaction's
        // **read view** before the winner commits — which is precisely the
        // condition under which the duplicate check must be a current read.
        await getBill(b.id, s.ctx);
        return approveBill(b.id, s.ctx);
      });
      await delay(CONTENTION_WAIT_MS);

      // The case that caught the real bug. At this instant the winner's bill is
      // uncommitted and the loser is blocked at the counter. When it resumes, its
      // read view predates the winner's commit — so the duplicate check has to be
      // a *current* read (`FOR UPDATE`) and not a consistent one. With a plain
      // `SELECT` the loser sees nothing, approves, and two bills carry one vendor
      // invoice number. Every sequential duplicate test passed while that was
      // true, which is the whole of "prove contention, don't assume it".
      expect(loser.hasSettled()).toBe(false);

      winner.commit();
      await winner.promise;

      expect(
        await loser.promise.then(
          () => undefined,
          (thrown: unknown) => toWireError(thrown),
        ),
      ).toMatchObject({ details: { precondition: 'duplicate_vendor_reference' } });

      expect(await readApLedgerState(db.app, s.orgId)).toMatchObject({
        documentNumbers: ['1'],
        journals: 1,
      });
    } finally {
      await first.close();
      await second.close();
    }
  });
});

describe('the numbering and the posting are one transaction', () => {
  it('rolls the journal back with the number when the transaction fails', async () => {
    const connection = await db.openAppConnection();

    try {
      const created = await transactionOn(connection, s.ctx, () => createBill(billRequest(), s.ctx))
        .promise;

      const attempt = parkedTransactionOn(connection, s.ctx, () => approveBill(created.id, s.ctx));
      await attempt.parked;

      // A real downstream failure after a successful approval — an idempotency
      // write, a later step in the same request. The transaction is the unit, so
      // it takes both the number and the journal with it.
      attempt.rollback(new Error('downstream failure'));
      await expect(attempt.promise).rejects.toThrow('downstream failure');

      expect(await readApLedgerState(db.app, s.orgId)).toMatchObject({
        documents: 1,
        documentNumbers: [],
        journals: 0,
        journalLines: 0,
      });
    } finally {
      await connection.close();
    }
  });
});
