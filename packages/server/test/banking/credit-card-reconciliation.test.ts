import { describe, expect, it } from 'vitest';

import { runInContext } from '../../src/context';
import { toWireError } from '../../src/errors';
import { clearBankStatementLine } from '../../src/modules/banking/clearing/clearing.service';
import { getReconciliationReport } from '../../src/modules/banking/reconciliation/report.service';
import {
  createReconciliationSession,
  finaliseReconciliationSession,
  getReconciliationSession,
} from '../../src/modules/banking/reconciliation/reconciliation.service';
import type { AccountFixture, TestDatabase } from '../db';
import { newUuid, uuidToBuffer } from '../db';
import {
  accountBalance,
  bankJournalIn,
  sceneIn,
  statementLineIn,
  useServiceDatabase,
  type Scene,
} from './clearing-support';

/**
 * OB-227b — a bank account is reconciled in its ledger account's **normal-balance frame**,
 * not always the cash frame. Proven end to end against real MySQL (spec §11), driving the
 * real services (`createReconciliationSession`, `finaliseReconciliationSession`,
 * `getReconciliationSession`, `getReconciliationReport`) and the clearing entrypoint
 * (`clearBankStatementLine`).
 *
 * Internally every balance is the universal **cash frame** — `SUM(debit) − SUM(credit)`,
 * positive = money in — which OB-227b did not touch. The presentation transform is the
 * involution `inNormalFrame(x, nb) = nb === 'credit' ? -x : x`:
 *  - a **debit-normal asset** bank account reads unchanged (normal frame == cash frame);
 *  - a **credit-normal liability** bank account (a credit card) reads every figure negated
 *    — positive = the balance **owed**, and the statement's closing balance is entered in
 *    that same owed frame.
 *
 * `difference === 0` (a session finalises) exactly when the ledger's cleared balance equals
 * the asserted closing balance, in whichever frame.
 */

const db = useServiceDatabase();

const POSTED = '2026-01-15';
const END = '2026-01-31';

/**
 * A scene whose bank account is a **credit card** — a credit-normal liability ledger
 * account (code 2100), rather than the debit-normal asset `sceneIn` builds at 1010. Every
 * other fixture (org, user, period, counter accounts, contact) is reused, and the returned
 * `Scene` points `bankLedger`/`bankAccountId`/`importId` at the card, so `statementLineIn`,
 * `bankJournalIn`, `accountBalance` and the services all operate on the liability account.
 */
async function creditCardSceneIn(database: TestDatabase): Promise<Scene> {
  const base = await sceneIn(database);

  const creditCard: AccountFixture = await database.factories.account({
    orgId: base.orgId,
    code: '2100',
    type: 'liability',
    normalBalance: 'credit',
  });

  const bankAccountUuid = newUuid();
  const bankAccountId = uuidToBuffer(bankAccountUuid);
  await database.app
    .insertInto('bank_accounts')
    .values({
      id: bankAccountId,
      org_id: base.orgId,
      account_id: creditCard.id,
      name: 'Company credit card',
    })
    .execute();

  const importId = uuidToBuffer(newUuid());
  await database.app
    .insertInto('bank_statement_imports')
    .values({
      id: importId,
      org_id: base.orgId,
      bank_account_id: bankAccountId,
      format: 'csv',
      filename: 'card.csv',
      file_hash: 'b'.repeat(64),
      status: 'complete',
      lines_read: 0,
      lines_duplicate: 0,
      imported_by_user_id: base.userId,
    })
    .execute();

  return { ...base, bankLedger: creditCard, bankAccountId, bankAccountUuid, importId };
}

/**
 * Clears one statement line by linking a freshly-posted bank journal of the same cash-frame
 * amount — the pattern `reconciliation.service.test.ts` uses for an asset, unchanged. The
 * signed amount is the statement line's cash-frame movement (+ = money in): the journal's
 * bank-ledger movement (`debit − credit`) equals it, so the clearing balances exactly.
 */
async function clearLine(
  scene: Scene,
  signedAmount: bigint,
  counter: AccountFixture,
): Promise<void> {
  const line = await statementLineIn(db, scene, { amountMinor: signedAmount, postedDate: POSTED });
  const journal = await bankJournalIn(db, scene, signedAmount, counter);
  await runInContext(scene.ctx, () =>
    clearBankStatementLine(line.uuid, {
      entries: [{ method: 'link_entry', journalId: journal.uuid }],
    }),
  );
}

