import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { recordNormalizedEvent } from '../../src/modules/payments-processing';

import {
  accountBalance,
  automationCtxFor,
  chargeEvent,
  clearingBalanceFromEventLog,
  connectFakeProcessor,
  CONTENTION_WAIT_MS,
  delay,
  deliverFakeWebhook,
  externalRefsCountFor,
  invoiceIn,
  mysqlConnectionId,
  parkedTransactionOn,
  paymentsCount,
  payoutEvent,
  processorEventsCount,
  recordEvent,
  refundEvent,
  sceneIn,
  transactionOn,
  usePayProcessingApp,
} from './support';

/**
 * F9's replay collapse, D-85's connection lock under real contention, and D-82's
 * clearing-account arithmetic — proved against real MySQL (spec §11), never mocked.
 *
 * Three properties, each load-bearing on its own:
 *
 *  1. The **wire** receiver collapses a redelivered webhook (same `externalEventId`)
 *     to one payment, and a poll re-reporting the same object under a *different*
 *     `externalEventId` collapses too (object-level `external_refs` dedup).
 *  2. **Prove contention, don't assume it** (CLAUDE.md): two concurrent deliveries of
 *     one charge, on two genuinely separate connections, park one mid-transaction and
 *     assert the other has not settled — a sequential simulation would pass against
 *     code with no locking at all.
 *  3. The clearing account's ledger balance after a randomized stream of
 *     charge/fee/refund/payout events equals the balance implied by the events
 *     themselves, computed a second, independent way (the OB-088
 *     `report.property.test.ts` discipline).
 */
const harness = usePayProcessingApp();
const db = harness.db;

describe('F9: a replayed or re-polled charge collapses to one payment', () => {
  it('the same signed webhook delivered twice over HTTP posts once, and reads back "duplicate"', async () => {
    const app = harness.app();
    const scene = await sceneIn(db);
    const { connection, webhookSecret } = await connectFakeProcessor(scene);
    const invoice = await invoiceIn(scene, 150_000n);

    const event = chargeEvent({
      invoiceId: invoice.id,
      externalObjectId: 'ch_replay',
      externalEventId: 'evt_replay',
      grossMinor: '150000',
      feeMinor: '4500',
    });

    const first = await deliverFakeWebhook(app, connection.id, webhookSecret, event);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ status: 'processed' });

    const second = await deliverFakeWebhook(app, connection.id, webhookSecret, event);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ status: 'duplicate' });

    // Exactly one payment, one fee journal, singular processor_events/external_refs.
    expect(await paymentsCount(db.app, scene.orgId)).toBe(1);
    expect(await externalRefsCountFor(db.app, scene.orgId, 'ch_replay')).toBe(1);

    const eventRows = await db.app
      .selectFrom('processor_events')
      .select(['status'])
      .where('org_id', '=', scene.orgId)
      .where('external_event_id', '=', 'evt_replay')
      .execute();
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0]?.status).toBe('processed');

    // The fee posted once too — the clearing account moved by gross minus fee, not
    // by gross minus fee twice.
    expect(await accountBalance(db.app, scene.clearing.id)).toBe(150_000n - 4_500n);
    expect(await accountBalance(db.app, scene.fee.id)).toBe(4_500n);
  });

  it('a poll re-reporting the same charge under a new externalEventId still collapses (object-level dedup)', async () => {
    const scene = await sceneIn(db);
    const { connection } = await connectFakeProcessor(scene);
    const invoice = await invoiceIn(scene, 20_000n);
    const ctx = automationCtxFor(scene, connection.id);

    const viaWebhook = chargeEvent({
      invoiceId: invoice.id,
      externalObjectId: 'ch_poll',
      externalEventId: 'evt_webhook_delivery',
      grossMinor: '20000',
    });
    const webhookResult = await recordEvent(ctx, connection.id, 'fake', viaWebhook);
    expect(webhookResult.status).toBe('processed');

    // The poll backstop re-fetches the identical object under its own event id
    // (`poll.job.ts`'s own shape) — a genuinely different delivery, not a replay.
    const viaPoll = { ...viaWebhook, externalEventId: 'evt_poll_rediscovery' };
    const pollResult = await recordEvent(ctx, connection.id, 'fake', viaPoll);
    // `dispatch()`'s `'charge'` case reports `'processed'` regardless of whether
    // `recordProcessorCharge` actually posted — the property under test is the
    // *side effect*, not this status string, which is why every assertion below
    // reads the tables rather than trusting it.
    expect(pollResult.status).toBe('processed');

    expect(await processorEventsCount(db.app, scene.orgId)).toBe(2);
    expect(await paymentsCount(db.app, scene.orgId)).toBe(1);
    expect(await externalRefsCountFor(db.app, scene.orgId, 'ch_poll')).toBe(1);
  });
});

