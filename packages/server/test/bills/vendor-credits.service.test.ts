import type { CreateVendorCreditRequest } from '@openbooks/shared-types';
import { beforeEach, describe, expect, it } from 'vitest';

import { toWireError } from '../../src/errors';
import {
  approveBill,
  approveVendorCredit,
  createBill,
  createVendorCredit,
  discardVendorCredit,
  getVendorCredit,
  listVendorCredits,
  updateVendorCredit,
  voidVendorCredit,
} from '../../src/modules/bills';
import { newUuid, newUuidBuffer, uuidToBuffer } from '../db';
import type { ApScene } from './support';
import { sceneIn, useServiceDatabase, withContext } from './support';

/**
 * Vendor credits (OB-063; ROADMAP D-38, D-39).
 *
 * The lifecycle is the bill's and is asserted there; what is here is what D-39
 * says is different about being a document rather than a negative bill — its own
 * series, its own journal, no due date — plus the settlement arithmetic that
 * `documentSettlementSchema` reads the other way round on this side: `outstanding`
 * is what is still *available to apply*, not what is owed.
 */
const db = useServiceDatabase();

let s: ApScene;

beforeEach(async () => {
  s = await sceneIn(db);
});

function creditRequest(
  overrides: Partial<CreateVendorCreditRequest> = {},
): CreateVendorCreditRequest {
  return {
    contactId: s.vendorUuid,
    issueDate: s.date,
    taxMode: 'exclusive',
    lines: [
      {
        description: 'Returned goods',
        quantity: '1',
        unitAmount: '50000',
        accountId: s.expenseUuid,
      },
    ],
    ...overrides,
  };
}

async function wireErrorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (thrown: unknown) => toWireError(thrown),
  );
}

