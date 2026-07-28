import { describe, expect, it } from 'vitest';

import { allocatePayment, recordPayment } from '../../src/modules/payments';
import { getCashFlowProjection } from '../../src/modules/reports/cash-flow-projection.service';
import { newUuidBuffer } from '../db';
import { documentIn, sceneIn, useServiceDatabase, withContext } from '../payments/support';
import type { Scene } from '../payments/support';

/**
 * The forward cash-flow projection, worked by hand (OB-158; ROADMAP D-88, K6).
 *
 * Three things are under test.
 *
 * The first is opening cash: it has to be the ledger's own `debits - credits` for the
 * accounts this org has registered as cash, not a stored figure — the same D-46 argument
 * `bank_accounts` exists to make.
 *
 * The second is the bucketing, which is `aging.repository.ts`'s outstanding-by-due-date
 * reading (D-34: total minus allocations, computed on read) pointed forward instead of
 * back, and specifically the two edges that reading has to get right here: an overdue
 * invoice — one whose due date has already passed and is still unpaid — must land in the
 * *nearest* bucket rather than being dropped, and a due date past the requested horizon must
 * be excluded rather than silently rolled into the last bucket.
 *
 * The third is that the running `projectedClosingCash` is genuinely cumulative: each
 * bucket's figure is opening cash plus every bucket's net change up to and including it,
 * not merely that bucket's own net change.
 */

const db = useServiceDatabase();

const ASOF = '2026-01-01';

/** Registers `scene.bank` as a recognised cash account, the way OB-095's setup screen would. */
async function registerBankAccount(scene: Scene): Promise<void> {
  await db.app
    .insertInto('bank_accounts')
    .values({
      id: newUuidBuffer(),
      org_id: scene.orgId,
      account_id: scene.bank.id,
      name: 'Operating account',
    })
    .execute();
}

/** An opening cash balance: a journal debiting the bank account directly, dated `asOf`. */
async function seedOpeningCash(scene: Scene, amountMinor: bigint): Promise<void> {
  await db.factories.journal({
    orgId: scene.orgId,
    periodId: scene.periodId,
    entryDate: ASOF,
    actorId: scene.userId,
    lines: [
      { accountId: scene.bank.id, debitMinor: amountMinor },
      { accountId: scene.revenue.id, creditMinor: amountMinor },
    ],
  });
}

