import { beforeEach, describe, expect, it } from 'vitest';

import type { RequestContext } from '../../src/context';
import { toWireError } from '../../src/errors';
import { createDraft, discardDraft, getDraft, postDraft } from '../../src/modules/drafts';
import { OWNER_ROLE_ID } from '../../src/modules/orgs';
import { useTestDatabase } from '../db';
import {
  CONTENTION_WAIT_MS,
  connectionId,
  contextFor,
  delay,
  parkedTransactionOn,
  readDraftLedgerState,
  transactionOn,
} from './support';

/**
 * D-19's guarantee, proved rather than assumed: **posting a draft and discarding
 * it are one transaction**, and two callers posting one draft produce one journal.
 *
 * Neither claim is provable sequentially. A test that posts, then checks, then
 * posts again passes against an implementation that uses two transactions and no
 * lock at all — the failure it is meant to catch is a crash *between* them and a
 * second caller arriving *during* them, and neither window exists unless two
 * transactions are open at once. So every case here runs on two
 * `openAppConnection()` handles, asserted distinct, with one side parked
 * mid-transaction while the other is observed failing to settle.
 *
 * The process pool is deliberately left uninitialized (`useTestDatabase`, not
 * `useServiceDatabase`): with no pool, a query that escaped the ambient
 * transaction throws rather than quietly running on a third connection, where it
 * would see neither side's uncommitted state and the race would appear to pass
 * having proved nothing.
 *
 * `db.app` is that third connection, used only to *observe* — an uncommitted row
 * read from one of the racing connections is not evidence of anything.
 */
const db = useTestDatabase();

interface Scene {
  readonly ctx: RequestContext;
  readonly orgId: Buffer;
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
    date: ledger.period.startDate,
    debit: ledger.debitAccount.uuid,
    credit: ledger.creditAccount.uuid,
  };
});

/** A complete, postable draft, created on `connection` and committed. */
async function draftOn(
  connection: Awaited<ReturnType<typeof db.openAppConnection>>,
): Promise<string> {
  const draft = await transactionOn(connection, s.ctx, () =>
    createDraft({
      entryDate: s.date,
      memo: 'Rent',
      lines: [
        { accountId: s.debit, side: 'debit', amount: '150000' },
        { accountId: s.credit, side: 'credit', amount: '150000' },
      ],
    }),
  ).promise;

  return draft.id;
}

describe('two callers posting the same draft', () => {
  it('serialize on the draft row and produce exactly one journal', async () => {
    const first = await db.openAppConnection();
    const second = await db.openAppConnection();

    try {
      expect(await connectionId(first.db)).not.toBe(await connectionId(second.db));
      const draftId = await draftOn(first);

      // The winner has posted and deleted the draft, uncommitted, and holds the
      // draft's row lock.
      const winner = parkedTransactionOn(first, s.ctx, () => postDraft(draftId));
      expect((await winner.parked).lines).toHaveLength(2);

      const loser = transactionOn(second, s.ctx, () => postDraft(draftId));
      await delay(CONTENTION_WAIT_MS);

      // The mechanism, asserted: `postDraft` reads the draft `FOR UPDATE` as its
      // first statement, so the loser is blocked *before* it has read the draft's
      // lines. Without that lock it would read a draft that is about to be deleted
      // and post a second journal from it — and both would commit, because nothing
      // else in the posting path is shared between two entries with the same date.
      expect(loser.hasSettled()).toBe(false);

      // Nothing is visible from outside until the winner commits, which is the
      // other half of "one transaction": the journal and the draft's deletion
      // become visible together or not at all.
      expect(await readDraftLedgerState(db.app, s.orgId)).toMatchObject({
        drafts: 1,
        journals: 0,
      });

      winner.commit();
      await winner.promise;

      // The loser's locking read is a *current* read, so once the winner commits it
      // sees the row is gone and reports the miss a second post of any draft gets.
      const error = await loser.promise.then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      expect(toWireError(error)).toMatchObject({ code: 'not_found', status: 404 });

      expect(await readDraftLedgerState(db.app, s.orgId)).toEqual({
        drafts: 0,
        draftLines: 0,
        draftTags: 0,
        journals: 1,
        journalLines: 2,
        // One number consumed, not two: the loser never reached the counter.
        sequenceNumbers: ['1'],
      });
    } finally {
      await first.close();
      await second.close();
    }
  });
});