describe('a vendor credit', () => {
  it('is a draft, then approved with its own number (D-39)', async () => {
    const draft = await withContext(s.ctx, () => createVendorCredit(creditRequest(), s.ctx));
    expect(draft).toMatchObject({ documentNumber: null, status: 'draft', journalId: null });

    const approved = await withContext(s.ctx, () => approveVendorCredit(draft.id, s.ctx));
    expect(approved).toMatchObject({ documentNumber: '1', status: 'approved' });
    expect(approved.settlement).toEqual({ allocated: '0', outstanding: '50000' });
  });

  it('numbers separately from bills — the two are separate series (D-36)', async () => {
    const bill = await withContext(s.ctx, () =>
      createBill(
        {
          contactId: s.vendorUuid,
          issueDate: s.date,
          dueDate: s.date,
          taxMode: 'exclusive',
          lines: [
            { description: 'x', quantity: '1', unitAmount: '1000', accountId: s.expenseUuid },
          ],
        },
        s.ctx,
      ),
    );
    const approvedBill = await withContext(s.ctx, () => approveBill(bill.id, s.ctx));

    const credit = await withContext(s.ctx, () => createVendorCredit(creditRequest(), s.ctx));
    const approvedCredit = await withContext(s.ctx, () => approveVendorCredit(credit.id, s.ctx));

    // Both are 1. They are separate series to the people who read them, and
    // `PRIMARY KEY (org_id, document_type)` on `document_sequences` is what makes
    // that true rather than a coincidence.
    expect(approvedBill.documentNumber).toBe('1');
    expect(approvedCredit.documentNumber).toBe('1');
  });

  it('has no due date on the wire at all', async () => {
    const credit = await withContext(s.ctx, () => createVendorCredit(creditRequest(), s.ctx));

    expect(credit).not.toHaveProperty('dueDate');
    // Nothing about a credit falls due — it is allocated, not chased — so the
    // column stays NULL and `chk_ap_documents_bill_due` never applies to it.
    const row = await db.app
      .selectFrom('ap_documents')
      .select('due_date')
      .where('id', '=', uuidToBuffer(credit.id))
      .executeTakeFirst();
    expect(row?.due_date).toBeNull();
  });

  it('is edited and discarded while it is a draft, and refuses both afterwards', async () => {
    const credit = await withContext(s.ctx, () => createVendorCredit(creditRequest(), s.ctx));
    const edited = await withContext(s.ctx, () =>
      updateVendorCredit(credit.id, { memo: 'Damaged in transit' }, s.ctx),
    );
    expect(edited.memo).toBe('Damaged in transit');

    await withContext(s.ctx, () => approveVendorCredit(credit.id, s.ctx));

    expect(
      await wireErrorOf(
        withContext(s.ctx, () => updateVendorCredit(credit.id, { memo: 'no' }, s.ctx)),
      ),
    ).toMatchObject({ details: { precondition: 'document_approved' } });
    expect(
      await wireErrorOf(withContext(s.ctx, () => discardVendorCredit(credit.id, s.ctx))),
    ).toMatchObject({ details: { precondition: 'document_approved' } });
  });

  it('is voided by reversal, taking `vendor_credits.write` rather than a void code', async () => {
    const credit = await withContext(s.ctx, () => createVendorCredit(creditRequest(), s.ctx));
    const approved = await withContext(s.ctx, () => approveVendorCredit(credit.id, s.ctx));

    const voided = await withContext(s.ctx, () =>
      voidVendorCredit(credit.id, { date: s.date }, s.ctx),
    );

    expect(voided).toMatchObject({
      status: 'void',
      documentNumber: approved.documentNumber,
      journalId: approved.journalId,
    });
    expect(voided.voidJournalId).not.toBeNull();
  });

  it('reports another org’s credit as a miss with a byte-identical body (A7)', async () => {
    const other = await sceneIn(db);
    const theirs = await withContext(other.ctx, () =>
      createVendorCredit(
        {
          contactId: other.vendorUuid,
          issueDate: other.date,
          taxMode: 'exclusive',
          lines: [
            { description: 'x', quantity: '1', unitAmount: '100', accountId: other.expenseUuid },
          ],
        },
        other.ctx,
      ),
    );

    const crossOrg = await wireErrorOf(withContext(s.ctx, () => getVendorCredit(theirs.id, s.ctx)));
    const nonexistent = await wireErrorOf(
      withContext(s.ctx, () => getVendorCredit(newUuid(), s.ctx)),
    );

    expect(crossOrg).toEqual(nonexistent);
    expect(crossOrg).toMatchObject({ code: 'not_found', details: { resource: 'vendor_credit' } });
  });

  it('is not reachable by a bill id, and a bill is not reachable by its own (A7)', async () => {
    const credit = await withContext(s.ctx, () => createVendorCredit(creditRequest(), s.ctx));

    // One table, two id spaces: every read filters on `document_type`, so asking
    // for the wrong kind is a miss rather than a document of the wrong shape.
    expect(
      await wireErrorOf(withContext(s.ctx, () => getVendorCredit(newUuid(), s.ctx))),
    ).toMatchObject({ code: 'not_found' });
    expect(credit.id).not.toBe(newUuid());
  });
});

describe('the vendor-credit list', () => {
  it('shows only credits, and `unappliedOnly` hides drafts and voids', async () => {
    const bill = await withContext(s.ctx, () =>
      createBill(
        {
          contactId: s.vendorUuid,
          issueDate: s.date,
          dueDate: s.date,
          taxMode: 'exclusive',
          lines: [
            { description: 'x', quantity: '1', unitAmount: '1000', accountId: s.expenseUuid },
          ],
        },
        s.ctx,
      ),
    );
    expect(bill.id).toBeDefined();

    const draft = await withContext(s.ctx, () => createVendorCredit(creditRequest(), s.ctx));
    const approved = await withContext(s.ctx, () => createVendorCredit(creditRequest(), s.ctx));
    await withContext(s.ctx, () => approveVendorCredit(approved.id, s.ctx));

    const all = await withContext(s.ctx, () => listVendorCredits({}, s.ctx));
    expect(all.items.map((item) => item.id).sort()).toEqual([draft.id, approved.id].sort());

    // `unappliedOnly` is a filter on a computed quantity (D-34), so a draft — which
    // has told the ledger nothing and therefore has nothing available — is out.
    const unapplied = await withContext(s.ctx, () =>
      listVendorCredits({ unappliedOnly: true }, s.ctx),
    );
    expect(unapplied.items.map((item) => item.id)).toEqual([approved.id]);
  });
});

