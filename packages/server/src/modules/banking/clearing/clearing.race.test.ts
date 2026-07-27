import { afterEach, describe, expect, it } from 'vitest';

import { toWireError } from '../../../errors';
import type { AppConnection, TestDatabase } from '../../../../test/db';
import { useTestDatabase } from '../../../../test/db';
import {
  CONTENTION_WAIT_MS,
  delay,
  parkedTransactionOn,
  transactionOn,
} from '../../../../test/payments/support';
import {
  bankJournalIn,
  sceneIn,
  statementLineIn,
  type Scene,
} from '../../../../test/banking/clearing-support';

import { clearBankStatementLine } from './clearing.service';

/**
 * Two clearings racing the same line, and the same entry (OB-081; acceptance E3).
 *
 * Neither the statement line nor the journal can be locked `FOR UPDATE` — both are
 * append-only, and the app user holds no `UPDATE`/`DELETE` to take a locking read with
 * (D-14). So the serialization is `uq_blc_line` and `uq_blc_journal` on insert, and
 * this suite proves it with two real connections: one parks mid-transaction holding the
 * key, the second blocks on it and *has not settled*, and only when the first commits
 * does the second learn it lost — with the precondition a client can branch on, not an
 * opaque error. A sequential simulation would pass against code with no key at all,
 * which is exactly why this uses `openAppConnection` twice (spec §11).
 *
 * `link_entry` with no difference posts nothing, so the only contention is the clearing
 * insert — the race is on the key, not on the journal sequence a fresh posting would
 * also take.
 */

// `useTestDatabase` alone, no process pool: a query that escaped the ambient
// transaction would throw rather than run on a third connection and prove nothing.
const db: TestDatabase = useTestDatabase();

const opened: AppConnection[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((connection) => connection.close()));
});

async function connection(): Promise<AppConnection> {
  const conn = await db.openAppConnection();
  opened.push(conn);
  return conn;
}

describe('two clearings on the same journal', () => {
  it('serializes on uq_blc_journal, and the loser is journal_already_cleared', async () => {
    const scene: Scene = await sceneIn(db);
    const journal = await bankJournalIn(db, scene, 5000n, scene.revenue);
    const first = await statementLineIn(db, scene, { amountMinor: 5000n });
    const second = await statementLineIn(db, scene, { amountMinor: 5000n });

    const connA = await connection();
    const connB = await connection();

    const winner = parkedTransactionOn(connA, scene.ctx, () =>
      clearBankStatementLine(
        first.uuid,
        { method: 'link_entry', journalId: journal.uuid },
        scene.ctx,
      ),
    );
    // Wait until it has inserted and is parked, holding the unique key.
    await winner.parked;

    const loser = transactionOn(connB, scene.ctx, () =>
      clearBankStatementLine(
        second.uuid,
        { method: 'link_entry', journalId: journal.uuid },
        scene.ctx,
      ),
    );

    await delay(CONTENTION_WAIT_MS);
    // The contention probe: blocked on the key, it cannot have settled.
    expect(loser.hasSettled()).toBe(false);

    winner.commit();
    await winner.promise;

    const error = await loser.promise.then(
      () => {
        throw new Error('the second clearing should have been refused');
      },
      (e: unknown) => e,
    );
    expect(toWireError(error)).toMatchObject({
      details: { precondition: 'journal_already_cleared' },
    });
  });
});

describe('two clearings on the same line', () => {
  it('serializes on uq_blc_line, and the loser is statement_line_already_cleared', async () => {
    const scene: Scene = await sceneIn(db);
    const journalA = await bankJournalIn(db, scene, 5000n, scene.revenue);
    const journalB = await bankJournalIn(db, scene, 5000n, scene.revenue);
    const line = await statementLineIn(db, scene, { amountMinor: 5000n });

    const connA = await connection();
    const connB = await connection();

    const winner = parkedTransactionOn(connA, scene.ctx, () =>
      clearBankStatementLine(
        line.uuid,
        { method: 'link_entry', journalId: journalA.uuid },
        scene.ctx,
      ),
    );
    await winner.parked;

    const loser = transactionOn(connB, scene.ctx, () =>
      clearBankStatementLine(
        line.uuid,
        { method: 'link_entry', journalId: journalB.uuid },
        scene.ctx,
      ),
    );

    await delay(CONTENTION_WAIT_MS);
    expect(loser.hasSettled()).toBe(false);

    winner.commit();
    await winner.promise;

    const error = await loser.promise.then(
      () => {
        throw new Error('the second clearing should have been refused');
      },
      (e: unknown) => e,
    );
    expect(toWireError(error)).toMatchObject({
      details: { precondition: 'statement_line_already_cleared' },
    });
  });
});