describe('the post and the discard are one transaction (D-19)', () => {
  it('rolls back the journal with the draft when the transaction fails', async () => {
    const connection = await db.openAppConnection();

    try {
      const draftId = await draftOn(connection);

      // Parked *after* `postDraft` returned: the journal is written, the draft is
      // deleted, and neither is committed. This is exactly the window a crash
      // between two transactions would fall into.
      const attempt = parkedTransactionOn(connection, s.ctx, () => postDraft(draftId));
      await attempt.parked;

      expect(await readDraftLedgerState(db.app, s.orgId)).toMatchObject({
        drafts: 1,
        journals: 0,
      });

      // A failure downstream of the posting — a failing idempotency claim is the
      // real one — aborts the transaction.
      attempt.rollback(new Error('downstream failure after the posting'));
      await expect(attempt.promise).rejects.toThrow('downstream failure');

      // Both halves are undone. With two transactions this is the state that could
      // not exist: the journal would be committed and the draft would be gone, or
      // the journal would be committed and the draft would still be there — and a
      // user seeing the draft would post it again.
      expect(await readDraftLedgerState(db.app, s.orgId)).toEqual({
        drafts: 1,
        draftLines: 2,
        draftTags: 0,
        journals: 0,
        journalLines: 0,
        sequenceNumbers: [],
      });

      // And the draft is still postable, from a fresh transaction.
      const posted = await transactionOn(connection, s.ctx, () => postDraft(draftId)).promise;
      expect(posted.lines).toHaveLength(2);
      expect(await readDraftLedgerState(db.app, s.orgId)).toMatchObject({
        drafts: 0,
        journals: 1,
      });
    } finally {
      await connection.close();
    }
  });

  it('holds the draft against a concurrent discard until the post settles', async () => {
    const first = await db.openAppConnection();
    const second = await db.openAppConnection();

    try {
      const draftId = await draftOn(first);

      const posting = parkedTransactionOn(first, s.ctx, () => postDraft(draftId));
      await posting.parked;

      const discard = transactionOn(second, s.ctx, () => discardDraft(draftId));
      await delay(CONTENTION_WAIT_MS);

      // The discard's own `DELETE` needs the row's exclusive lock, which the post
      // holds. Without the post's lock the discard would remove a draft whose
      // journal is about to be committed — harmless — or, in the other order,
      // succeed and let the post commit a journal for a draft the user had just
      // deleted, which is not.
      expect(discard.hasSettled()).toBe(false);

      posting.commit();
      await posting.promise;

      // The draft is gone because it was posted, so the discard finds nothing.
      const error = await discard.promise.then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      expect(toWireError(error)).toMatchObject({ code: 'not_found', status: 404 });

      expect(await readDraftLedgerState(db.app, s.orgId)).toMatchObject({
        drafts: 0,
        journals: 1,
        journalLines: 2,
      });
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('leaves the draft readable and unchanged after a refused post', async () => {
    const connection = await db.openAppConnection();

    try {
      // Unbalanced: `postJournal` refuses it, and the refusal must not take the
      // draft with it.
      const draft = await transactionOn(connection, s.ctx, () =>
        createDraft({
          entryDate: s.date,
          lines: [
            { accountId: s.debit, side: 'debit', amount: '100' },
            { accountId: s.credit, side: 'credit', amount: '250' },
          ],
        }),
      ).promise;

      const attempt = transactionOn(connection, s.ctx, () => postDraft(draft.id));
      await expect(attempt.promise).rejects.toMatchObject({ code: 'validation_failed' });

      const survived = await transactionOn(connection, s.ctx, () => getDraft(draft.id)).promise;
      expect(survived.lines).toHaveLength(2);
      expect(await readDraftLedgerState(db.app, s.orgId)).toMatchObject({
        drafts: 1,
        draftLines: 2,
        journals: 0,
        sequenceNumbers: [],
      });
    } finally {
      await connection.close();
    }
  });
});
