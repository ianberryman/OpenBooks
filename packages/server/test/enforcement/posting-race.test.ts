import { beforeEach, describe, expect, it } from 'vitest';

import type { RequestContext } from '../../src/context';
import { toWireError } from '../../src/errors';
import { postJournal, reverseJournal } from '../../src/modules/ledger';
import { OWNER_ROLE_ID } from '../../src/modules/orgs';
import { useTestDatabase } from '../db';
import {
  CONTENTION_WAIT_MS,
  connectionId,
  contextFor,
  delay,
  parkedTransactionOn,
  readLedgerState,
  transactionOn,
} from './support';

/**
 * Concurrency in the posting path beyond A9: the two other places where two callers
 * contend over one row and the ledger's guarantees are what is at stake.
 *
 * Both are claims the sequential suites cannot make. `test/ledger/posting.test.ts`
 * proves sequence numbers are gapless and monotonic when postings are made one after
 * another, and that a second reversal of an already-reversed journal is refused. Under
 * concurrency the mechanism is different in each case — a `FOR UPDATE` claim on
 * `journal_sequences` for the first, a unique index for the second — and neither is
 * exercised at all by serial calls.
 *
 * As in `./period-lock-race.test.ts`, the losing side is observed *failing to settle*
 * across `CONTENTION_WAIT_MS` before anything else is asserted, and the process-wide
 * pool is deliberately left uninitialized so no query can quietly escape onto a third
 * connection. See `./support.ts`.
 */
const db = useTestDatabase();

interface Scene {
  readonly ctx: RequestContext;
  readonly orgId: Buffer;
  /** Two non-overlapping open periods in the same org. See `two posters`. */
  readonly firstDate: string;
  readonly secondDate: string;
  readonly debit: string;
  readonly credit: string;
}

let s: Scene;

beforeEach(async () => {
  const ledger = await db.factories.ledger();
  // The `ledger` fixture's period covers the whole of 2026; the second is 2027, which
  // keeps the periods non-overlapping (`assertPostable` treats two covering periods as
  // a broken invariant, not as a choice).
  const second = await db.factories.fiscalPeriod({
    orgId: ledger.org.id,
    name: 'FY2027',
    startDate: '2027-01-01',
    endDate: '2027-12-31',
  });

  s = {
    ctx: contextFor(ledger.org.uuid, OWNER_ROLE_ID, ledger.user.uuid),
    orgId: ledger.org.id,
    firstDate: ledger.period.startDate,
    secondDate: second.startDate,
    debit: ledger.debitAccount.uuid,
    credit: ledger.creditAccount.uuid,
  };
});

function balanced(date: string): Parameters<typeof postJournal>[0] {
  const amount = 42_00n;
  return {
    date,
    memo: `Posting dated ${date}`,
    actorType: 'user' as const,
    actorId: s.ctx.actorId,
    lines: [
      { accountId: s.debit, side: 'debit' as const, amount },
      { accountId: s.credit, side: 'credit' as const, amount },
    ],
  };
}

