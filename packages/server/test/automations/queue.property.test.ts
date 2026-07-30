import fc from 'fast-check';
import pino from 'pino';
import { describe, expect, it } from 'vitest';

import { toWireError } from '../../src/errors';
import {
  createAutomation,
  createAutomationsSweepHandler,
  pollWorkQueue,
  runAutomation,
  setAutomationActive,
  submitWorkItemProposal,
} from '../../src/modules/automations';
import { newUuid, uuidToBuffer } from '../db';

import {
  agentTaskAutomationInput,
  balancedDraftInput,
  CONTENTION_WAIT_MS,
  connectionId,
  delay,
  ledgerOrgIn,
  orgIn,
  parkedTransactionOn,
  transactionOn,
  useServiceDatabase,
  withContext,
} from './support';

/**
 * The work queue's own concurrency guarantees (Q7, Q10; ROADMAP D-99/D-100/D-118).
 *
 * ## Q10 — the load-bearing one
 *
 * `selectNextQueuedWorkItemForUpdate` (`repository.ts`) claims the oldest
 * `queued` row with `FOR UPDATE SKIP LOCKED`, and the repository's own comment
 * states the guarantee in two parts: two concurrent polls "never receive the
 * same row and never block each other." A sequential simulation — poll, await,
 * poll again — cannot tell that apart from a plain, blocking `FOR UPDATE`: both
 * shapes hand two sequential callers two different rows. Only a genuinely
 * concurrent second poll, run *while the first is still uncommitted and holding
 * its row lock*, can show the difference — which is why the first test below
 * parks one poll open (`parkedTransactionOn`, `test/idempotency/concurrency.test.ts`'s
 * own device) and asserts the second **does not block on it**, the one
 * observation `SKIP LOCKED` and a plain `FOR UPDATE` disagree on.
 *
 * The property test that follows generalises the same claim over a generated
 * number of queued items and concurrent pollers, run as genuine overlapping
 * calls against real MySQL (not `Promise.all` around a sequential mock): no
 * item is ever leased twice, and every poller that could get a fresh item did.
 *
 * ## Q7 — lease-expiry recovery
 *
 * A lease that expires with no submission is requeued, never dropped, its
 * `attempts` incremented — proved by leasing an item, backdating its
 * `lease_expires_at` directly (waiting out a real lease would cost minutes for
 * no assertion `depreciation-sweep.test.ts`'s own sweep tests do not pay
 * either), and running the real sweep handler `job.ts` registers on the daily
 * tick.
 *
 * ## The stale-lease refusal
 *
 * `submitWorkItemProposal` refuses a lease token that names no held item, or
 * one whose lease has expired, with a typed `PreconditionFailedError` —
 * `lease_invalid` / `lease_expired` — never an unhandled throw that would
 * surface as a 500 to an MCP caller (D-118, `submit-with-a-bogus-token` half of
 * `test/transport/v1-q.test.ts`'s own assertion, proved here at the service
 * layer with `toWireError`).
 */
const db = useServiceDatabase();

