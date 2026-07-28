import { describe, expect, it } from 'vitest';

import { tenantDb } from '../../src/db';
import { allocatePayment, recordPayment } from '../../src/modules/payments';
import { selectCashBasisBalances } from '../../src/modules/reports/cash-basis/service';
import type { BalanceQuerySpec } from '../../src/modules/reports/balances.repository';
import { selectAccountBalances } from '../../src/modules/reports/balances.repository';
import { getProfitAndLoss } from '../../src/modules/reports/profit-and-loss.service';
import { postJournal } from '../../src/modules/ledger';
import { documentIn, sceneIn, useServiceDatabase, withContext } from '../payments/support';
import type { Scene } from '../payments/support';

async function markCash(
  db: ReturnType<typeof useServiceDatabase>,
  accountId: Buffer,
): Promise<void> {
  await db.app
    .updateTable('accounts')
    .set({ cash_basis_role: 'cash' })
    .where('id', '=', accountId)
    .execute();
}

/**
 * The cash-basis transform end to end, against real MySQL (OB-154; K2). The pure
 * recogniser is property-tested in `cash-basis-recognition.test.ts`; this proves the
 * repository gathers the right ledger facts and the service assembles them into the
 * accrual core's shape. The through-line worth reading is the contrast: the same
 * invoice, half-paid, is full revenue on accrual and half on cash.
 */

const db = useServiceDatabase();

const PL_SPEC: BalanceQuerySpec = {
  from: null,
  to: null,
  types: ['revenue', 'expense'],
  accountIds: null,
  contactId: null,
  dimensions: [],
  groupBy: null,
};

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

describe('the cash-basis transform', () => {
  it('recognises a half-paid invoice as half its revenue, where accrual shows all of it', async () => {
    const scene = await sceneIn(db);
    const invoice = await documentIn(db, scene, 'invoice', { amountMinor: 100_00n });
    await payInvoice(scene, invoice.uuid, '4000');

    const scoped = tenantDb(scene.orgId);
    const cash = await selectCashBasisBalances(scoped, PL_SPEC);
    const accrual = await selectAccountBalances(scoped, PL_SPEC);

    const cashRevenue = cash.rows.find((row) => row.accountId === scene.revenue.uuid);
    // 40.00 of a 100.00 invoice paid → 40.00 of its revenue recognised, at the payment.
    expect(cashRevenue?.balance.movement.credits).toBe(4000n);

    const accrualRevenue = accrual.find((row) => row.accountId === scene.revenue.uuid);
    // Accrual recognised the whole 100.00 at approval, regardless of payment.
    expect(accrualRevenue?.balance.movement.credits).toBe(100_00n);
  });

  it('recognises nothing for an unpaid invoice (K2 — excludes the unpaid)', async () => {
    const scene = await sceneIn(db);
    await documentIn(db, scene, 'invoice', { amountMinor: 100_00n });

    const cash = await selectCashBasisBalances(tenantDb(scene.orgId), PL_SPEC);
    const revenue = cash.rows.find((row) => row.accountId === scene.revenue.uuid);
    // The account still appears (dense, like the accrual core), but at zero.
    expect(revenue?.balance.movement.credits).toBe(0n);
    expect(revenue?.balance.closing.credits).toBe(0n);
  });

  it('recognises a fully-paid invoice as its whole revenue', async () => {
    const scene = await sceneIn(db);
    const invoice = await documentIn(db, scene, 'invoice', { amountMinor: 250_00n });
    await payInvoice(scene, invoice.uuid, '25000');

    const cash = await selectCashBasisBalances(tenantDb(scene.orgId), PL_SPEC);
    const revenue = cash.rows.find((row) => row.accountId === scene.revenue.uuid);
    expect(revenue?.balance.movement.credits).toBe(250_00n);
  });

  it('renders a cash-basis P&L end to end, labeled, with only the paid revenue', async () => {
    const scene = await sceneIn(db);
    const invoice = await documentIn(db, scene, 'invoice', { amountMinor: 100_00n });
    await payInvoice(scene, invoice.uuid, '4000');

    const [cash, accrual] = await Promise.all([
      withContext(scene.ctx, () => getProfitAndLoss({ basis: 'cash' }, scene.ctx)),
      withContext(scene.ctx, () => getProfitAndLoss({ basis: 'accrual' }, scene.ctx)),
    ]);

    expect(cash.basis).toBe('cash');
    expect(cash.totals.revenue).toBe('4000');
    expect(cash.totals.netIncome).toBe('4000');
    // The same ledger, accrual: the whole invoice is revenue the moment it is raised.
    expect(accrual.basis).toBe('accrual');
    expect(accrual.totals.revenue).toBe('10000');
  });

  it('refuses a cash-basis P&L sliced by contact rather than silently dropping the filter', async () => {
    const scene = await sceneIn(db);
    await expect(
      withContext(scene.ctx, () =>
        getProfitAndLoss({ basis: 'cash', contactId: scene.contact.uuid }, scene.ctx),
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('recognises a direct cash sale posted straight to the ledger (path B, K3)', async () => {
    const scene = await sceneIn(db);
    await markCash(db, scene.bank.id);
    // A cash sale with no invoice: debit the bank, credit revenue.
    await withContext(scene.ctx, () =>
      postJournal(
        {
          date: scene.date,
          actorType: 'user',
          actorId: scene.ctx.actorId,
          lines: [
            { accountId: scene.bank.uuid, side: 'debit', amount: 5000n },
            { accountId: scene.revenue.uuid, side: 'credit', amount: 5000n },
          ],
        },
        scene.ctx,
      ),
    );

    const cash = await selectCashBasisBalances(tenantDb(scene.orgId), PL_SPEC);
    const revenue = cash.rows.find((row) => row.accountId === scene.revenue.uuid);
    expect(revenue?.balance.movement.credits).toBe(5000n);
  });

  it('flags an unallocated receipt rather than recognising it (K4)', async () => {
    const scene = await sceneIn(db);
    await withContext(scene.ctx, () =>
      recordPayment(
        {
          direction: 'received',
          contactId: scene.contact.uuid,
          date: scene.date,
          amount: '3000',
          accountId: scene.bank.uuid,
        },
        scene.ctx,
      ),
    );

    const cash = await selectCashBasisBalances(tenantDb(scene.orgId), PL_SPEC);
    expect(cash.review.some((flag) => flag.kind === 'unallocated_receipt')).toBe(true);
  });

  it('flags a mixed cash/accrual journal and does not split it (K3)', async () => {
    const scene = await sceneIn(db);
    await markCash(db, scene.bank.id);
    // Expense part-paid in cash, part on account: cash + accrual + P&L → ambiguous.
    await withContext(scene.ctx, () =>
      postJournal(
        {
          date: scene.date,
          actorType: 'user',
          actorId: scene.ctx.actorId,
          lines: [
            { accountId: scene.expense.uuid, side: 'debit', amount: 100n },
            { accountId: scene.bank.uuid, side: 'credit', amount: 60n },
            { accountId: scene.payable.uuid, side: 'credit', amount: 40n },
          ],
        },
        scene.ctx,
      ),
    );

    const cash = await selectCashBasisBalances(tenantDb(scene.orgId), PL_SPEC);
    expect(cash.review.some((flag) => flag.kind === 'mixed_cash_journal')).toBe(true);
    const expense = cash.rows.find((row) => row.accountId === scene.expense.uuid);
    expect(expense?.balance.movement.debits).toBe(0n);
  });
});
