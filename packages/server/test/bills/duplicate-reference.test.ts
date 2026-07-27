import type { CreateBillRequest } from '@openbooks/shared-types';
import { beforeEach, describe, expect, it } from 'vitest';

import { toWireError } from '../../src/errors';
import {
  approveBill,
  approveVendorCredit,
  createBill,
  createVendorCredit,
  voidBill,
} from '../../src/modules/bills';
import { bufferToUuid } from '../db';
import type { ApScene } from './support';
import { sceneIn, useServiceDatabase, vendorIn, withContext } from './support';

/**
 * The vendor's own invoice number, and what happens when it repeats (D-36).
 *
 * The rule, argued in full on `assertNoDuplicateReference`: **approving a second
 * live bill for one vendor under one reference is refused.** Everything else about
 * the field passes untouched, and the four exemptions are what make the refusal
 * safe rather than obstructive — each has a case below, because a rule whose
 * exemptions are untested is a rule nobody can change with confidence.
 */
const db = useServiceDatabase();

let s: ApScene;

beforeEach(async () => {
  s = await sceneIn(db);
});

function billFor(
  contactUuid: string,
  reference: string | null,
  overrides: Partial<CreateBillRequest> = {},
): CreateBillRequest {
  return {
    contactId: contactUuid,
    issueDate: s.date,
    dueDate: '2026-02-15',
    taxMode: 'exclusive',
    ...(reference === null ? {} : { reference }),
    lines: [
      { description: 'Paper', quantity: '1', unitAmount: '150000', accountId: s.expenseUuid },
    ],
    ...overrides,
  };
}

async function approveNew(request: CreateBillRequest): Promise<string> {
  const bill = await withContext(s.ctx, () => createBill(request, s.ctx));
  const approved = await withContext(s.ctx, () => approveBill(bill.id, s.ctx));
  return approved.id;
}

async function wireErrorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (thrown: unknown) => toWireError(thrown),
  );
}

describe('the case that is refused', () => {
  it('refuses a second approved bill for one vendor under one reference', async () => {
    await approveNew(billFor(s.vendorUuid, 'INV-1001'));

    const second = await withContext(s.ctx, () =>
      createBill(billFor(s.vendorUuid, 'INV-1001'), s.ctx),
    );
    const error = await wireErrorOf(withContext(s.ctx, () => approveBill(second.id, s.ctx)));

    expect(error).toMatchObject({
      code: 'precondition_failed',
      details: { precondition: 'duplicate_vendor_reference' },
    });
    // The message names the colliding bill, which `ConflictError`'s and
    // `PreconditionFailedError`'s free text is allowed to do: the row is inside
    // the caller's own org by construction, so there is no cross-org existence to
    // disclose (unlike `NotFoundError`, which takes a token and nothing else).
    expect(String((error as { message: string }).message)).toContain('bill 1');
  });

  it('matches case-insensitively, because a person holding the paper would', async () => {
    await approveNew(billFor(s.vendorUuid, 'INV-1001'));

    const second = await withContext(s.ctx, () =>
      createBill(billFor(s.vendorUuid, 'inv-1001'), s.ctx),
    );

    expect(
      await wireErrorOf(withContext(s.ctx, () => approveBill(second.id, s.ctx))),
    ).toMatchObject({ details: { precondition: 'duplicate_vendor_reference' } });
  });

  it('leaves the refused bill a draft, and the series gapless', async () => {
    await approveNew(billFor(s.vendorUuid, 'INV-1001'));

    const second = await withContext(s.ctx, () =>
      createBill(billFor(s.vendorUuid, 'INV-1001'), s.ctx),
    );
    await wireErrorOf(withContext(s.ctx, () => approveBill(second.id, s.ctx)));

    // The number was claimed inside the transaction and rolled back with it, so
    // the next approval takes 2 rather than 3 (D-36, and D-14 on why
    // `AUTO_INCREMENT` could not do this).
    const third = await withContext(s.ctx, () =>
      createBill(billFor(s.vendorUuid, 'INV-2002'), s.ctx),
    );
    const approved = await withContext(s.ctx, () => approveBill(third.id, s.ctx));

    expect(approved.documentNumber).toBe('2');
  });
});

describe('the four cases that are deliberately not refused', () => {
  it('allows two vendors to use the same number', async () => {
    const other = await vendorIn(db, s.orgId, 'Beta Supplies');

    await approveNew(billFor(s.vendorUuid, 'INV-1001'));
    const second = await approveNew(billFor(bufferToUuid(other), 'INV-1001'));

    expect(second).toBeDefined();
  });

  it('allows two bills with no reference at all', async () => {
    await approveNew(billFor(s.vendorUuid, null));
    const second = await approveNew(billFor(s.vendorUuid, null));

    expect(second).toBeDefined();
  });

  it('never blocks entry — two drafts may carry the same reference', async () => {
    const first = await withContext(s.ctx, () =>
      createBill(billFor(s.vendorUuid, 'INV-1001'), s.ctx),
    );
    const second = await withContext(s.ctx, () =>
      createBill(billFor(s.vendorUuid, 'INV-1001'), s.ctx),
    );

    // D-38's line: before approval a document is editable and discardable. A check
    // that fired while someone typed would be a check they learn to work around.
    expect(first.id).not.toBe(second.id);
    expect(second.reference).toBe('INV-1001');
  });

  it('allows re-entry after the first bill was voided', async () => {
    const original = await approveNew(billFor(s.vendorUuid, 'INV-1001'));
    await withContext(s.ctx, () => voidBill(original, { date: s.date }, s.ctx));

    // The single most common legitimate reuse of a vendor number: the bill was
    // entered wrong, voided, and entered again.
    const second = await approveNew(billFor(s.vendorUuid, 'INV-1001'));

    expect(second).toBeDefined();
  });
});

describe('vendor credits are not subject to the rule', () => {
  it('allows two credits from one vendor under one reference', async () => {
    const request = {
      contactId: s.vendorUuid,
      issueDate: s.date,
      taxMode: 'exclusive' as const,
      reference: 'CN-7',
      lines: [
        { description: 'Return', quantity: '1', unitAmount: '5000', accountId: s.expenseUuid },
      ],
    };

    for (const _ of [1, 2]) {
      const credit = await withContext(s.ctx, () => createVendorCredit(request, s.ctx));
      const approved = await withContext(s.ctx, () => approveVendorCredit(credit.id, s.ctx));
      expect(approved.status).toBe('approved');
    }
  });

  it('does not collide with a bill carrying the same reference', async () => {
    await approveNew(billFor(s.vendorUuid, 'DOC-9'));

    const credit = await withContext(s.ctx, () =>
      createVendorCredit(
        {
          contactId: s.vendorUuid,
          issueDate: s.date,
          taxMode: 'exclusive',
          reference: 'DOC-9',
          lines: [
            { description: 'Return', quantity: '1', unitAmount: '5000', accountId: s.expenseUuid },
          ],
        },
        s.ctx,
      ),
    );

    expect((await withContext(s.ctx, () => approveVendorCredit(credit.id, s.ctx))).status).toBe(
      'approved',
    );
  });
});