describe('the cash-flow projection', () => {
  it('reads opening cash from the ledger balance of the registered bank account', async () => {
    const scene = await sceneIn(db);
    await registerBankAccount(scene);
    await seedOpeningCash(scene, 500_000n); // 5,000.00

    const projection = await withContext(scene.ctx, () =>
      getCashFlowProjection({ asOf: ASOF, granularity: 'monthly', horizon: 1 }, scene.ctx),
    );

    expect(projection.openingCash).toBe('500000');
    // Nothing outstanding yet, so the one bucket carries the opening balance forward.
    expect(projection.buckets[0]?.projectedClosingCash).toBe('500000');
  });

  it('reports zero opening cash when the org has registered no cash account, not the whole chart', async () => {
    const scene = await sceneIn(db);
    // Deliberately not registered — `selectCashAccountIds` must return an empty list, and
    // an empty `accountIds` must read as "no cash accounts" and not as "no filter".
    await seedOpeningCash(scene, 500_000n);

    const projection = await withContext(scene.ctx, () =>
      getCashFlowProjection({ asOf: ASOF }, scene.ctx),
    );

    expect(projection.openingCash).toBe('0');
  });

  it('buckets outstanding AR and AP by due date, and accumulates cash across buckets', async () => {
    const scene = await sceneIn(db);
    await registerBankAccount(scene);
    await seedOpeningCash(scene, 500_000n); // 5,000.00

    // January: due the 15th, comfortably inside the first monthly bucket.
    await documentIn(db, scene, 'invoice', { amountMinor: 100_000n, dueDate: '2026-01-15' });
    // Overdue — due before `asOf` and still unpaid. Must land in the first bucket rather
    // than being dropped, because money already overdue is money expected now.
    await documentIn(db, scene, 'invoice', { amountMinor: 30_000n, dueDate: '2025-11-01' });
    // A bill due the same January window, an outflow in the same bucket.
    await documentIn(db, scene, 'bill', { amountMinor: 40_000n, dueDate: '2026-01-20' });

    // February: the second monthly bucket.
    await documentIn(db, scene, 'invoice', { amountMinor: 50_000n, dueDate: '2026-02-10' });

    // Beyond the two-bucket horizon requested below — must not appear anywhere.
    await documentIn(db, scene, 'invoice', { amountMinor: 999_999n, dueDate: '2026-06-01' });

    const projection = await withContext(scene.ctx, () =>
      getCashFlowProjection({ asOf: ASOF, granularity: 'monthly', horizon: 2 }, scene.ctx),
    );

    expect(projection.buckets).toHaveLength(2);

    const [january, february] = projection.buckets;
    expect(january).toMatchObject({
      periodStart: '2026-01-01',
      periodEnd: '2026-01-31',
      // 1,000.00 due in January plus the 300.00 overdue invoice.
      expectedInflows: '130000',
      expectedOutflows: '40000',
      netChange: '90000',
      // 5,000.00 opening + 900.00 net.
      projectedClosingCash: '590000',
    });
    expect(february).toMatchObject({
      periodStart: '2026-02-01',
      periodEnd: '2026-02-28',
      expectedInflows: '50000',
      expectedOutflows: '0',
      netChange: '50000',
      // The running total carries January's closing forward: 5,900.00 + 500.00.
      projectedClosingCash: '640000',
    });

    // The 9,999.99 invoice due in June is outside a two-bucket horizon and must not have
    // been folded into February, the last bucket, or counted anywhere.
    const totalInflows = projection.buckets.reduce(
      (sum, bucket) => sum + BigInt(bucket.expectedInflows),
      0n,
    );
    expect(totalInflows).toBe(180_000n);
  });

  it('excludes a settled invoice — outstanding is total minus allocations, not the original amount', async () => {
    const scene = await sceneIn(db);
    await registerBankAccount(scene);

    const invoice = await documentIn(db, scene, 'invoice', {
      amountMinor: 100_00n,
      dueDate: '2026-01-20',
    });

    const payment = await withContext(scene.ctx, () =>
      recordPayment(
        {
          direction: 'received',
          contactId: scene.contact.uuid,
          date: ASOF,
          amount: '10000',
          accountId: scene.bank.uuid,
        },
        scene.ctx,
      ),
    );
    await withContext(scene.ctx, () =>
      allocatePayment(
        payment.id,
        { allocations: [{ targetType: 'invoice', targetId: invoice.uuid, amount: '10000' }] },
        scene.ctx,
      ),
    );

    const projection = await withContext(scene.ctx, () =>
      getCashFlowProjection({ asOf: ASOF, granularity: 'monthly', horizon: 1 }, scene.ctx),
    );

    // Fully allocated: nothing left to expect, so the bucket carries no inflow from it.
    expect(projection.buckets[0]?.expectedInflows).toBe('0');
  });

  it('splits into weekly rather than monthly buckets when asked', async () => {
    const scene = await sceneIn(db);
    await registerBankAccount(scene);

    await documentIn(db, scene, 'invoice', { amountMinor: 20_00n, dueDate: '2026-01-05' });

    const projection = await withContext(scene.ctx, () =>
      getCashFlowProjection({ asOf: ASOF, granularity: 'weekly', horizon: 1 }, scene.ctx),
    );

    expect(projection.granularity).toBe('weekly');
    expect(projection.buckets[0]).toMatchObject({
      periodStart: '2026-01-01',
      periodEnd: '2026-01-07',
      expectedInflows: '2000',
    });
  });

  it('always says recurring commitments are not included, because they do not exist yet', async () => {
    const scene = await sceneIn(db);

    const projection = await withContext(scene.ctx, () =>
      getCashFlowProjection({ asOf: ASOF }, scene.ctx),
    );

    expect(projection.includesRecurringCommitments).toBe(false);
  });
});