describe('prove contention, not assume it: two deliveries of one charge racing for the connection lock', () => {
  it('the loser blocks on `processor_connections FOR UPDATE` until the winner commits, and only one payment posts', async () => {
    const scene = await sceneIn(db);
    const { connection } = await connectFakeProcessor(scene);
    const invoice = await invoiceIn(scene, 30_000n);
    const ctx = automationCtxFor(scene, connection.id);

    const first = await db.openAppConnection();
    const second = await db.openAppConnection();

    try {
      expect(await mysqlConnectionId(first.db)).not.toBe(await mysqlConnectionId(second.db));

      // Same object, two different deliveries (webhook vs. poll shape) — the only
      // scenario in which the `processor_connections` row lock is the serialization
      // point at all: an identical `externalEventId` would already be turned back by
      // `processor_events`' own unique key, never reaching this lock (`webhook.service.ts`'s
      // own header is explicit about that ordering).
      const eventA = chargeEvent({
        invoiceId: invoice.id,
        externalObjectId: 'ch_race',
        externalEventId: 'evt_race_a',
        grossMinor: '30000',
      });
      const eventB = { ...eventA, externalEventId: 'evt_race_b' };

      // The winner: reads the connection row `FOR UPDATE`, finds no recorded ref,
      // posts the payment and the correlation, and parks — still holding the lock,
      // nothing committed yet.
      const winner = parkedTransactionOn(first, ctx, () =>
        recordNormalizedEvent(connection.id, 'fake', eventA, ctx),
      );
      await winner.parked;

      const loser = transactionOn(second, ctx, () =>
        recordNormalizedEvent(connection.id, 'fake', eventB, ctx),
      );
      await delay(CONTENTION_WAIT_MS);

      // **The mechanism, asserted.** The loser cannot have decided anything: it is
      // blocked acquiring the same row lock `recordProcessorCharge` takes before it
      // ever consults `external_refs`. Without that lock it would read its own
      // snapshot, see nothing recorded, and post a second payment.
      expect(loser.hasSettled()).toBe(false);
      // And nothing is visible from outside until the winner commits.
      expect(await paymentsCount(db.app, scene.orgId)).toBe(0);

      winner.commit();
      await winner.promise;

      // The loser's locking read is a *current* read (`over-allocation-race.test.ts`'s
      // own finding, applied here), so once the winner commits it sees the winner's
      // `external_refs` row and stops rather than posting a second payment.
      await expect(loser.promise).resolves.toMatchObject({ status: 'processed' });

      expect(await paymentsCount(db.app, scene.orgId)).toBe(1);
      expect(await externalRefsCountFor(db.app, scene.orgId, 'ch_race')).toBe(1);
      expect(await accountBalance(db.app, scene.clearing.id)).toBe(30_000n);
    } finally {
      await first.close();
      await second.close();
    }
  });
});

