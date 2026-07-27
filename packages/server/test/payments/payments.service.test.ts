import { beforeEach, describe, expect, it } from 'vitest';

import { toWireError } from '../../src/errors';
import {
  getPayment,
  listPayments,
  recordPayment,
  updatePayment,
  voidPayment,
} from '../../src/modules/payments';
import { newUuid, SYSTEM_ROLE_UUIDS } from '../db';
import type { Scene } from './support';
import {
  accountBalance,
  contextWithoutUser,
  documentIn,
  memberIn,
  outstandingOf,
  readLedgerState,
  sceneIn,
  useServiceDatabase,
  withContext,
} from './support';

/**
 * Recording, reading and voiding a payment (OB-064; ROADMAP D-37).
 *
 * The claims this file is here to make, in the order they are argued:
 *
 *  - a payment posts one balanced journal, and the allocation that may follow
 *    posts none (D-37)
 *  - what a payment has left is derived, not stored (D-34), and an unapplied
 *    remainder is credit on the contact (C4)
 *  - **over-paying is fine**, which is the half of D-37's asymmetry that lives
 *    here; over-allocating is refused in `allocations.service.test.ts`
 *  - voiding reverses the journal and unwinds every allocation the payment made,
 *    so the documents it touched are outstanding again
 */
const db = useServiceDatabase();

let s: Scene;

beforeEach(async () => {
  s = await sceneIn(db);
});

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    direction: 'received' as const,
    contactId: s.contact.uuid,
    date: s.date,
    amount: '10000',
    accountId: s.bank.uuid,
    ...overrides,
  };
}

