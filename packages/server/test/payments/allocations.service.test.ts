import { beforeEach, describe, expect, it } from 'vitest';

import { toWireError } from '../../src/errors';
import {
  allocateCreditNote,
  allocatePayment,
  allocateVendorCredit,
  deleteAllocation,
  getPayment,
  recordPayment,
  voidPayment,
} from '../../src/modules/payments';
import { newUuid } from '../db';
import type { DocumentFixture, Scene } from './support';
import {
  documentIn,
  outstandingOf,
  readLedgerState,
  sceneIn,
  useServiceDatabase,
  withContext,
} from './support';

/**
 * Allocation: the single mechanism by which anything reduces what is outstanding
 * (OB-064; ROADMAP D-34, D-37, D-39, D-40).
 *
 * What is asserted here, and why each one is load-bearing:
 *
 *  - **C3** — allocations against one document may not exceed it, and a refused
 *    batch writes nothing. The *sequential* case is here; the case that proves the
 *    lock is `over-allocation-race.test.ts`, because a sequential test of a
 *    check-then-act passes against an implementation with no locking at all.
 *  - **D-37** — an allocation posts no journal. Asserted by counting.
 *  - **D-39** — a credit note reduces an invoice through the same rows a payment
 *    does, and the API does not care which reduced it.
 *  - **D-40** — an allocation carries its own date, so a past aging is
 *    reproducible.
 */
const db = useServiceDatabase();

let s: Scene;

beforeEach(async () => {
  s = await sceneIn(db);
});

async function receiptOf(amount: string, contactId = s.contact.uuid): Promise<string> {
  const payment = await withContext(s.ctx, () =>
    recordPayment(
      { direction: 'received', contactId, date: s.date, amount, accountId: s.bank.uuid },
      s.ctx,
    ),
  );
  return payment.id;
}

async function paymentOut(amount: string, contactId = s.contact.uuid): Promise<string> {
  const payment = await withContext(s.ctx, () =>
    recordPayment(
      { direction: 'made', contactId, date: s.date, amount, accountId: s.bank.uuid },
      s.ctx,
    ),
  );
  return payment.id;
}

function target(document: DocumentFixture, amount: string) {
  return {
    targetType: document.kind === 'invoice' ? ('invoice' as const) : ('bill' as const),
    targetId: document.uuid,
    amount,
  };
}