describe('the clearing account reconciles against a generated event stream (D-85, OB-088 discipline)', () => {
  interface Charge {
    readonly gross: bigint;
    readonly fee: bigint | null;
  }
  interface Plan {
    readonly charges: readonly Charge[];
    readonly refunds: readonly bigint[];
    readonly payouts: readonly bigint[];
  }

  const grossArb = fc.integer({ min: 500, max: 200_000 }).map(BigInt);
  const chargeArb: fc.Arbitrary<Charge> = grossArb.chain((gross) =>
    fc.record({
      gross: fc.constant(gross),
      fee: fc.option(
        fc.integer({ min: 1, max: Math.max(1, Number(gross / 20n)) }).map(BigInt),
        { nil: null },
      ),
    }),
  );
  const planArb: fc.Arbitrary<Plan> = fc.record({
    charges: fc.array(chargeArb, { minLength: 1, maxLength: 3 }),
    refunds: fc.array(fc.integer({ min: 100, max: 50_000 }).map(BigInt), { maxLength: 2 }),
    payouts: fc.array(fc.integer({ min: 100, max: 50_000 }).map(BigInt), { maxLength: 2 }),
  });

  function sum(values: readonly bigint[]): bigint {
    return values.reduce((total, value) => total + value, 0n);
  }

  const RUNS = 8;

  it('debits minus credits on the clearing account equals gross minus fees minus refunds, on every generated shape', async () => {
    let feeSeen = 0;
    let refundSeen = 0;
    let payoutSeen = 0;

    await fc.assert(
      fc.asyncProperty(planArb, async (plan) => {
        const scene = await sceneIn(db);
        const { connection } = await connectFakeProcessor(scene);
        const ctx = automationCtxFor(scene, connection.id);

        let seq = 0;
        for (const charge of plan.charges) {
          seq += 1;
          const invoice = await invoiceIn(scene, charge.gross);
          const event = chargeEvent({
            invoiceId: invoice.id,
            externalObjectId: `ch_${String(seq)}`,
            externalEventId: `evt_ch_${String(seq)}`,
            grossMinor: charge.gross.toString(),
            feeMinor: charge.fee === null ? null : charge.fee.toString(),
          });
          const result = await recordEvent(ctx, connection.id, 'fake', event);
          expect(result.status).toBe('processed');
        }
        for (const refund of plan.refunds) {
          seq += 1;
          const event = refundEvent({
            externalObjectId: `rf_${String(seq)}`,
            externalEventId: `evt_rf_${String(seq)}`,
            grossMinor: refund.toString(),
          });
          const result = await recordEvent(ctx, connection.id, 'fake', event);
          expect(result.status).toBe('processed');
        }
        for (const payout of plan.payouts) {
          seq += 1;
          const event = payoutEvent({
            externalObjectId: `po_${String(seq)}`,
            externalEventId: `evt_po_${String(seq)}`,
            netMinor: payout.toString(),
          });
          const result = await recordEvent(ctx, connection.id, 'fake', event);
          expect(result.status).toBe('processed');
        }

        const expected =
          sum(plan.charges.map((c) => c.gross)) -
          sum(plan.charges.map((c) => c.fee ?? 0n)) -
          sum(plan.refunds);

        // Three independent statements about the same number: the generator's own
        // arithmetic, the real ledger (`journal_lines`), and the event log
        // (`processor_events.payload`) — a different table, populated by a different
        // write than the one `postJournal` makes. `expected` omits the payouts
        // entirely (D-82: a payout posts no journal of its own — the reconciling
        // entry is a later, separate M4 clear), so a mutation that gave
        // `recordProcessorPayout` a journal to post would show up here as a real
        // ledger balance the formula did not predict.
        expect(await accountBalance(db.app, scene.clearing.id)).toBe(expected);
        expect(await clearingBalanceFromEventLog(db.app, scene.orgId)).toBe(expected);

        if (plan.charges.some((c) => c.fee !== null)) feeSeen += 1;
        if (plan.refunds.length > 0) refundSeen += 1;
        if (plan.payouts.length > 0) payoutSeen += 1;
      }),
      { numRuns: RUNS },
    );

    // The generator has to actually reach every shape the property is about
    // (`report.property.test.ts`'s own discipline), or these assert nothing.
    expect(feeSeen).toBeGreaterThan(0);
    expect(refundSeen).toBeGreaterThan(0);
    expect(payoutSeen).toBeGreaterThan(0);
  }, 60_000);
});