async function reversalCount(): Promise<number> {
  const row = await db.app
    .selectFrom('journals')
    .select(({ fn }) => fn.countAll<string>().as('count'))
    .where('org_id', '=', s.orgId)
    .where('reverses_journal_id', 'is not', null)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

describe('two posters racing the same org’s sequence counter (D-14)', () => {
  it('serialize on the counter and produce consecutive numbers with no duplicate', async () => {
    const first = await db.openAppConnection();
    const second = await db.openAppConnection();

    try {
      expect(await connectionId(first.db)).not.toBe(await connectionId(second.db));

      // The two postings are dated into *different* periods on purpose. With the same
      // period they would contend on the `fiscal_periods` row first and this would be
      // a second A9 test; different periods make `journal_sequences` the only shared
      // row, so the block observed below is unambiguously the counter's.
      const winner = parkedTransactionOn(first, s.ctx, () => postJournal(balanced(s.firstDate)));
      expect((await winner.parked).lines).toHaveLength(2);

      const loser = transactionOn(second, s.ctx, () => postJournal(balanced(s.secondDate)));
      await delay(CONTENTION_WAIT_MS);

      // `allocateSequenceNumber` reads the counter `FOR UPDATE` and the winner is
      // holding it. This is the cost D-14 accepts explicitly — "posting serializes per
      // org … a gap is indistinguishable from a deleted entry" — and it is asserted
      // rather than assumed, because a counter read without the lock would let both
      // postings take the same number and the unique key would reject one of them.
      expect(loser.hasSettled()).toBe(false);

      winner.commit();
      await winner.promise;
      await loser.promise;

      expect(await readLedgerState(db.app, s.orgId)).toEqual({
        journals: 2,
        lines: 4,
        headersWithoutLines: 0,
        orphanLines: 0,
        linesPerJournal: [2, 2],
        // Gapless, consecutive, and distinct, which is the whole of D-14's promise.
        sequenceNumbers: ['1', '2'],
        nextSequenceValue: '3',
      });
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('are backstopped by uq_journals_org_sequence rather than by the lock alone', async () => {
    // The lock above is what makes duplicates not happen; this is what makes them
    // impossible. Written through the factory's `sequenceNumber` override, which exists
    // for exactly this — no code path in the service can request a number, so the
    // constraint is otherwise unreachable from a test.
    const ledger = await db.factories.ledger();
    await db.factories.journal({
      orgId: ledger.org.id,
      periodId: ledger.period.id,
      sequenceNumber: 7n,
    });

    await expect(
      db.factories.journal({
        orgId: ledger.org.id,
        periodId: ledger.period.id,
        sequenceNumber: 7n,
      }),
    ).rejects.toMatchObject({ code: 'ER_DUP_ENTRY', errno: 1062 });
  });
});

describe('two concurrent reversals of the same journal', () => {
  it('yield exactly one reversal', async () => {
    const first = await db.openAppConnection();
    const second = await db.openAppConnection();

    try {
      expect(await connectionId(first.db)).not.toBe(await connectionId(second.db));

      const original = await transactionOn(first, s.ctx, () => postJournal(balanced(s.firstDate)))
        .promise;

      const request = {
        journalId: original.journalId,
        date: s.firstDate,
        actorType: 'user' as const,
        actorId: s.ctx.actorId,
      };

      // The winner has written its reversal, uncommitted, and holds the period row.
      const winner = parkedTransactionOn(first, s.ctx, () => reverseJournal(request));
      const reversal = await winner.parked;
      expect(reversal.reversesJournalId).toBe(original.journalId);

      const loser = transactionOn(second, s.ctx, () => reverseJournal(request));
      await delay(CONTENTION_WAIT_MS);

      // The loser has already asked whether a reversal exists and been told no — its
      // snapshot cannot see the winner's uncommitted row. That is the race
      // `posting.service.ts` names when it says the pre-check "races and the index does
      // not", and it is why the index has to exist.
      expect(loser.hasSettled()).toBe(false);

      winner.commit();
      await winner.promise;

      /**
       * The loser gets the same `conflict` a sequential second reversal gets.
       *
       * This test originally pinned a defect: the loser was refused by
       * `uq_journals_org_reverses` — the guarantee working — but refused as a raw
       * mysql2 `ER_DUP_ENTRY`, which `toWireError` does not recognise, so a client
       * that lost this race was told `internal_error` / 500 for a request the system
       * understood perfectly and refused on purpose.
       *
       * Only a real two-connection race could reach it. The sequential test in
       * `test/ledger/posting.test.ts` gets the correct `ConflictError` from the
       * pre-check, because by then the first reversal is committed and visible — so
       * the good path was covered and the bad path was not reachable without
       * contention.
       *
       * `reverseJournal` now translates the duplicate key to the same `ConflictError`
       * the pre-check would have produced, sharing one constructor so the two cannot
       * word the same condition differently.
       */
      const error = await loser.promise.then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      expect(toWireError(error)).toMatchObject({
        code: 'conflict',
        status: 409,
      });
      // The message must not leak the driver's text, which names the index and the
      // duplicated key bytes.
      expect(JSON.stringify(toWireError(error))).not.toContain('ER_DUP_ENTRY');
      expect(JSON.stringify(toWireError(error))).not.toContain('uq_journals');

      // The guarantee itself, which holds regardless of how the refusal was spelled:
      // one reversal, the original untouched, and a sequence with no gap left by the
      // rolled-back attempt.
      expect(await reversalCount()).toBe(1);
      expect(await readLedgerState(db.app, s.orgId)).toEqual({
        journals: 2,
        lines: 4,
        headersWithoutLines: 0,
        orphanLines: 0,
        linesPerJournal: [2, 2],
        sequenceNumbers: ['1', '2'],
        nextSequenceValue: '3',
      });
    } finally {
      await first.close();
      await second.close();
    }
  });
});