describe('recording a payment', () => {
  it('posts one balanced journal: bank debited, receivables credited', async () => {
    const before = await readLedgerState(db.app, s.orgId);

    const payment = await withContext(s.ctx, () =>
      recordPayment(receipt({ reference: 'BACS 8812', memo: 'March receipts' }), s.ctx),
    );

    expect(payment).toMatchObject({
      direction: 'received',
      contactId: s.contact.uuid,
      date: s.date,
      amount: '10000',
      accountId: s.bank.uuid,
      reference: 'BACS 8812',
      memo: 'March receipts',
      status: 'recorded',
      voidJournalId: null,
      allocations: [],
    });
    // Nothing is allocated, so the whole receipt is credit on the contact (C4).
    expect(payment.settlement).toEqual({ allocated: '0', outstanding: '10000' });

    const after = await readLedgerState(db.app, s.orgId);
    expect(after.journals).toBe(before.journals + 1);
    expect(after.journalLines).toBe(before.journalLines + 2);
    expect(await accountBalance(db.app, s.bank.id)).toBe(10000n);
    // Credited, which is what makes the later allocation post nothing: the control
    // account is already carrying the receipt.
    expect(await accountBalance(db.app, s.receivable.id)).toBe(-10000n);
  });

  it('posts the mirror for money going out', async () => {
    await withContext(s.ctx, () =>
      recordPayment(receipt({ direction: 'made', amount: '25000' }), s.ctx),
    );

    expect(await accountBalance(db.app, s.bank.id)).toBe(-25000n);
    expect(await accountBalance(db.app, s.payable.id)).toBe(25000n);
  });

  it('applies allocations in the same transaction as the money', async () => {
    const invoice = await documentIn(db, s, 'invoice', { amountMinor: 10000n });

    const payment = await withContext(s.ctx, () =>
      recordPayment(
        receipt({
          allocations: [{ targetType: 'invoice', targetId: invoice.uuid, amount: '10000' }],
        }),
        s.ctx,
      ),
    );

    expect(payment.settlement).toEqual({ allocated: '10000', outstanding: '0' });
    expect(payment.allocations).toHaveLength(1);
    expect(payment.allocations[0]).toMatchObject({
      sourceType: 'payment',
      sourceId: payment.id,
      // A payment is money moving, not a numbered document (D-36).
      sourceNumber: null,
      targetType: 'invoice',
      targetId: invoice.uuid,
      amount: '10000',
      // Defaulted to the payment's own date, not to today (D-40).
      date: s.date,
    });
    expect(await outstandingOf(db.app, 'invoice', invoice.id)).toBe(0n);
  });

  it('over-paying is fine and lands as credit on the contact (C4)', async () => {
    const invoice = await documentIn(db, s, 'invoice', { amountMinor: 10000n });

    const payment = await withContext(s.ctx, () =>
      recordPayment(
        receipt({
          amount: '15000',
          allocations: [{ targetType: 'invoice', targetId: invoice.uuid, amount: '10000' }],
        }),
        s.ctx,
      ),
    );

    // The invoice is settled and 50.00 is still available — the asymmetry D-37
    // calls the point: over-allocating a document is refused, over-paying is not.
    expect(payment.settlement).toEqual({ allocated: '10000', outstanding: '5000' });
    expect(await outstandingOf(db.app, 'invoice', invoice.id)).toBe(0n);

    // And that remainder is findable, which is what makes it a credit balance
    // rather than a rounding error nobody can spend.
    const page = await withContext(s.ctx, () =>
      listPayments({ unallocatedOnly: true, contactId: s.contact.uuid }, s.ctx),
    );
    expect(page.items.map((item) => item.id)).toEqual([payment.id]);
  });

  it('refuses an amount that is not positive', async () => {
    await expect(
      withContext(s.ctx, () => recordPayment(receipt({ amount: '0' }), s.ctx)),
    ).rejects.toMatchObject({ code: 'validation_failed' });

    await expect(
      withContext(s.ctx, () => recordPayment(receipt({ amount: '-100' }), s.ctx)),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('refuses a decimal amount, because the wire carries cents (D-13)', async () => {
    await expect(
      withContext(s.ctx, () => recordPayment(receipt({ amount: '100.00' }), s.ctx)),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('refuses an org that has nominated no receivables control account', async () => {
    // Cleared rather than deleted: `fk_oas_receivable` is RESTRICT, so a nominated
    // account cannot be deleted out from under the org that posts to it — which is
    // the point of the constraint and is asserted in `test/settings`.
    await db.app
      .updateTable('org_accounting_settings')
      .set({ receivable_control_account_id: null })
      .where('org_id', '=', s.orgId)
      .execute();

    const error = await withContext(s.ctx, () => recordPayment(receipt(), s.ctx)).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(toWireError(error)).toMatchObject({
      code: 'precondition_failed',
      details: { precondition: 'receivable_control_account_not_set' },
    });
    // And nothing was written: the refusal happens before the journal is posted.
    expect(await readLedgerState(db.app, s.orgId)).toMatchObject({ journals: 0, payments: 0 });
  });

  it('refuses a caller with no user identity to attribute it to', async () => {
    const ctx = contextWithoutUser(s.orgUuid, SYSTEM_ROLE_UUIDS.owner);

    await expect(withContext(ctx, () => recordPayment(receipt(), ctx))).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });

  it('refuses a date outside an open period, and writes nothing (A4)', async () => {
    await expect(
      withContext(s.ctx, () => recordPayment(receipt({ date: '2020-06-01' }), s.ctx)),
    ).rejects.toMatchObject({ code: 'precondition_failed' });

    expect(await readLedgerState(db.app, s.orgId)).toMatchObject({ journals: 0, payments: 0 });
  });
});

describe('reading a payment', () => {
  it('answers a payment in another org exactly as it answers one that never existed', async () => {
    const elsewhere = await sceneIn(db);
    const theirs = await withContext(elsewhere.ctx, () =>
      recordPayment(
        {
          direction: 'received',
          contactId: elsewhere.contact.uuid,
          date: elsewhere.date,
          amount: '10000',
          accountId: elsewhere.bank.uuid,
        },
        elsewhere.ctx,
      ),
    );

    const crossOrg = await withContext(s.ctx, () => getPayment(theirs.id, s.ctx)).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    const nonexistent = await withContext(s.ctx, () => getPayment(newUuid(), s.ctx)).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    const malformed = await withContext(s.ctx, () => getPayment('not-a-uuid', s.ctx)).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    // A7: byte-identical, not merely the same status.
    expect(toWireError(crossOrg)).toEqual(toWireError(nonexistent));
    expect(toWireError(malformed)).toEqual(toWireError(nonexistent));
    expect(toWireError(nonexistent)).toMatchObject({ code: 'not_found', status: 404 });
  });
});

describe('listing payments', () => {
  beforeEach(async () => {
    await withContext(s.ctx, async () => {
      await recordPayment(receipt({ amount: '10000' }), s.ctx);
      await recordPayment(receipt({ direction: 'made', amount: '20000' }), s.ctx);
      await recordPayment(receipt({ amount: '30000', contactId: s.other.uuid }), s.ctx);
    });
  });

  it('filters by direction and by contact', async () => {
    const received = await withContext(s.ctx, () => listPayments({ direction: 'received' }, s.ctx));
    expect(received.items.map((item) => item.amount)).toEqual(['10000', '30000']);

    const byContact = await withContext(s.ctx, () =>
      listPayments({ contactId: s.other.uuid }, s.ctx),
    );
    expect(byContact.items.map((item) => item.amount)).toEqual(['30000']);
  });

  it('refuses an unfiltered list to a caller who may read only one side', async () => {
    // AR-only holds `payments_received.read` and not `payments_made.read`, so a
    // list spanning both is refused rather than silently returning half — the
    // failure mode `hasPermission`'s own commentary warns about.
    const arOnly = await memberIn(db, s, 'arOnly');

    await expect(withContext(arOnly, () => listPayments({}, arOnly))).rejects.toMatchObject({
      code: 'permission_denied',
      details: { permission: 'payments_made.read' },
    });

    const mine = await withContext(arOnly, () => listPayments({ direction: 'received' }, arOnly));
    expect(mine.items).toHaveLength(2);
  });
});

describe('updating a payment', () => {
  it('changes the text and nothing the journal carries', async () => {
    const payment = await withContext(s.ctx, () => recordPayment(receipt(), s.ctx));

    const updated = await withContext(s.ctx, () =>
      updatePayment(payment.id, { reference: 'CHQ 41', memo: null }, s.ctx),
    );

    expect(updated).toMatchObject({
      reference: 'CHQ 41',
      memo: null,
      amount: payment.amount,
      date: payment.date,
      accountId: payment.accountId,
      journalId: payment.journalId,
    });
  });
});

describe('voiding a payment', () => {
  it('reverses the journal, unwinds its allocations, and leaves both visible', async () => {
    const invoice = await documentIn(db, s, 'invoice', { amountMinor: 10000n });
    const payment = await withContext(s.ctx, () =>
      recordPayment(
        receipt({
          allocations: [{ targetType: 'invoice', targetId: invoice.uuid, amount: '10000' }],
        }),
        s.ctx,
      ),
    );
    expect(await outstandingOf(db.app, 'invoice', invoice.id)).toBe(0n);

    const voided = await withContext(s.ctx, () =>
      voidPayment(payment.id, { date: s.date, memo: 'Cheque bounced' }, s.ctx),
    );

    expect(voided.status).toBe('void');
    expect(voided.voidJournalId).not.toBeNull();
    // The payment and its journal are both still there — void is a reversal, never
    // a deletion (D-16, D-38).
    expect(voided.journalId).toBe(payment.journalId);
    expect(voided.allocations).toEqual([]);
    expect(voided.settlement).toEqual({ allocated: '0', outstanding: '0' });

    // The invoice is owed again, and the ledger says the same thing: the reversal
    // put the amount back on the control account.
    expect(await outstandingOf(db.app, 'invoice', invoice.id)).toBe(10000n);
    expect(await accountBalance(db.app, s.bank.id)).toBe(0n);
    expect(await accountBalance(db.app, s.receivable.id)).toBe(10000n);

    const state = await readLedgerState(db.app, s.orgId);
    // Three journals: the invoice's, the payment's, and the reversal.
    expect(state).toMatchObject({ journals: 3, payments: 1, arAllocations: 0 });
  });

  it('refuses a second void', async () => {
    const payment = await withContext(s.ctx, () => recordPayment(receipt(), s.ctx));
    await withContext(s.ctx, () => voidPayment(payment.id, { date: s.date }, s.ctx));

    const error = await withContext(s.ctx, () =>
      voidPayment(payment.id, { date: s.date }, s.ctx),
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(toWireError(error)).toMatchObject({
      code: 'precondition_failed',
      details: { precondition: 'payment_already_void' },
    });
  });

  it('leaves a voided payment out of the unallocated list', async () => {
    const payment = await withContext(s.ctx, () => recordPayment(receipt(), s.ctx));
    await withContext(s.ctx, () => voidPayment(payment.id, { date: s.date }, s.ctx));

    const page = await withContext(s.ctx, () => listPayments({ unallocatedOnly: true }, s.ctx));
    expect(page.items).toEqual([]);
  });
});

describe('who may record a payment', () => {
  it('refuses a read-only caller with the key it lacks', async () => {
    const readOnly = await sceneIn(db, 'readOnly');

    await expect(
      withContext(readOnly.ctx, () =>
        recordPayment(
          {
            direction: 'received',
            contactId: readOnly.contact.uuid,
            date: readOnly.date,
            amount: '10000',
            accountId: readOnly.bank.uuid,
          },
          readOnly.ctx,
        ),
      ),
    ).rejects.toMatchObject({
      code: 'permission_denied',
      details: { permission: 'payments_received.write' },
    });
  });

  it('refuses an AR clerk a payment on the payables side', async () => {
    const arOnly = await sceneIn(db, 'arOnly');

    await expect(
      withContext(arOnly.ctx, () =>
        recordPayment(
          {
            direction: 'made',
            contactId: arOnly.contact.uuid,
            date: arOnly.date,
            amount: '10000',
            accountId: arOnly.bank.uuid,
          },
          arOnly.ctx,
        ),
      ),
    ).rejects.toMatchObject({
      code: 'permission_denied',
      details: { permission: 'payments_made.write' },
    });
  });

  /**
   * **A finding, pinned rather than worked around.**
   *
   * The seeded `ar_only` role holds `payments_received.write` and does *not* hold
   * `journals.post` (`0001_tenancy`). Recording a payment posts a journal, and
   * `postJournal` checks `journals.post` against the caller's own context — so an
   * AR clerk holding exactly the permission named for the job is refused one layer
   * down, on a key nobody handed them.
   *
   * This is not something OB-064 may fix. Widening the role is a migration and a
   * matrix change (known gap 6, OB-072); posting under a borrowed authority would
   * make `journals.post` mean nothing. So the current behaviour is asserted here,
   * where a change to it is a visible test edit rather than a silent one.
   */
  it('refuses an AR clerk their own receipt, at journals.post — known gap', async () => {
    const arOnly = await sceneIn(db, 'arOnly');

    await expect(
      withContext(arOnly.ctx, () =>
        recordPayment(
          {
            direction: 'received',
            contactId: arOnly.contact.uuid,
            date: arOnly.date,
            amount: '10000',
            accountId: arOnly.bank.uuid,
          },
          arOnly.ctx,
        ),
      ),
    ).rejects.toMatchObject({
      code: 'permission_denied',
      details: { permission: 'journals.post' },
    });
  });
});