describe('Q10 — pollWorkQueue’s single-grant lease (FOR UPDATE SKIP LOCKED)', () => {
  it('a parked poll holds its row lock, and a concurrent poll does not block on it — it leases the next item instead', async () => {
    const org = await orgIn(db);
    const first = await db.openAppConnection();
    const second = await db.openAppConnection();

    try {
      expect(await connectionId(first.db)).not.toBe(await connectionId(second.db));

      // Two queued items, enqueued sequentially on `first` so each firing commits
      // before the next begins — the race below is about the *poll*, not about
      // enqueueing.
      const automation = await transactionOn(first, org.ctx, () =>
        createAutomation(agentTaskAutomationInput('Task A'), org.ctx),
      ).promise;
      await transactionOn(first, org.ctx, () => setAutomationActive(automation.id, true, org.ctx))
        .promise;
      await transactionOn(first, org.ctx, () => runAutomation(automation.id, org.ctx)).promise;
      await transactionOn(first, org.ctx, () => runAutomation(automation.id, org.ctx)).promise;

      // The winner leases the oldest item and is parked before its transaction
      // commits — every row it locked (the item it claimed) is still held.
      const winner = parkedTransactionOn(first, org.ctx, () => pollWorkQueue({}, org.ctx));
      const winnerLease = await winner.parked;
      const winnerItem = winnerLease.item;
      if (winnerItem === null) throw new Error('expected a queued item to lease');

      // The loser polls on a genuinely separate connection while the winner's
      // claim is still uncommitted.
      const loser = transactionOn(second, org.ctx, () => pollWorkQueue({}, org.ctx));
      await delay(CONTENTION_WAIT_MS);

      // The one observation a plain `FOR UPDATE` could not produce: the loser is
      // not blocked on the winner's uncommitted row lock. Under a plain
      // `FOR UPDATE` (no `SKIP LOCKED`), `loser.hasSettled()` would still be
      // `false` here, exactly as the D-14 counter races in
      // `test/enforcement/posting-race.test.ts` are.
      expect(loser.hasSettled()).toBe(true);

      const loserLease = await loser.promise;
      const loserItem = loserLease.item;
      if (loserItem === null) throw new Error('expected the second item to lease');

      // The single-grant guarantee itself: two different rows, never the same one.
      expect(loserItem.workItemId).not.toBe(winnerItem.workItemId);

      winner.commit();
      await winner.promise;

      // Both items are now leased — a third poll finds the queue empty, proving
      // no third grant slipped through and that exactly two existed.
      const third = await transactionOn(first, org.ctx, () => pollWorkQueue({}, org.ctx)).promise;
      expect(third.item).toBeNull();
    } finally {
      await first.close();
      await second.close();
    }
  });

  /**
   * The same guarantee, generalised: any number of queued items racing any
   * number of concurrent pollers never double-leases one, and every poller that
   * could get a fresh item does. Run as genuine concurrent calls — `Promise.all`
   * over real MySQL sessions — rather than a sequential loop dressed up as one,
   * which would pass even if `SKIP LOCKED` were deleted outright.
   */
  it('any number of concurrent pollers racing any number of queued items lease each item at most once', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 5 }),
        async (itemCount, pollerCount) => {
          const org = await orgIn(db);

          const automation = await withContext(org.ctx, () =>
            createAutomation(agentTaskAutomationInput('Raced task'), org.ctx),
          );
          await withContext(org.ctx, () => setAutomationActive(automation.id, true, org.ctx));
          for (let i = 0; i < itemCount; i += 1) {
            await withContext(org.ctx, () => runAutomation(automation.id, org.ctx));
          }

          const results = await Promise.all(
            Array.from({ length: pollerCount }, () =>
              withContext(org.ctx, () => pollWorkQueue({}, org.ctx)),
            ),
          );

          const leasedIds = results
            .map((result) => result.item?.workItemId)
            .filter((id): id is string => id !== undefined);

          // Never the same item twice — the single-grant guarantee.
          expect(new Set(leasedIds).size).toBe(leasedIds.length);
          // Every poller that could get a fresh item did — nobody starved while
          // an item sat unleased and nobody was handed a phantom grant.
          expect(leasedIds.length).toBe(Math.min(itemCount, pollerCount));
        },
      ),
      { numRuns: 10 },
    );
  }, 180_000);
});

