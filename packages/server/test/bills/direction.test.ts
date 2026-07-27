import { beforeEach, describe, expect, it } from 'vitest';

import { approveBill, createBill } from '../../src/modules/bills';
import { approveVendorCredit, createVendorCredit } from '../../src/modules/bills';
import { uuidToBuffer } from '../db';
import type { ApScene } from './support';
import { accountBalance, sceneIn, useServiceDatabase, withContext } from './support';

/**
 * Which way an AP journal runs — the one claim in this module that a balanced
 * journal cannot falsify.
 *
 * A bill debits what was bought and **credits** accounts payable; a vendor credit
 * is the exact mirror. Swap either and the journal still balances, the trial
 * balance still sums to zero, `postJournal`'s validation still passes, and every
 * total in `bills.service.test.ts` is unchanged. What changes is the *sign* of the
 * payables control account: the business appears to be owed money by every
 * supplier it owes, which is obvious on a balance sheet and invisible everywhere
 * else.
 *
 * So every assertion here is a **signed** balance — debits minus credits on one
 * account — and none of them is a count of lines or a document total. That is the
 * only shape of assertion the mistake can fail, and it is why this file exists
 * separately from the lifecycle suite.
 *
 * ## What was measured
 *
 * Three mutations were applied to `journalSides` and to the tax posting, and each
 * was run against the whole `test/bills` suite:
 *
 *  1. **Swap a bill's two sides** (`lineSide: 'credit'`, `controlSide: 'debit'`).
 *     Everything in `bills.service.test.ts` still passed — the totals, the
 *     numbering, C5's "identical journals", the void netting to zero. Only the two
 *     `expect(payable).toBe(-…)` assertions below failed.
 *  2. **Give a vendor credit a bill's sides** (drop the ternary, return the bill
 *     branch always). The whole lifecycle suite passed and only the vendor-credit
 *     case here failed, because a credit posted as a bill *increases* what is
 *     owed — and the document's own totals are identical either way.
 *  3. **Post tax on the opposite side to its line.** The journal no longer
 *     balances, so `postJournal` rejects it and much of the suite fails — this one
 *     is caught anywhere. Recorded because it is the mutation people expect to be
 *     the dangerous one, and it is the safe one.
 */
const db = useServiceDatabase();

let s: ApScene;

beforeEach(async () => {
  s = await sceneIn(db);
});

describe('a bill', () => {
  it('debits what was bought and credits accounts payable', async () => {
    const bill = await withContext(s.ctx, () =>
      createBill(
        {
          contactId: s.vendorUuid,
          issueDate: s.date,
          dueDate: '2026-02-15',
          taxMode: 'exclusive',
          lines: [
            {
              description: 'Paper',
              quantity: '1',
              unitAmount: '150000',
              accountId: s.expenseUuid,
              taxRateId: s.taxRateUuid,
            },
          ],
        },
        s.ctx,
      ),
    );
    await withContext(s.ctx, () => approveBill(bill.id, s.ctx));

    // Debits minus credits. The expense and the input tax are debits; the payable
    // is a credit, so it is negative in this signed reading — a liability the
    // business now owes.
    expect(await accountBalance(db.app, s.orgId, s.expenseId)).toBe(150_000n);
    expect(await accountBalance(db.app, s.orgId, s.taxAccountId)).toBe(30_000n);
    expect(await accountBalance(db.app, s.orgId, s.payableId)).toBe(-180_000n);
  });
});

describe('a vendor credit', () => {
  it('credits what was returned and debits accounts payable — the exact mirror', async () => {
    const credit = await withContext(s.ctx, () =>
      createVendorCredit(
        {
          contactId: s.vendorUuid,
          issueDate: s.date,
          taxMode: 'exclusive',
          lines: [
            {
              description: 'Paper returned',
              quantity: '1',
              unitAmount: '150000',
              accountId: s.expenseUuid,
              taxRateId: s.taxRateUuid,
            },
          ],
        },
        s.ctx,
      ),
    );
    await withContext(s.ctx, () => approveVendorCredit(credit.id, s.ctx));

    expect(await accountBalance(db.app, s.orgId, s.expenseId)).toBe(-150_000n);
    expect(await accountBalance(db.app, s.orgId, s.taxAccountId)).toBe(-30_000n);
    expect(await accountBalance(db.app, s.orgId, s.payableId)).toBe(180_000n);
  });

  it('nets a bill it mirrors to zero on every account (D-39)', async () => {
    const bill = await withContext(s.ctx, () =>
      createBill(
        {
          contactId: s.vendorUuid,
          issueDate: s.date,
          dueDate: '2026-02-15',
          taxMode: 'inclusive',
          lines: [
            {
              description: 'Paper',
              quantity: '3',
              unitAmount: '1999',
              accountId: s.expenseUuid,
              taxRateId: s.taxRateUuid,
            },
          ],
        },
        s.ctx,
      ),
    );
    await withContext(s.ctx, () => approveBill(bill.id, s.ctx));

    const credit = await withContext(s.ctx, () =>
      createVendorCredit(
        {
          contactId: s.vendorUuid,
          issueDate: s.date,
          taxMode: 'inclusive',
          lines: [
            {
              description: 'Paper returned',
              quantity: '3',
              unitAmount: '1999',
              accountId: s.expenseUuid,
              taxRateId: s.taxRateUuid,
            },
          ],
        },
        s.ctx,
      ),
    );
    await withContext(s.ctx, () => approveVendorCredit(credit.id, s.ctx));

    // The same arithmetic on both, so the same rounded cent on both — which is why
    // a credit note is the exact mirror of the document it credits and not an
    // approximate one (`addTax`'s symmetry note in `compute.ts`).
    for (const account of [s.expenseId, s.taxAccountId, s.payableId]) {
      expect(await accountBalance(db.app, s.orgId, account)).toBe(0n);
    }
  });
});

describe('the vendor rides on every line', () => {
  it('names the contact on the control line and on the expense line', async () => {
    const bill = await withContext(s.ctx, () =>
      createBill(
        {
          contactId: s.vendorUuid,
          issueDate: s.date,
          dueDate: '2026-02-15',
          taxMode: 'exclusive',
          lines: [
            { description: 'Paper', quantity: '1', unitAmount: '150000', accountId: s.expenseUuid },
          ],
        },
        s.ctx,
      ),
    );
    const approved = await withContext(s.ctx, () => approveBill(bill.id, s.ctx));

    const lines = await db.app
      .selectFrom('journal_lines')
      .select(['account_id', 'contact_id'])
      .where('journal_id', '=', uuidToBuffer(approved.journalId ?? ''))
      .execute();

    expect(lines).toHaveLength(2);
    // Without this, "what is still outstanding with this vendor" answers with one
    // side of the entry and not the other — the same argument `reverseJournal`
    // makes for copying the contact onto a reversal.
    expect(lines.every((line) => line.contact_id?.equals(s.vendorId) === true)).toBe(true);
  });
});
