import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { emitEvent } from '../../src/modules/events';
import { approveInvoice, createInvoice } from '../../src/modules/invoices';
import { newUuid, useTestDatabase } from '../db';

import {
  approveBillOn,
  approveInvoiceOn,
  CONTENTION_WAIT_MS,
  connectionId,
  delay,
  finaliseReconciliationOn,
  markedInvoiceApprovedInput,
  OP_DATE,
  orgIn,
  parkedTransactionOn,
  readEventLog,
  recordPaymentOn,
  sceneIn,
  transactionOn,
} from './event-outbox-support';

/**
 * The transactional outbox's own property suite (OB-107; ROADMAP D-56; spec §11
 * F7/F8; depends on OB-100/101/102).
 *
 * F7 — **an `event_log` row exists if and only if the change it announces
 * committed.** F8's ordering and replay side (gapless per-org `position`, and the
 * change feed replaying every event exactly once from any cursor) is
 * `change-feed.property.test.ts`; this file is the write side: `emitEvent`
 * (`modules/events/outbox.ts`) and the four real call sites that append to it —
 * `approveInvoice`/`approveBill`, `recordPayment`, `finaliseReconciliationSession`.
 *
 * ## Mutation coverage (CLAUDE.md: "mutation-test anything load-bearing")
 *
 * The outbox is the ledger kernel's analog for this ticket, and gets the same
 * rigor. Three mutations, and the property or test that would catch each one:
 *
 * 1. **`emitEvent` writing/delivering *before* the transaction commits** — e.g. on
 *    its own connection, or flushed to a subscriber synchronously instead of only
 *    ever being a row in the same tenant transaction as the state change. Caught by
 *    `'a rolled-back approval leaves the outbox untouched'` below: it forces a real
 *    approval's transaction to roll back *after* `approveInvoice` has returned (the
 *    event is written, uncommitted) and asserts zero `event_log` rows survive. Under
 *    the mutation, the write would have already reached its own connection or been
 *    delivered, and this assertion would see a surviving row (or a bus already
 *    notified) that the rollback could not undo.
 * 2. **The position counter advancing by zero, or a position reused** — e.g.
 *    `allocateEventPosition` reading `next_value` without a real claim on it, or two
 *    calls computing the same value. Caught three ways: the commit-set property
 *    below asserts `position` is exactly `1..N` with no repeat for every run: a
 *    stuck or reused counter would either violate that sequence directly, or — if it
 *    somehow avoided detection there — collide with `uq_event_log_org_position` and
 *    surface as a rejected promise instead of a settled array of N committed
 *    operations. The *contention* half (two emits racing one org's counter, below)
 *    additionally proves the `FOR UPDATE` claim is real: without it, the racing
 *    caller would not block at all, and `hasSettled()` would already be `true` at
 *    the point the property asserts it is not.
 * 3. **A double-emit** — `emitEvent` called twice for one committed operation.
 *    Caught by the commit-set property's `toHaveLength(expected.length)`: a doubled
 *    write leaves the outbox one row longer than the operations that actually ran,
 *    and every position after the duplicate stops lining up with the operation the
 *    test expected to find there.
 *
 * ## Real MySQL, no pool (`test/enforcement/event-outbox-support.ts`)
 *
 * Every call here is pinned to a chosen `openAppConnection()` handle via
 * `transactionOn`/`parkedTransactionOn`, and the process pool is never
 * initialized — a service call that escaped its ambient transaction would throw
 * "Database not initialized" rather than quietly running on a third connection,
 * where a contention proof would pass having proved nothing
 * (`test/enforcement/support.ts`'s own header states this at length).
 *
 * Money in every payload is asserted as the cents-only string D-13 requires
 * (`"150000"`, never a decimal or a JSON number) — `serializeEventValue` in
 * `outbox.ts` is what turns the `bigint` this file passes in into that string.
 */
const db = useTestDatabase();

// ---------------------------------------------------------------------------
// F7 — the commit set: every committed operation, and nothing else
// ---------------------------------------------------------------------------

