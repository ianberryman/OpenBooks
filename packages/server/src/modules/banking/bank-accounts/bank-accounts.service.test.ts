import { beforeEach, describe, expect, it } from 'vitest';

import { runInContext, type RequestContext } from '../../../context';
import { toWireError } from '../../../errors';
import {
  memberIn,
  sceneIn,
  useServiceDatabase,
  type Scene,
} from '../../../../test/banking/clearing-support';
import {
  createReconciliationSession,
  finaliseReconciliationSession,
} from '../reconciliation/reconciliation.service';

import {
  deactivateBankAccount,
  getBankAccount,
  reactivateBankAccount,
} from './bank-accounts.service';

/**
 * Deactivate and reactivate against real MySQL (OB-095, deferred from OB-084; E6, D-45).
 * Never a mock, never SQLite (spec §11): the one thing worth proving here is the guard —
 * that an *open* reconciliation session is read off the real `reconciliation_sessions`
 * row and refuses the deactivation — and a mock holds no such row.
 */

const db = useServiceDatabase();

const END = '2026-01-31';

let scene: Scene;
beforeEach(async () => {
  scene = await sceneIn(db);
});

function run<T>(fn: () => Promise<T>, ctx: RequestContext = scene.ctx): Promise<T> {
  return runInContext(ctx, fn);
}

async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  return fn().then(
    () => {
      throw new Error('expected a refusal, got success');
    },
    (error: unknown) => error,
  );
}

describe('deactivate / reactivate a bank account', () => {
  it('flips isActive off, and reactivate flips it back on', async () => {
    const deactivated = await run(() => deactivateBankAccount(scene.bankAccountUuid, scene.ctx));
    expect(deactivated.isActive).toBe(false);

    // Read back through the read path, not just the return value: the flag is what the
    // import and clearing services check, so what is persisted is the claim under test.
    const afterDeactivate = await run(() => getBankAccount(scene.bankAccountUuid, scene.ctx));
    expect(afterDeactivate.isActive).toBe(false);

    const reactivated = await run(() => reactivateBankAccount(scene.bankAccountUuid, scene.ctx));
    expect(reactivated.isActive).toBe(true);

    const afterReactivate = await run(() => getBankAccount(scene.bankAccountUuid, scene.ctx));
    expect(afterReactivate.isActive).toBe(true);
  });

  it('is idempotent: deactivating an already-inactive account returns it unchanged', async () => {
    await run(() => deactivateBankAccount(scene.bankAccountUuid, scene.ctx));
    const again = await run(() => deactivateBankAccount(scene.bankAccountUuid, scene.ctx));
    expect(again.isActive).toBe(false);
  });

  it('refuses bank_account_has_open_session while a reconciliation session is open', async () => {
    // A real open session on this account: `state` defaults to 'in_progress', which is
    // exactly the condition `hasOpenReconciliationSession` reads.
    await run(() =>
      createReconciliationSession({
        bankAccountId: scene.bankAccountUuid,
        endDate: END,
        statementClosingBalance: '0',
      }),
    );

    const error = await caught(() =>
      run(() => deactivateBankAccount(scene.bankAccountUuid, scene.ctx)),
    );
    expect(toWireError(error)).toMatchObject({
      code: 'precondition_failed',
      status: 412,
      details: { precondition: 'bank_account_has_open_session' },
    });

    // The account is untouched — a refused deactivation must not have flipped the flag.
    const account = await run(() => getBankAccount(scene.bankAccountUuid, scene.ctx));
    expect(account.isActive).toBe(true);
  });

  it('allows deactivation once the session is finalised, not merely opened', async () => {
    // Cleared balance 0 equals the statement's closing balance of 0, so finalising is
    // permitted — and finalising sets `state` to 'finalised', clearing the open marker.
    const session = await run(() =>
      createReconciliationSession({
        bankAccountId: scene.bankAccountUuid,
        endDate: END,
        statementClosingBalance: '0',
      }),
    );
    await run(() => finaliseReconciliationSession(session.id));

    const deactivated = await run(() => deactivateBankAccount(scene.bankAccountUuid, scene.ctx));
    expect(deactivated.isActive).toBe(false);
  });

  it('reactivate carries no open-session guard', async () => {
    // Deactivate cleanly, then open a session on the (now inactive) account is not
    // possible — but reactivation itself must never be gated on session state, so a plain
    // reactivate of a deactivated account is the counterpart the trap-avoidance argument
    // requires.
    await run(() => deactivateBankAccount(scene.bankAccountUuid, scene.ctx));
    const reactivated = await run(() => reactivateBankAccount(scene.bankAccountUuid, scene.ctx));
    expect(reactivated.isActive).toBe(true);
  });

  it('is a 404, not a 403, for a bank account in another org', async () => {
    const stranger = await sceneIn(db);

    for (const call of [
      () => run(() => deactivateBankAccount(stranger.bankAccountUuid, scene.ctx)),
      () => run(() => reactivateBankAccount(stranger.bankAccountUuid, scene.ctx)),
    ]) {
      const error = await caught(call);
      expect(toWireError(error)).toMatchObject({ code: 'not_found', status: 404 });
    }
  });

  it('enforces banking.import on both operations', async () => {
    // read_only holds banking.read but not banking.import, so it may look at the account
    // and not change its activation.
    const readerCtx = await memberIn(db, scene, 'readOnly');

    for (const call of [
      () => run(() => deactivateBankAccount(scene.bankAccountUuid, readerCtx), readerCtx),
      () => run(() => reactivateBankAccount(scene.bankAccountUuid, readerCtx), readerCtx),
    ]) {
      const error = await caught(call);
      expect(toWireError(error)).toMatchObject({
        code: 'permission_denied',
        details: { permission: 'banking.import' },
      });
    }
  });
});
