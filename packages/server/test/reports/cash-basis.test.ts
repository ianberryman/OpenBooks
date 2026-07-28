import { describe, expect, it } from 'vitest';

import { tenantDb } from '../../src/db';
import { allocatePayment, recordPayment } from '../../src/modules/payments';
import { selectCashBasisBalances } from '../../src/modules/reports/cash-basis/service';
import type { BalanceQuerySpec } from '../../src/modules/reports/balances.repository';
import { selectAccountBalances } from '../../src/modules/reports/balances.repository';
import { documentIn, sceneIn, useServiceDatabase, withContext } from '../payments/support';
import type { Scene } from '../payments/support';

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
});