type OpKind = 'invoice' | 'bill' | 'payment_received' | 'payment_made';

interface PlannedOp {
  readonly kind: OpKind;
  readonly amount: bigint;
}

const amountArb: fc.Arbitrary<bigint> = fc.bigInt({ min: 100n, max: 500_000n });

const opArb: fc.Arbitrary<PlannedOp> = fc.record({
  kind: fc.constantFrom<OpKind>('invoice', 'bill', 'payment_received', 'payment_made'),
  amount: amountArb,
});

const planArb = fc.record({
  ops: fc.array(opArb, { minLength: 1, maxLength: 5 }),
  // At most one reconciliation per scene (`finaliseReconciliationOn`'s header) —
  // still exercises the fourth emit site within the same generated run.
  reconcile: fc.boolean(),
});

interface ExpectedEvent {
  readonly name: string;
  readonly marker: string;
  readonly amount: bigint | undefined;
}

describe('F7 — the outbox holds exactly one row per committed operation (D-56)', () => {
  it('a generated run of invoice/bill approvals, payments and a reconciliation matches the outbox', async () => {
    const seen = {
      invoice: 0,
      bill: 0,
      payment_received: 0,
      payment_made: 0,
      reconciliation: 0,
    };
    const connection = await db.openAppConnection();

    try {
      await fc.assert(
        fc.asyncProperty(planArb, async (plan) => {
          const scene = await sceneIn(db);
          const expected: ExpectedEvent[] = [];

          for (const op of plan.ops) {
            switch (op.kind) {
              case 'invoice': {
                const id = await approveInvoiceOn(connection, scene, op.amount);
                expected.push({ name: 'invoice.approved.v1', marker: id, amount: op.amount });
                seen.invoice += 1;
                break;
              }
              case 'bill': {
                const id = await approveBillOn(connection, scene, op.amount);
                expected.push({ name: 'bill.approved.v1', marker: id, amount: op.amount });
                seen.bill += 1;
                break;
              }
              case 'payment_received': {
                const id = await recordPaymentOn(connection, scene, 'received', op.amount);
                expected.push({ name: 'payment.recorded.v1', marker: id, amount: op.amount });
                seen.payment_received += 1;
                break;
              }
              case 'payment_made': {
                const id = await recordPaymentOn(connection, scene, 'made', op.amount);
                expected.push({ name: 'payment.recorded.v1', marker: id, amount: op.amount });
                seen.payment_made += 1;
                break;
              }
            }
          }

          if (plan.reconcile) {
            const id = await finaliseReconciliationOn(connection, scene);
            expected.push({ name: 'reconciliation.finalised.v1', marker: id, amount: undefined });
            seen.reconciliation += 1;
          }

          const rows = await readEventLog(db.app, scene.orgId);

          // The headline: exactly one row per committed operation, nothing more
          // (mutation 3) and nothing missing.
          expect(rows).toHaveLength(expected.length);

          // Gapless, strictly increasing, from 1 (mutation 2) — every call here ran
          // sequentially on one connection, so position order and call order must
          // coincide.
          expect(rows.map((row) => row.position.toString())).toEqual(
            expected.map((_, index) => String(index + 1)),
          );

          expected.forEach((exp, index) => {
            const row = rows[index];
            if (row === undefined) {
              throw new Error(`Missing event_log row at index ${String(index)}.`);
            }

            expect(row.name, `event ${String(index)}`).toBe(exp.name);
            expect(row.actorType).toBe('user');
            expect(row.actorId).toBe(scene.ctx.actorId);

            const payload = row.payload as Record<
              | 'invoiceId'
              | 'contactId'
              | 'date'
              | 'journalId'
              | 'total'
              | 'billId'
              | 'paymentId'
              | 'amount'
              | 'sessionId'
              | 'bankAccountId'
              | 'clearedThrough',
              unknown
            >;

            // `reconciliation.finalised.v1` posts nothing (D-50) and carries no
            // `contactId`/`journalId`/amount — a different shape from the other
            // three, which all name the journal an approval or a payment posted.
            switch (exp.name) {
              case 'invoice.approved.v1':
                expect(payload.invoiceId).toBe(exp.marker);
                expect(payload.contactId).toBe(scene.contactUuid);
                expect(payload.date).toBe(OP_DATE);
                expect(typeof payload.journalId).toBe('string');
                expect(payload.total).toBe(exp.amount?.toString());
                break;
              case 'bill.approved.v1':
                expect(payload.billId).toBe(exp.marker);
                expect(payload.contactId).toBe(scene.contactUuid);
                expect(payload.date).toBe(OP_DATE);
                expect(typeof payload.journalId).toBe('string');
                expect(payload.total).toBe(exp.amount?.toString());
                break;
              case 'payment.recorded.v1':
                expect(payload.paymentId).toBe(exp.marker);
                expect(payload.contactId).toBe(scene.contactUuid);
                expect(payload.date).toBe(OP_DATE);
                expect(typeof payload.journalId).toBe('string');
                expect(payload.amount).toBe(exp.amount?.toString());
                break;
              case 'reconciliation.finalised.v1':
                expect(payload.sessionId).toBe(exp.marker);
                expect(payload.bankAccountId).toBe(scene.bankAccountUuid);
                expect(payload.clearedThrough).toBe(OP_DATE);
                break;
              default:
                throw new Error(`Unexpected event name: ${exp.name}`);
            }
          });
        }),
        { numRuns: 12 },
      );
    } finally {
      await connection.close();
    }

    // The generator has to actually reach every emit site, or this proves
    // nothing about three of the four (`balance-sheet.test.ts`'s coverage
    // discipline, restated here).
    expect(seen.invoice).toBeGreaterThan(0);
    expect(seen.bill).toBeGreaterThan(0);
    expect(seen.payment_received).toBeGreaterThan(0);
    expect(seen.payment_made).toBeGreaterThan(0);
    expect(seen.reconciliation).toBeGreaterThan(0);
  }, 180_000);
});