function openSession(scene: Scene, statementClosingBalance: string) {
  return runInContext(scene.ctx, () =>
    createReconciliationSession({
      bankAccountId: scene.bankAccountUuid,
      endDate: END,
      statementClosingBalance,
    }),
  );
}

async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  return fn().then(
    () => {
      throw new Error('expected a refusal, got success');
    },
    (error: unknown) => error,
  );
}

describe('credit-card (credit-normal) reconciliation', () => {
  // ---------------------------------------------------------------------------
  // The shared scenario. Cash frame: + = money in (debit − credit on the card
  // ledger account). For a credit card, money OUT (a purchase) grows what you owe.
  //
  //   Cleared purchase  $500  -> statement line -50000 (money out), cleared
  //   Cleared payment   $200  -> statement line +20000 (money in),  cleared
  //     cleared cash balance = 0 + (-50000) + 20000 = -30000
  //     -> owed (normal) frame = -(-30000) = +30000  (you owe $300)
  //
  //   Uncleared purchase $150 -> ledger journal -15000, NOT on the statement
  //     book cash balance = -30000 + (-15000) = -45000
  //     -> owed (normal) frame = +45000  (the books say you owe $450)
  //
  //   unclearedAmount (normal) = bookBalance − clearedBalance = 45000 − 30000 = 15000
  //     (its cash-frame counterpart is -45000 − (-30000) = -15000; reported = negation)
  //
  // The statement's closing balance is entered in the owed frame: 30000. Finalising
  // asserts the CLEARED balance (D-50), so the $150 unpresented purchase does not block.
  // ---------------------------------------------------------------------------

  it('opens, clears and finalises in the owed frame, and the $150 unpresented purchase does not block (E5, D-50)', async () => {
    const scene = await creditCardSceneIn(db);
    await clearLine(scene, -50_000n, scene.expense); // $500 purchase (money out)
    await clearLine(scene, 20_000n, scene.revenue); // $200 payment (money in)
    await bankJournalIn(db, scene, -15_000n, scene.expense); // $150 uncleared purchase

    const session = await openSession(scene, '30000'); // owed $300, in the normal frame

    // The cleared balance agrees with the asserted closing balance in the owed frame.
    expect(session.balances.clearedBalance).toBe('30000');
    expect(session.balances.statementClosingBalance).toBe('30000');
    expect(session.balances.difference).toBe('0');
    // The book balance is wider by the unpresented purchase — a reconciling difference,
    // not a blocker (D-50).
    expect(session.balances.bookBalance).toBe('45000');

    const finalised = await runInContext(scene.ctx, () =>
      finaliseReconciliationSession(session.id),
    );
    expect(finalised.state).toBe('finalised');
    expect(finalised.finalisedAt).not.toBeNull();
    expect(finalised.events.map((event) => event.type)).toEqual(['opened', 'finalised']);
    // The asserted balance is recorded in the owed frame it was entered in.
    expect(finalised.events[1]).toMatchObject({
      type: 'finalised',
      statementClosingBalance: '30000',
    });
  });

  it('reports every read-back balance in the owed (normal) frame — the negation of the cash frame', async () => {
    const scene = await creditCardSceneIn(db);
    await clearLine(scene, -50_000n, scene.expense);
    await clearLine(scene, 20_000n, scene.revenue);
    await bankJournalIn(db, scene, -15_000n, scene.expense);

    const session = await openSession(scene, '30000');
    const reread = await runInContext(scene.ctx, () => getReconciliationSession(session.id));

    // A card you owe $500 on reads +500, never -500: every figure is negated.
    expect(reread.balances).toEqual({
      openingBalance: '0',
      clearedBalance: '30000',
      statementClosingBalance: '30000',
      difference: '0',
      bookBalance: '45000',
      unclearedAmount: '15000',
    });
    expect(reread.clearedLineCount).toBe(2);

    // Cross-check against the raw ledger: `SUM(debit) − SUM(credit)` for the card is
    // NEGATIVE (money net-out), and the reported book balance is precisely its negation.
    const cashFrameBook = await accountBalance(db.app, scene.bankLedger.id);
    expect(cashFrameBook).toBe(-45_000n);
    expect(reread.balances.bookBalance).toBe((-cashFrameBook).toString());
  });

  it('refuses a wrong-frame (cash-frame) closing balance, with the difference reported in the owed frame', async () => {
    const scene = await creditCardSceneIn(db);
    await clearLine(scene, -50_000n, scene.expense);
    await clearLine(scene, 20_000n, scene.revenue);

    // The cash-frame number (-30000) is the WRONG sign to assert for a credit card; the
    // owed balance is +30000. Difference is reported in the owed frame:
    //   difference = statementClosing − clearedBalance = -30000 − 30000 = -60000.
    const session = await openSession(scene, '-30000');
    expect(session.balances.clearedBalance).toBe('30000');
    expect(session.balances.difference).toBe('-60000');

    const error = await caught(() =>
      runInContext(scene.ctx, () => finaliseReconciliationSession(session.id)),
    );
    expect(toWireError(error)).toMatchObject({
      details: { precondition: 'reconciliation_session_balance_mismatch' },
    });

    // Still open, nothing asserted.
    const reread = await runInContext(scene.ctx, () => getReconciliationSession(session.id));
    expect(reread.state).toBe('open');
  });

  it('the reconciliation report ties out in the owed frame: clearedBalance + Σ items === bookBalance', async () => {
    const scene = await creditCardSceneIn(db);
    await clearLine(scene, -50_000n, scene.expense);
    await clearLine(scene, 20_000n, scene.revenue);
    await bankJournalIn(db, scene, -15_000n, scene.expense); // the one reconciling item

    const session = await openSession(scene, '30000');
    const report = await runInContext(scene.ctx, () => getReconciliationReport(session.id));

    // One reconciling item — the unpresented $150 purchase — reported in the owed frame
    // (+15000, the negation of its -15000 cash-frame movement).
    expect(report.reconcilingItems).toHaveLength(1);
    const itemSum = report.reconcilingItems.reduce(
      (total, item) => total + BigInt(item.amount),
      0n,
    );
    expect(itemSum).toBe(15_000n);

    // The tie-out identity, all in the owed (normal) frame.
    expect(BigInt(report.balances.clearedBalance) + itemSum).toBe(
      BigInt(report.balances.bookBalance),
    );
    expect(itemSum).toBe(BigInt(report.balances.unclearedAmount));
  });
});