describe('Q7 — a lease that expires with no submission is requeued, never dropped', () => {
  it('returns the item to queued, increments attempts, and flags it past the threshold', async () => {
    const org = await orgIn(db);
    const automation = await withContext(org.ctx, () =>
      createAutomation(agentTaskAutomationInput('Recover me'), org.ctx),
    );
    await withContext(org.ctx, () => setAutomationActive(automation.id, true, org.ctx));
    await withContext(org.ctx, () => runAutomation(automation.id, org.ctx));

    const leased = await withContext(org.ctx, () => pollWorkQueue({ leaseSeconds: 30 }, org.ctx));
    const item = leased.item;
    if (item === null) throw new Error('expected a queued item to lease');
    const workItemId = uuidToBuffer(item.workItemId);

    // Backdated directly rather than waiting out a real 30-second lease — the
    // sweep's own guard is `lease_expires_at < now`, and this is the state a
    // real expiry reaches, three times over, to cross `LEASE_FLAG_THRESHOLD`.
    const backdate = async (): Promise<void> => {
      await db.app
        .updateTable('work_items')
        .set({ lease_expires_at: new Date(Date.now() - 1_000) })
        .where('id', '=', workItemId)
        .execute();
    };

    const logger = pino({ level: 'silent' });
    const sweep = createAutomationsSweepHandler({ logger });
    // The sweep's other two phases (scheduled firing, event firing) key off this
    // date and this org's `event_log`; irrelevant here since this automation's
    // trigger is `manual` and nothing emits an event, so any calendar date does.
    const runDate = '2026-01-01';

    await backdate();
    await sweep({ runDate });

    const afterFirst = await db.app
      .selectFrom('work_items')
      .select(['status', 'attempts', 'flagged', 'lease_token'])
      .where('id', '=', workItemId)
      .executeTakeFirstOrThrow();
    expect(afterFirst).toMatchObject({ status: 'queued', attempts: 1, flagged: 0 });
    expect(afterFirst.lease_token).toBeNull();

    // Re-lease and let it expire twice more, crossing the flag threshold (3).
    for (let cycle = 2; cycle <= 3; cycle += 1) {
      await withContext(org.ctx, () => pollWorkQueue({ leaseSeconds: 30 }, org.ctx));
      await backdate();
      await sweep({ runDate });
    }

    const afterThird = await db.app
      .selectFrom('work_items')
      .select(['status', 'attempts', 'flagged'])
      .where('id', '=', workItemId)
      .executeTakeFirstOrThrow();
    expect(afterThird).toEqual({ status: 'queued', attempts: 3, flagged: 1 });

    // Never dropped: it is still there, pollable, after every expiry.
    const recovered = await withContext(org.ctx, () => pollWorkQueue({}, org.ctx));
    expect(recovered.item?.workItemId).toBe(item.workItemId);
  });
});

describe('a stale or expired lease token is refused with a typed code, not a 500', () => {
  it('refuses a token naming no held item at all (lease_invalid)', async () => {
    const org = await ledgerOrgIn(db);

    const error = await withContext(org.ctx, () =>
      submitWorkItemProposal({ leaseToken: newUuid(), draft: balancedDraftInput(org) }, org.ctx),
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    const wire = toWireError(error);
    expect(wire.code).toBe('precondition_failed');
    expect(wire.status).toBe(412);
    expect(wire.details).toMatchObject({ precondition: 'lease_invalid' });
  });

  it('refuses a lease token whose lease has expired but was not yet swept (lease_expired)', async () => {
    const org = await ledgerOrgIn(db);
    const automation = await withContext(org.ctx, () =>
      createAutomation(agentTaskAutomationInput('Expire me'), org.ctx),
    );
    await withContext(org.ctx, () => setAutomationActive(automation.id, true, org.ctx));
    await withContext(org.ctx, () => runAutomation(automation.id, org.ctx));

    const leased = await withContext(org.ctx, () => pollWorkQueue({ leaseSeconds: 30 }, org.ctx));
    const item = leased.item;
    if (item === null) throw new Error('expected a queued item to lease');

    // Still `status = 'leased'` — expired on the clock, but the recovery sweep
    // has not run yet. `submitWorkItemProposal` must catch this itself rather
    // than relying on the sweep to have already requeued it.
    await db.app
      .updateTable('work_items')
      .set({ lease_expires_at: new Date(Date.now() - 1_000) })
      .where('id', '=', uuidToBuffer(item.workItemId))
      .execute();

    const error = await withContext(org.ctx, () =>
      submitWorkItemProposal(
        { leaseToken: item.leaseToken, draft: balancedDraftInput(org) },
        org.ctx,
      ),
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    const wire = toWireError(error);
    expect(wire.code).toBe('precondition_failed');
    expect(wire.status).toBe(412);
    expect(wire.details).toMatchObject({ precondition: 'lease_expired' });
  });
});
