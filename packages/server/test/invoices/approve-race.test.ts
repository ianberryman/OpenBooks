import { beforeEach, describe, expect, it } from 'vitest';

import { toWireError } from '../../src/errors';
import {
  approveInvoice,
  createInvoice,
  discardInvoice,
  getInvoice,
  updateInvoice,
} from '../../src/modules/invoices';
import { useTestDatabase } from '../db';
import type { Scene } from './support';
import {
  CONTENTION_WAIT_MS,
  connectionId,
  delay,
  parkedTransactionOn,
  readArState,
  scene,
  transactionOn,
} from './support';

/**
 * D-38's guarantee, proved rather than assumed: **approving a document allocates
 * its number, posts its journal, and records both in one transaction**, and two
 * callers approving one document produce one journal and one number.
 *
 * Neither claim is provable sequentially. A test that approves, then checks, then
 * approves again passes against an implementation that uses two transactions and no
 * lock at all — the failure it is meant to catch is a crash *between* them and a
 * second caller arriving *during* them, and neither window exists unless two
 * transactions are open at once. So every case here runs on two
 * `openAppConnection()` handles, asserted distinct, with one side parked
 * mid-transaction while the other is observed failing to settle.
 *
 * The process pool is deliberately left uninitialized (`useTestDatabase`, not
 * `useServiceDatabase`): with no pool, a query that escaped the ambient transaction
 * throws rather than quietly running on a third connection, where it would see
 * neither side's uncommitted state and the race would appear to pass having proved
 * nothing.
 *
 * `db.app` is that third connection, used only to *observe* — an uncommitted row
 * read from one of the racing connections is not evidence of anything.
 */
const db = useTestDatabase();

let s: Scene;

beforeEach(async () => {
  s = await scene(db);
});

/** A complete, approvable draft, created on `connection` and committed. */
async function draftOn(
  connection: Awaited<ReturnType<typeof db.openAppConnection>>,
): Promise<string> {
  const invoice = await transactionOn(connection, s.actor.ctx, () =>
    createInvoice({
      contactId: s.contact,
      issueDate: s.date,
      taxMode: 'exclusive',
      lines: [
        {
          description: 'Consulting',
          quantity: '2',
          unitAmount: '10000',
          accountId: s.income,
          taxRateId: s.vat,
        },
      ],
    }),
  ).promise;

  return invoice.id;
}

describe('two callers approving the same invoice', () => {
  it('serialize on the document row and produce one journal and one number', async () => {
    const first = await db.openAppConnection();
    const second = await db.openAppConnection();

    try {
      expect(await connectionId(first.db)).not.toBe(await connectionId(second.db));
      const invoiceId = await draftOn(first);

      // The winner has taken the number, posted the journal and recorded both,
      // uncommitted, and holds the document's row lock.
      const winner = parkedTransactionOn(first, s.actor.ctx, () => approveInvoice(invoiceId));
      expect((await winner.parked).documentNumber).toBe('1');

      const loser = transactionOn(second, s.actor.ctx, () => approveInvoice(invoiceId));
      await delay(CONTENTION_WAIT_MS);

      // The mechanism, asserted: `approveArDocument` reads the document `FOR UPDATE`
      // as its first statement, so the loser is blocked *before* it has read the
      // lines, taken a number, or reached the period. Without that lock it would
      // read a draft that is about to be approved and post a second journal for the
      // same invoice — and both would commit, because nothing else in the posting
      // path is shared between two entries with the same date.
      expect(loser.hasSettled()).toBe(false);

      // Nothing is visible from outside until the winner commits, which is the other
      // half of "one transaction": the number, the journal and the document's record
      // of them become visible together or not at all.
      expect(await readArState(db.app, s.actor.orgId)).toMatchObject({
        documents: 1,
        journals: 0,
        documentNumbers: [],
        nextInvoiceNumber: null,
      });

      winner.commit();
      await winner.promise;

      // The loser's locking read is a *current* read, so once the winner commits it
      // sees a document that already carries a journal and refuses.
      const error = await loser.promise.then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      expect(toWireError(error)).toMatchObject({
        code: 'precondition_failed',
        status: 412,
        details: { precondition: 'document_already_approved' },
      });

      const state = await readArState(db.app, s.actor.orgId);
      expect(state).toMatchObject({
        documents: 1,
        journals: 1,
        journalLines: 3,
        documentNumbers: ['1'],
        // One number consumed, not two: the loser never reached the counter.
        nextInvoiceNumber: '2',
      });
      expect(state.journalIds).toHaveLength(1);
    } finally {
      await first.close();
      await second.close();
    }
  });
});