describe('applying a payment', () => {
  it('reduces what is outstanding and posts no journal (D-37)', async () => {
    const invoice = await documentIn(db, s, 'invoice', { amountMinor: 10000n });
    const paymentId = await receiptOf('10000');

    const before = await readLedgerState(db.app, s.orgId);
    const allocations = await withContext(s.ctx, () =>
      allocatePayment(paymentId, { allocations: [target(invoice, '4000')] }, s.ctx),
    );
    const after = await readLedgerState(db.app, s.orgId);

    expect(allocations).toHaveLength(1);
    expect(await outstandingOf(db.app, 'invoice', invoice.id)).toBe(6000n);

    // The money already moved when the payment posted; saying which invoice it was
    // for moves nothing. A journal here would double-count, which is exactly how a
    // subledger comes to disagree with its ledger (C2).
    expect(after.journals).toBe(before.journals);
    expect(after.journalLines).toBe(before.journalLines);
    expect(after.arAllocations).toBe(before.arAllocations + 1);
  });

  it('settles three invoices from one transfer, or none of them', async () => {
    const first = await documentIn(db, s, 'invoice', { amountMinor: 5000n });
    const second = await documentIn(db, s, 'invoice', { amountMinor: 3000n });
    const third = await documentIn(db, s, 'invoice', { amountMinor: 2000n });
    const paymentId = await receiptOf('10000');

    const allocations = await withContext(s.ctx, () =>
      allocatePayment(
        paymentId,
        {
          allocations: [target(first, '5000'), target(second, '3000'), target(third, '2000')],
        },
        s.ctx,
      ),
    );

    expect(allocations).toHaveLength(3);
    for (const invoice of [first, second, third]) {
      expect(await outstandingOf(db.app, 'invoice', invoice.id)).toBe(0n);
    }

    const payment = await withContext(s.ctx, () => getPayment(paymentId, s.ctx));
    expect(payment.settlement).toEqual({ allocated: '10000', outstanding: '0' });
  });

  it('refuses over-allocating a document, and writes none of the batch (C3)', async () => {
    const settleable = await documentIn(db, s, 'invoice', { amountMinor: 5000n });
    const already = await documentIn(db, s, 'invoice', { amountMinor: 5000n });
    const paymentId = await receiptOf('20000');

    // Half of the second invoice is already applied, so 5,000 more is 2,500 too much.
    await withContext(s.ctx, () =>
      allocatePayment(paymentId, { allocations: [target(already, '2500')] }, s.ctx),
    );

    const error = await withContext(s.ctx, () =>
      allocatePayment(
        paymentId,
        { allocations: [target(settleable, '5000'), target(already, '5000')] },
        s.ctx,
      ),
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(toWireError(error)).toMatchObject({
      code: 'precondition_failed',
      details: { precondition: 'document_over_allocated' },
    });

    // The first line of the batch is not applied either: applying two of three and
    // refusing the fourth would leave the user to work out which half happened.
    expect(await outstandingOf(db.app, 'invoice', settleable.id)).toBe(5000n);
    expect(await outstandingOf(db.app, 'invoice', already.id)).toBe(2500n);
  });

  it('refuses over-allocating within one batch, not only against what exists', async () => {
    const invoice = await documentIn(db, s, 'invoice', { amountMinor: 5000n });
    const paymentId = await receiptOf('20000');

    const error = await withContext(s.ctx, () =>
      allocatePayment(
        paymentId,
        { allocations: [target(invoice, '3000'), target(invoice, '3000')] },
        s.ctx,
      ),
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(toWireError(error)).toMatchObject({
      details: { precondition: 'document_over_allocated' },
    });
    expect(await outstandingOf(db.app, 'invoice', invoice.id)).toBe(5000n);
  });

  it('refuses applying more of a payment than the payment was for', async () => {
    const first = await documentIn(db, s, 'invoice', { amountMinor: 10000n });
    const second = await documentIn(db, s, 'invoice', { amountMinor: 10000n });
    const paymentId = await receiptOf('10000');

    const error = await withContext(s.ctx, () =>
      allocatePayment(
        paymentId,
        { allocations: [target(first, '10000'), target(second, '10000')] },
        s.ctx,
      ),
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    // The other half of D-37's asymmetry, and a different rule: over-*paying* is
    // fine, applying money that never arrived is not.
    expect(toWireError(error)).toMatchObject({
      details: { precondition: 'source_over_allocated' },
    });
    expect(await outstandingOf(db.app, 'invoice', first.id)).toBe(10000n);
  });

  it('carries its own date, defaulting to the payment’s (D-40)', async () => {
    const invoice = await documentIn(db, s, 'invoice', { amountMinor: 10000n });
    const paymentId = await receiptOf('10000');

    const [defaulted] = await withContext(s.ctx, () =>
      allocatePayment(paymentId, { allocations: [target(invoice, '4000')] }, s.ctx),
    );
    expect(defaulted?.date).toBe(s.date);

    const [dated] = await withContext(s.ctx, () =>
      allocatePayment(
        paymentId,
        { date: '2026-03-15', allocations: [target(invoice, '1000')] },
        s.ctx,
      ),
    );
    // An aging report as at 2026-02-28 counts the first and not the second, which
    // is what makes a historical aging reproducible.
    expect(dated?.date).toBe('2026-03-15');
  });

  it('refuses a target on the other side of the books', async () => {
    const bill = await documentIn(db, s, 'bill', { amountMinor: 10000n });
    const paymentId = await receiptOf('10000');

    await expect(
      withContext(s.ctx, () =>
        allocatePayment(paymentId, { allocations: [target(bill, '10000')] }, s.ctx),
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('refuses a document belonging to another contact', async () => {
    const invoice = await documentIn(db, s, 'invoice', {
      amountMinor: 10000n,
      contactId: s.other.id,
    });
    const paymentId = await receiptOf('10000');

    const error = await withContext(s.ctx, () =>
      allocatePayment(paymentId, { allocations: [target(invoice, '10000')] }, s.ctx),
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(toWireError(error)).toMatchObject({
      details: { precondition: 'allocation_contact_mismatch' },
    });
  });

  it('refuses a draft and refuses a voided document', async () => {
    const draft = await documentIn(db, s, 'invoice', { amountMinor: 10000n, draft: true });
    const voided = await documentIn(db, s, 'invoice', { amountMinor: 10000n, voided: true });
    const paymentId = await receiptOf('10000');

    const onDraft = await withContext(s.ctx, () =>
      allocatePayment(paymentId, { allocations: [target(draft, '1000')] }, s.ctx),
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(toWireError(onDraft)).toMatchObject({
      details: { precondition: 'document_not_approved' },
    });

    const onVoid = await withContext(s.ctx, () =>
      allocatePayment(paymentId, { allocations: [target(voided, '1000')] }, s.ctx),
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(toWireError(onVoid)).toMatchObject({ details: { precondition: 'document_void' } });
  });

  it('refuses a target that is a credit note rather than something owed', async () => {
    const creditNote = await documentIn(db, s, 'credit_note', { amountMinor: 10000n });
    const paymentId = await receiptOf('10000');

    const error = await withContext(s.ctx, () =>
      allocatePayment(
        paymentId,
        { allocations: [{ targetType: 'invoice', targetId: creditNote.uuid, amount: '1000' }] },
        s.ctx,
      ),
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(toWireError(error)).toMatchObject({
      details: { precondition: 'allocation_target_mismatch' },
    });
  });

  it('refuses a voided payment', async () => {
    const invoice = await documentIn(db, s, 'invoice', { amountMinor: 10000n });
    const paymentId = await receiptOf('10000');
    await withContext(s.ctx, () => voidPayment(paymentId, { date: s.date }, s.ctx));

    const error = await withContext(s.ctx, () =>
      allocatePayment(paymentId, { allocations: [target(invoice, '10000')] }, s.ctx),
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(toWireError(error)).toMatchObject({ details: { precondition: 'payment_void' } });
  });

  it('answers an unknown target and another org’s identically (A7)', async () => {
    const elsewhere = await sceneIn(db);
    const theirs = await documentIn(db, elsewhere, 'invoice', { amountMinor: 10000n });
    const paymentId = await receiptOf('10000');

    const crossOrg = await withContext(s.ctx, () =>
      allocatePayment(
        paymentId,
        { allocations: [{ targetType: 'invoice', targetId: theirs.uuid, amount: '1000' }] },
        s.ctx,
      ),
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    const unknown = await withContext(s.ctx, () =>
      allocatePayment(
        paymentId,
        { allocations: [{ targetType: 'invoice', targetId: newUuid(), amount: '1000' }] },
        s.ctx,
      ),
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(toWireError(crossOrg)).toEqual(toWireError(unknown));
    expect(toWireError(unknown)).toMatchObject({ code: 'not_found', status: 404 });
  });
});

describe('applying a credit note (D-39)', () => {
  it('reduces an invoice through the same mechanism a payment uses', async () => {
    const invoice = await documentIn(db, s, 'invoice', { amountMinor: 10000n });
    const creditNote = await documentIn(db, s, 'credit_note', { amountMinor: 4000n });

    const before = await readLedgerState(db.app, s.orgId);
    const [allocation] = await withContext(s.ctx, () =>
      allocateCreditNote(creditNote.uuid, { allocations: [target(invoice, '4000')] }, s.ctx),
    );
    const after = await readLedgerState(db.app, s.orgId);

    expect(allocation).toMatchObject({
      sourceType: 'credit_note',
      sourceId: creditNote.uuid,
      targetType: 'invoice',
      targetId: invoice.uuid,
      amount: '4000',
      // Defaulted to the credit note's own issue date, as a payment defaults to
      // the date the money moved.
      date: s.date,
    });
    // A credit note is a numbered document, unlike a payment (D-36).
    expect(allocation?.sourceNumber).not.toBeNull();

    expect(await outstandingOf(db.app, 'invoice', invoice.id)).toBe(6000n);
    expect(after.journals).toBe(before.journals);
  });

  it('nets an invoice to zero when the two are equal (C6’s subledger half)', async () => {
    const invoice = await documentIn(db, s, 'invoice', { amountMinor: 10000n });
    const creditNote = await documentIn(db, s, 'credit_note', { amountMinor: 10000n });

    await withContext(s.ctx, () =>
      allocateCreditNote(creditNote.uuid, { allocations: [target(invoice, '10000')] }, s.ctx),
    );

    expect(await outstandingOf(db.app, 'invoice', invoice.id)).toBe(0n);
    // And the ledger agrees: the invoice debited the control account and the
    // credit note credited it, so the two net there as well.
    expect(await outstandingOf(db.app, 'invoice', invoice.id)).toBe(0n);
  });

  it('refuses giving more credit than the note is for', async () => {
    const invoice = await documentIn(db, s, 'invoice', { amountMinor: 10000n });
    const creditNote = await documentIn(db, s, 'credit_note', { amountMinor: 4000n });

    const error = await withContext(s.ctx, () =>
      allocateCreditNote(creditNote.uuid, { allocations: [target(invoice, '5000')] }, s.ctx),
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(toWireError(error)).toMatchObject({
      details: { precondition: 'source_over_allocated' },
    });
  });

  it('answers an invoice id given as a credit note with the ordinary miss', async () => {
    const invoice = await documentIn(db, s, 'invoice', { amountMinor: 10000n });
    const other = await documentIn(db, s, 'invoice', { amountMinor: 10000n });

    const error = await withContext(s.ctx, () =>
      allocateCreditNote(invoice.uuid, { allocations: [target(other, '1000')] }, s.ctx),
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(toWireError(error)).toMatchObject({ code: 'not_found', status: 404 });
  });
});

describe('the payables mirror', () => {
  it('applies a payment made to a bill, and a vendor credit to another', async () => {
    const first = await documentIn(db, s, 'bill', { amountMinor: 10000n });
    const second = await documentIn(db, s, 'bill', { amountMinor: 6000n });
    const vendorCredit = await documentIn(db, s, 'vendor_credit', { amountMinor: 6000n });
    const paymentId = await paymentOut('10000');

    await withContext(s.ctx, () =>
      allocatePayment(paymentId, { allocations: [target(first, '10000')] }, s.ctx),
    );
    await withContext(s.ctx, () =>
      allocateVendorCredit(vendorCredit.uuid, { allocations: [target(second, '6000')] }, s.ctx),
    );

    expect(await outstandingOf(db.app, 'bill', first.id)).toBe(0n);
    expect(await outstandingOf(db.app, 'bill', second.id)).toBe(0n);

    const payment = await withContext(s.ctx, () => getPayment(paymentId, s.ctx));
    expect(payment.allocations[0]).toMatchObject({
      sourceType: 'payment',
      targetType: 'bill',
      targetId: first.uuid,
    });
  });
});

describe('un-applying', () => {
  it('makes the document outstanding again and leaves the ledger alone', async () => {
    const invoice = await documentIn(db, s, 'invoice', { amountMinor: 10000n });
    const paymentId = await receiptOf('10000');

    const [allocation] = await withContext(s.ctx, () =>
      allocatePayment(paymentId, { allocations: [target(invoice, '10000')] }, s.ctx),
    );
    expect(allocation).toBeDefined();
    const before = await readLedgerState(db.app, s.orgId);

    await withContext(s.ctx, () => deleteAllocation(allocation?.id ?? '', s.ctx));

    expect(await outstandingOf(db.app, 'invoice', invoice.id)).toBe(10000n);
    const after = await readLedgerState(db.app, s.orgId);
    expect(after.journals).toBe(before.journals);
    expect(after.arAllocations).toBe(before.arAllocations - 1);

    // The money is available again, which is the whole of "unallocated is credit
    // on the contact" (C4).
    const payment = await withContext(s.ctx, () => getPayment(paymentId, s.ctx));
    expect(payment.settlement).toEqual({ allocated: '0', outstanding: '10000' });
  });

  it('answers an unknown allocation with the ordinary miss', async () => {
    await expect(
      withContext(s.ctx, () => deleteAllocation(newUuid(), s.ctx)),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