// ---------------------------------------------------------------------------
// F7 — the rollback half, forced concretely (mutation 1)
// ---------------------------------------------------------------------------

describe('F7 — an event exists if and only if its change committed (D-56)', () => {
  it('a rolled-back approval leaves the outbox untouched', async () => {
    const scene = await sceneIn(db);
    const connection = await db.openAppConnection();

    try {
      const draft = await transactionOn(connection, scene.ctx, () =>
        createInvoice({
          contactId: scene.contactUuid,
          issueDate: OP_DATE,
          taxMode: 'exclusive',
          lines: [
            {
              description: 'Consulting',
              quantity: '1',
              unitAmount: '20000',
              accountId: scene.revenue.uuid,
            },
          ],
        }),
      ).promise;

      // Parked *after* `approveInvoice` returned: the journal is posted, the
      // document records it, `emitEvent` has appended the row — and none of it is
      // committed. This is exactly the window `outbox.ts`'s header describes: the
      // insert is "two more statements in the caller's transaction", so a rollback
      // of the caller's transaction takes the event with it, the same way it takes
      // the journal and the document's own write.
      const attempt = parkedTransactionOn(connection, scene.ctx, () => approveInvoice(draft.id));
      await attempt.parked;

      // Read from a connection that is not the one holding the uncommitted write —
      // an uncommitted row read from `connection` itself would not be evidence of
      // anything (`test/enforcement/support.ts`'s own argument).
      expect(await readEventLog(db.app, scene.orgId)).toHaveLength(0);

      // A failure downstream of the approval — a failing idempotency claim is the
      // real one — aborts the transaction.
      attempt.rollback(new Error('forced failure after approval, before commit'));
      await expect(attempt.promise).rejects.toThrow('forced failure');

      // Nothing survived: not the journal, not the approval, and — the point of
      // this test — not the outbox row either. Under mutation 1 (the write reaching
      // its own connection, or a subscriber notified synchronously) this is exactly
      // where the surviving evidence would show up.
      expect(await readEventLog(db.app, scene.orgId)).toHaveLength(0);

      // And the draft is still approvable, producing exactly one event this time —
      // proving the rollback undid the approval's state too, not only the event.
      await transactionOn(connection, scene.ctx, () => approveInvoice(draft.id)).promise;
      const rows = await readEventLog(db.app, scene.orgId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.name).toBe('invoice.approved.v1');
      expect(rows[0]?.position.toString()).toBe('1');
    } finally {
      await connection.close();
    }
  });
});