describe('the number, the posting and the record are one transaction (D-38)', () => {
  it('rolls the journal and the number back together when the transaction fails', async () => {
    const connection = await db.openAppConnection();

    try {
      const invoiceId = await draftOn(connection);

      // Parked *after* `approveInvoice` returned: the number is taken, the journal is
      // written, the document records both, and none of it is committed. This is
      // exactly the window a crash between two transactions would fall into.
      const attempt = parkedTransactionOn(connection, s.actor.ctx, () => approveInvoice(invoiceId));
      await attempt.parked;

      expect(await readArState(db.app, s.actor.orgId)).toMatchObject({
        journals: 0,
        documentNumbers: [],
      });

      // A failure downstream of the approval — a failing idempotency claim is the
      // real one — aborts the transaction.
      attempt.rollback(new Error('downstream failure after the approval'));
      await expect(attempt.promise).rejects.toThrow('downstream failure');

      // Every part is undone. With two transactions this is the state that could not
      // exist: a journal with no document pointing at it, or a document holding a
      // number for a journal that was never posted — which
      // `chk_ar_documents_approved` makes unrepresentable and which this makes
      // unreachable.
      expect(await readArState(db.app, s.actor.orgId)).toMatchObject({
        documents: 1,
        documentLines: 1,
        journals: 0,
        journalLines: 0,
        documentNumbers: [],
        journalIds: [],
        // The counter went back too, so the next approval takes 1 and the series has
        // no gap (D-36).
        nextInvoiceNumber: null,
      });

      // And the draft is still approvable, from a fresh transaction.
      const approved = await transactionOn(connection, s.actor.ctx, () => approveInvoice(invoiceId))
        .promise;
      expect(approved.documentNumber).toBe('1');
    } finally {
      await connection.close();
    }
  });

  it('holds the document against a concurrent discard until the approval settles', async () => {
    const first = await db.openAppConnection();
    const second = await db.openAppConnection();

    try {
      const invoiceId = await draftOn(first);

      const approving = parkedTransactionOn(first, s.actor.ctx, () => approveInvoice(invoiceId));
      await approving.parked;

      const discard = transactionOn(second, s.actor.ctx, () => discardInvoice(invoiceId));
      await delay(CONTENTION_WAIT_MS);

      // The discard needs the row's exclusive lock, which the approval holds.
      // Without it the discard would delete a document whose journal is about to be
      // committed, leaving a posted journal that no document accounts for — and the
      // number it consumed unexplainable.
      expect(discard.hasSettled()).toBe(false);

      approving.commit();
      await approving.promise;

      const error = await discard.promise.then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      expect(toWireError(error)).toMatchObject({
        code: 'precondition_failed',
        details: { precondition: 'document_approved' },
      });

      expect(await readArState(db.app, s.actor.orgId)).toMatchObject({
        documents: 1,
        journals: 1,
        documentNumbers: ['1'],
      });
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('holds the document against a concurrent edit, so no line escapes the posting', async () => {
    const first = await db.openAppConnection();
    const second = await db.openAppConnection();

    try {
      const invoiceId = await draftOn(first);

      const approving = parkedTransactionOn(first, s.actor.ctx, () => approveInvoice(invoiceId));
      await approving.parked;

      const edit = transactionOn(second, s.actor.ctx, () =>
        updateInvoice(invoiceId, {
          lines: [
            {
              description: 'Consulting',
              quantity: '3',
              unitAmount: '10000',
              accountId: s.income,
              taxRateId: s.vat,
            },
          ],
        }),
      );
      await delay(CONTENTION_WAIT_MS);

      // Without the lock, this line would be written after the approval read the
      // lines it posted from: the invoice would say £300 and the ledger £200, and
      // the ledger cannot be corrected by an edit.
      expect(edit.hasSettled()).toBe(false);

      approving.commit();
      await approving.promise;

      expect(toWireError(await edit.promise.catch((error: unknown) => error))).toMatchObject({
        code: 'precondition_failed',
        details: { precondition: 'document_approved' },
      });
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('leaves the document readable and unapproved after a refused approval', async () => {
    const connection = await db.openAppConnection();

    try {
      // Outside every fiscal period: `postJournal` refuses it, and the refusal must
      // not take the document or its number with it.
      const invoice = await transactionOn(connection, s.actor.ctx, () =>
        createInvoice({
          contactId: s.contact,
          issueDate: '2025-06-01',
          taxMode: 'exclusive',
          lines: [
            {
              description: 'Consulting',
              quantity: '1',
              unitAmount: '10000',
              accountId: s.income,
              taxRateId: s.vat,
            },
          ],
        }),
      ).promise;

      const attempt = transactionOn(connection, s.actor.ctx, () => approveInvoice(invoice.id));
      await expect(attempt.promise).rejects.toMatchObject({ code: 'precondition_failed' });

      const survived = await transactionOn(connection, s.actor.ctx, () => getInvoice(invoice.id))
        .promise;
      expect(survived).toMatchObject({ status: 'draft', documentNumber: null, journalId: null });
      expect(await readArState(db.app, s.actor.orgId)).toMatchObject({
        documents: 1,
        journals: 0,
        nextInvoiceNumber: null,
      });
    } finally {
      await connection.close();
    }
  });
});