// ---------------------------------------------------------------------------
// Regression: OB-227b changed NOTHING for a debit-normal asset — `inNormalFrame`
// is the identity there, so every figure is the plain cash-frame value (+ = money in).
// The SAME arithmetic shape as above, read in the cash frame:
//   Cleared deposit    $500 -> +50000, cleared
//   Cleared withdrawal $200 -> -20000, cleared
//     cleared balance = 0 + 50000 − 20000 = 30000
//   Uncleared outflow  $150 -> -15000 ledger journal, not on the statement
//     book balance = 30000 − 15000 = 15000
//   unclearedAmount = 15000 − 30000 = -15000
// ---------------------------------------------------------------------------

describe('asset (debit-normal) reconciliation is unchanged — inNormalFrame is the identity', () => {
  it('reports every balance as the cash-frame value (+ = money in), and finalises against it', async () => {
    const scene = await sceneIn(db); // the ordinary asset bank account at code 1010
    await clearLine(scene, 50_000n, scene.revenue); // $500 deposit (money in)
    await clearLine(scene, -20_000n, scene.expense); // $200 withdrawal (money out)
    await bankJournalIn(db, scene, -15_000n, scene.expense); // $150 unpresented cheque

    const session = await openSession(scene, '30000');
    const reread = await runInContext(scene.ctx, () => getReconciliationSession(session.id));

    // Cash frame == normal frame for a debit-normal account: nothing is negated.
    expect(reread.balances).toEqual({
      openingBalance: '0',
      clearedBalance: '30000',
      statementClosingBalance: '30000',
      difference: '0',
      bookBalance: '15000',
      unclearedAmount: '-15000',
    });

    // The raw ledger balance is POSITIVE (money net-in) and equals the reported figure
    // exactly — no negation, because the frame is the identity.
    const cashFrameBook = await accountBalance(db.app, scene.bankLedger.id);
    expect(cashFrameBook).toBe(15_000n);
    expect(reread.balances.bookBalance).toBe(cashFrameBook.toString());

    const finalised = await runInContext(scene.ctx, () =>
      finaliseReconciliationSession(session.id),
    );
    expect(finalised.state).toBe('finalised');
  });
});