describe('an allocation against a document', () => {
  it('reduces what is outstanding and moves the status (D-34, D-38)', async () => {
    const bill = await withContext(s.ctx, () =>
      createBill(
        {
          contactId: s.vendorUuid,
          issueDate: s.date,
          dueDate: s.date,
          taxMode: 'exclusive',
          lines: [
            { description: 'x', quantity: '1', unitAmount: '10000', accountId: s.expenseUuid },
          ],
        },
        s.ctx,
      ),
    );
    const approvedBill = await withContext(s.ctx, () => approveBill(bill.id, s.ctx));

    const credit = await withContext(s.ctx, () =>
      createVendorCredit(
        creditRequest({
          lines: [
            { description: 'Return', quantity: '1', unitAmount: '4000', accountId: s.expenseUuid },
          ],
        }),
        s.ctx,
      ),
    );
    const approvedCredit = await withContext(s.ctx, () => approveVendorCredit(credit.id, s.ctx));

    // Written directly, because OB-064 owns every write to `ap_allocations` and
    // this module only reads them. What is asserted is this module's reading of
    // them, which is the half OB-063 is responsible for.
    await db.app
      .insertInto('ap_allocations')
      .values({
        id: newUuidBuffer(),
        org_id: s.orgId,
        bill_id: uuidToBuffer(approvedBill.id),
        payment_id: null,
        vendor_credit_id: uuidToBuffer(approvedCredit.id),
        amount_minor: 4000n,
        allocated_on: s.date,
        created_by_user_id: s.userId,
      })
      .execute();

    const billAfter = await withContext(s.ctx, () => getVendorCredit(approvedCredit.id, s.ctx));
    // On a credit, `outstanding` reads as "still available to apply" — the same
    // arithmetic as a bill's "still owed", which is D-39's payoff.
    expect(billAfter.settlement).toEqual({ allocated: '4000', outstanding: '0' });
    expect(billAfter.status).toBe('paid');
    expect(billAfter.allocations).toMatchObject([
      {
        sourceType: 'vendor_credit',
        sourceId: approvedCredit.id,
        sourceNumber: '1',
        targetType: 'bill',
        targetId: approvedBill.id,
        targetNumber: '1',
        amount: '4000',
      },
    ]);
  });

  it('blocks the void until it is removed', async () => {
    const bill = await withContext(s.ctx, () =>
      createBill(
        {
          contactId: s.vendorUuid,
          issueDate: s.date,
          dueDate: s.date,
          taxMode: 'exclusive',
          lines: [
            { description: 'x', quantity: '1', unitAmount: '10000', accountId: s.expenseUuid },
          ],
        },
        s.ctx,
      ),
    );
    const approvedBill = await withContext(s.ctx, () => approveBill(bill.id, s.ctx));

    const credit = await withContext(s.ctx, () => createVendorCredit(creditRequest(), s.ctx));
    const approvedCredit = await withContext(s.ctx, () => approveVendorCredit(credit.id, s.ctx));

    await db.app
      .insertInto('ap_allocations')
      .values({
        id: newUuidBuffer(),
        org_id: s.orgId,
        bill_id: uuidToBuffer(approvedBill.id),
        payment_id: null,
        vendor_credit_id: uuidToBuffer(approvedCredit.id),
        amount_minor: 5000n,
        allocated_on: s.date,
        created_by_user_id: s.userId,
      })
      .execute();

    expect(
      await wireErrorOf(
        withContext(s.ctx, () => voidVendorCredit(approvedCredit.id, { date: s.date }, s.ctx)),
      ),
    ).toMatchObject({ details: { precondition: 'document_has_allocations' } });
  });
});
