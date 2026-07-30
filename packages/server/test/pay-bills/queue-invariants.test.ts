import { beforeEach, describe, expect, it } from 'vitest';

import {
  buildPendingPayment,
  cancelPendingPayment,
  listPayableBills,
} from '../../src/modules/pay-bills';
import type { ApDocumentFixture, PbScene } from './support';
import { countJournals, documentIn, sceneIn, useServiceDatabase } from './support';

/**
 * The queue's cheap invariants (OB-117, C): D-64's "pencil" claim and D-68's
 * `availableToPay` arithmetic, without a race — these hold sequentially, unlike
 * the double-commit guard in `queue-contention.race.test.ts`.
 */
const db = useServiceDatabase();

let s: PbScene;
let bill: ApDocumentFixture;

beforeEach(async () => {
  s = await sceneIn(db);
  bill = await documentIn(db, s, 'bill', 100_000n);
});

function payableBillRow(bills: Awaited<ReturnType<typeof listPayableBills>>, billId: string) {
  const row = bills.bills.find((candidate) => candidate.billId === billId);
  if (row === undefined) {
    throw new Error(`Expected the Pay Bills window to carry bill ${billId}.`);
  }
  return row;
}

describe('availableToPay after a partial queue', () => {
  it('equals outstanding minus committed', async () => {
    await buildPendingPayment(
      {
        contactId: s.vendorUuid,
        bankAccountId: s.bankAccountUuid,
        rail: 'check',
        intents: [{ billId: bill.uuid, payAmount: '40000' }],
      },
      s.ctx,
    );

    const window = await listPayableBills(s.ctx);
    const row = payableBillRow(window, bill.uuid);

    expect(row.outstanding).toBe('100000');
    expect(row.committed).toBe('40000');
    expect(row.availableToPay).toBe('60000');
  });
});

describe('cancelling an open pending payment', () => {
  it('frees the committed amount with no ledger correction', async () => {
    const before = await countJournals(db.app, s.orgId);

    const pending = await buildPendingPayment(
      {
        contactId: s.vendorUuid,
        bankAccountId: s.bankAccountUuid,
        rail: 'check',
        intents: [{ billId: bill.uuid, payAmount: '40000' }],
      },
      s.ctx,
    );

    const committedRow = payableBillRow(await listPayableBills(s.ctx), bill.uuid);
    expect(committedRow.committed).toBe('40000');
    expect(committedRow.availableToPay).toBe('60000');

    const cancelled = await cancelPendingPayment(pending.id, s.ctx);
    expect(cancelled.status).toBe('cancelled');

    // Building the pending payment posted no journal (D-64: pencil until issue),
    // and cancelling it does not post a correction either — there is nothing to
    // correct.
    expect(await countJournals(db.app, s.orgId)).toBe(before);

    const freedRow = payableBillRow(await listPayableBills(s.ctx), bill.uuid);
    expect(freedRow.committed).toBe('0');
    // Back to the bill's original, uncommitted availability.
    expect(freedRow.availableToPay).toBe('100000');
    expect(freedRow.outstanding).toBe('100000');
  });
});