// ---------------------------------------------------------------------------
// F8 (position side) — contention proofs (CLAUDE.md: prove it, don't assume it)
// ---------------------------------------------------------------------------

describe('two emits racing the same org’s event_positions counter (D-56, D-14 pattern)', () => {
  it('serialize on the FOR UPDATE claim and produce consecutive, gapless positions', async () => {
    const org = await orgIn(db);
    const first = await db.openAppConnection();
    const second = await db.openAppConnection();

    try {
      expect(await connectionId(first.db)).not.toBe(await connectionId(second.db));

      const markerA = newUuid();
      const markerB = newUuid();

      // The winner has allocated position 1 and written its row, uncommitted, and
      // holds `event_positions`' row lock.
      const winner = parkedTransactionOn(first, org.ctx, () =>
        emitEvent(markedInvoiceApprovedInput(org.orgUuid, org.ctx, markerA, 100n), org.ctx),
      );
      await winner.parked;

      const loser = transactionOn(second, org.ctx, () =>
        emitEvent(markedInvoiceApprovedInput(org.orgUuid, org.ctx, markerB, 200n), org.ctx),
      );
      await delay(CONTENTION_WAIT_MS);

      // `allocateEventPosition` reads the counter `FOR UPDATE`, and the winner is
      // holding it — this is what mutation 2 (a stuck or unlocked counter) would
      // remove: without the claim, the loser would not block here at all.
      expect(loser.hasSettled()).toBe(false);

      winner.commit();
      await winner.promise;
      await loser.promise;

      const rows = await readEventLog(db.app, org.orgId);
      expect(rows.map((row) => row.position.toString())).toEqual(['1', '2']);
      expect((rows[0]?.payload as Record<'invoiceId', unknown>).invoiceId).toBe(markerA);
      expect((rows[1]?.payload as Record<'invoiceId', unknown>).invoiceId).toBe(markerB);
    } finally {
      await first.close();
      await second.close();
    }
  });
});

describe('two orgs emitting at once (independent event_positions rows, D-56)', () => {
  it('one org’s parked emit does not block a different org’s', async () => {
    const orgA = await orgIn(db);
    const orgB = await orgIn(db);
    const first = await db.openAppConnection();
    const second = await db.openAppConnection();

    try {
      const markerA = newUuid();
      const parkedA = parkedTransactionOn(first, orgA.ctx, () =>
        emitEvent(markedInvoiceApprovedInput(orgA.orgUuid, orgA.ctx, markerA, 100n), orgA.ctx),
      );
      await parkedA.parked;

      const markerB = newUuid();
      const attemptB = transactionOn(second, orgB.ctx, () =>
        emitEvent(markedInvoiceApprovedInput(orgB.orgUuid, orgB.ctx, markerB, 200n), orgB.ctx),
      );
      await delay(CONTENTION_WAIT_MS);

      // Unlike the same-org case above, `event_positions` holds a *different* row
      // for org B — D-56's "per-org, not global" ordering, proved rather than
      // assumed: org B's emit is not blocked by org A's still-open transaction.
      expect(attemptB.hasSettled()).toBe(true);
      await attemptB.promise;

      parkedA.commit();
      await parkedA.promise;

      expect(await readEventLog(db.app, orgA.orgId)).toHaveLength(1);
      expect(await readEventLog(db.app, orgB.orgId)).toHaveLength(1);
    } finally {
      await first.close();
      await second.close();
    }
  });
});
