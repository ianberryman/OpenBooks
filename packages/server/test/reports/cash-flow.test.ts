import { describe, expect, it } from 'vitest';

import { newUuidBuffer } from '../../src/db';
import { allocatePayment, recordPayment } from '../../src/modules/payments';
import { getStatementOfCashFlows } from '../../src/modules/reports/cash-flow.service';
import { documentIn, sceneIn, useServiceDatabase, withContext } from '../payments/support';
import type { Scene } from '../payments/support';

/**
 * The Statement of Cash Flows end to end, against real MySQL (OB-157; D-88).
 *
 * The through-line: net income and the change in cash are two independent readings
 * over the same ledger — one through the P&L core, one through `getAccountBalances`
 * filtered to the cash accounts — and `adjustments` is defined as whatever it takes
 * to reconcile them. So the properties worth proving are the reconciliation
 * identities themselves, not any one figure in isolation, following the invoice+
 * payment scenario `cash-basis.test.ts` builds its own suite around.
 */

const db = useServiceDatabase();

/** Registers `scene.bank` as a cash account through `bank_accounts`, the primary path. */
async function registerBankAccount(scene: Scene): Promise<void> {
  await db.app
    .insertInto('bank_accounts')
    .values({
      id: newUuidBuffer(),
      org_id: scene.orgId,
      account_id: scene.bank.id,
      name: 'Current account',
    })
    .execute();
}

async function payInvoice(scene: Scene, invoiceUuid: string, amount: string): Promise<void> {
  const payment = await withContext(scene.ctx, () =>
    recordPayment(
      {
        direction: 'received',
        contactId: scene.contact.uuid,
        date: scene.date,
        amount,
        accountId: scene.bank.uuid,
      },
      scene.ctx,
    ),
  );
  await withContext(scene.ctx, () =>
    allocatePayment(
      payment.id,
      { allocations: [{ targetType: 'invoice', targetId: invoiceUuid, amount }] },
      scene.ctx,
    ),
  );
}

describe('the statement of cash flows', () => {
  it('reconciles net income and the change in cash for a fully-paid invoice', async () => {
    const scene = await sceneIn(db);
    await registerBankAccount(scene);

    const invoice = await documentIn(db, scene, 'invoice', { amountMinor: 100_00n });
    await payInvoice(scene, invoice.uuid, '10000');

    const statement = await withContext(scene.ctx, () => getStatementOfCashFlows({}, scene.ctx));

    expect(statement.basis).toBe('accrual');
    // The whole invoice is revenue the moment it is raised (accrual), and the whole amount
    // landed in the bank the same day, so every figure below is the same 100.00.
    expect(statement.netIncome).toBe('10000');
    expect(statement.openingCash).toBe('0');
    expect(statement.netChangeInCash).toBe('10000');
    expect(statement.closingCash).toBe('10000');
    expect(statement.adjustments).toBe('0');

    // The two identities the response promises: opening + change = closing, and
    // net income + adjustments = the change in cash.
    expect(BigInt(statement.openingCash) + BigInt(statement.netChangeInCash)).toBe(
      BigInt(statement.closingCash),
    );
    expect(BigInt(statement.netIncome) + BigInt(statement.adjustments)).toBe(
      BigInt(statement.netChangeInCash),
    );
    expect(statement.reconciles).toBe(true);
  });

  it('recognises a cash account flagged directly, not only one in bank_accounts', async () => {
    const scene = await sceneIn(db);
    // A second asset account, flagged rather than registered — the other half of the OR
    // (`shared-types/reports/cash-flow.ts`). No `bank_accounts` row exists for it at all.
    const till = await db.factories.account({
      orgId: scene.orgId,
      code: '1011',
      type: 'asset',
      normalBalance: 'debit',
    });
    await db.app
      .updateTable('accounts')
      .set({ cash_basis_role: 'cash' })
      .where('id', '=', till.id)
      .execute();

    // A direct cash sale, rung straight into the till rather than through AR.
    await db.factories.journal({
      orgId: scene.orgId,
      periodId: scene.periodId,
      entryDate: scene.date,
      actorId: scene.userId,
      lines: [
        { accountId: till.id, debitMinor: 50_00n },
        { accountId: scene.revenue.id, creditMinor: 50_00n },
      ],
    });

    const statement = await withContext(scene.ctx, () => getStatementOfCashFlows({}, scene.ctx));

    expect(statement.netIncome).toBe('5000');
    expect(statement.netChangeInCash).toBe('5000');
    expect(statement.adjustments).toBe('0');
    expect(statement.reconciles).toBe(true);
  });

  /**
   * An org that has registered no cash account at all is an honest empty report, not an
   * error — the same dense-zero choice `getAccountBalances` makes for an account with no
   * postings, restated for "no accounts matched the filter at all".
   */
  it('reports zero cash movement, not an error, when no account is flagged as cash', async () => {
    const scene = await sceneIn(db);
    await documentIn(db, scene, 'invoice', { amountMinor: 100_00n });

    const statement = await withContext(scene.ctx, () => getStatementOfCashFlows({}, scene.ctx));

    expect(statement.openingCash).toBe('0');
    expect(statement.netChangeInCash).toBe('0');
    expect(statement.closingCash).toBe('0');
    // Net income is still recognised on accrual even though nothing was collected — the
    // whole of the unpaid invoice is the reconciling adjustment.
    expect(statement.netIncome).toBe('10000');
    expect(statement.adjustments).toBe('-10000');
    expect(statement.reconciles).toBe(true);
  });

  it('runs net income on the requested basis while the cash movement stays one fact', async () => {
    const scene = await sceneIn(db);
    await registerBankAccount(scene);

    const invoice = await documentIn(db, scene, 'invoice', { amountMinor: 100_00n });
    await payInvoice(scene, invoice.uuid, '4000');

    const [cash, accrual] = await Promise.all([
      withContext(scene.ctx, () => getStatementOfCashFlows({ basis: 'cash' }, scene.ctx)),
      withContext(scene.ctx, () => getStatementOfCashFlows({ basis: 'accrual' }, scene.ctx)),
    ]);

    expect(cash.basis).toBe('cash');
    // 40.00 of a 100.00 invoice collected → 40.00 of revenue recognised on cash basis.
    expect(cash.netIncome).toBe('4000');
    expect(accrual.basis).toBe('accrual');
    // The whole invoice is revenue on accrual, regardless of payment.
    expect(accrual.netIncome).toBe('10000');

    // Which account the money landed in is not a recognition question: both bases read
    // the identical 40.00 of cash movement, and only the reconciling line differs.
    expect(cash.netChangeInCash).toBe('4000');
    expect(accrual.netChangeInCash).toBe('4000');
    expect(cash.adjustments).toBe('0');
    expect(accrual.adjustments).toBe('-6000');
    expect(cash.reconciles).toBe(true);
    expect(accrual.reconciles).toBe(true);
  });
});
