import { afterEach, describe, expect, it } from 'vitest';

import { toWireError } from '../../../errors';
import type { AppConnection, TestDatabase } from '../../../../test/db';
import { newUuid, useTestDatabase, uuidToBuffer } from '../../../../test/db';
import {
  CONTENTION_WAIT_MS,
  delay,
  parkedTransactionOn,
  transactionOn,
} from '../../../../test/payments/support';
import { sceneIn, type Scene } from '../../../../test/banking/clearing-support';

import { finaliseReconciliationSession } from './reconciliation.service';

/**
 * Two people finalising one account, racing (OB-082; acceptance E5, and D-14).
 *
 * Neither the statement line nor the journal a session measures can be locked `FOR
 * UPDATE` — both are append-only, and MySQL grants a locking read only to an identity
 * that holds `UPDATE`/`DELETE` (D-14). So the serialization is the session row itself,
 * which `reconciliation_sessions` being mutable makes lockable: `finalise` takes it
 * `FOR UPDATE`, and this suite proves it with two real connections. One parks
 * mid-finalise holding the row; the second blocks on it and **has not settled**; only
 * when the first commits does the second learn the session is already finalised — with
 * the precondition a client can branch on, not an opaque error. A sequential simulation
 * would pass against code with no lock at all, which is why this uses `openAppConnection`
 * twice (spec §11).
 *
 * The session is built balanced and empty — no clearings, a zero statement balance — so
 * both finalisers would otherwise succeed and the only thing separating them is the lock.
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

/** An open, balanced session on the scene's account, inserted directly as the app user. */
async function openSessionIn(scene: Scene, endDate: string): Promise<string> {
  const uuid = newUuid();
  await db.app
    .insertInto('reconciliation_sessions')
    .values({
      id: uuidToBuffer(uuid),
      org_id: scene.orgId,
      bank_account_id: scene.bankAccountId,
      end_date: endDate,
      statement_closing_balance_minor: 0n,
      created_by_user_id: scene.userId,
    })
    .execute();
  return uuid;
}

describe('two finalisers on one session', () => {
  it('serializes on the session row, and the loser is already_finalised', async () => {
    const scene = await sceneIn(db);
    const sessionId = await openSessionIn(scene, '2026-01-31');

    const connA = await connection();
    const connB = await connection();

    const winner = parkedTransactionOn(connA, scene.ctx, () =>
      finaliseReconciliationSession(sessionId, scene.ctx),
    );
    // Wait until it has taken the row and is parked, holding the lock.
    await winner.parked;

    const loser = transactionOn(connB, scene.ctx, () =>
      finaliseReconciliationSession(sessionId, scene.ctx),
    );

    await delay(CONTENTION_WAIT_MS);
    // The contention probe: blocked on the row lock, it cannot have settled.
    expect(loser.hasSettled()).toBe(false);

    winner.commit();
    await winner.promise;

    const error = await loser.promise.then(
      () => {
        throw new Error('the second finalise should have been refused');
      },
      (e: unknown) => e,
    );
    expect(toWireError(error)).toMatchObject({
      details: { precondition: 'reconciliation_session_already_finalised' },
    });
  });
});
