import type { CreateBillRequest, CreateVendorCreditRequest } from '@openbooks/shared-types';
import { beforeEach, describe, expect, it } from 'vitest';

import type { RequestContext } from '../../src/context';
import { toWireError } from '../../src/errors';
import {
  approveBill,
  createBill,
  createVendorCredit,
  discardBill,
  getBill,
  listBills,
  updateBill,
  voidBill,
} from '../../src/modules/bills';
import { newUuid } from '../db';
import type { ApScene } from './support';
import { memberOf, sceneIn, useServiceDatabase, withContext } from './support';

/**
 * The permission each operation declares, checked against the seeded roles
 * (spec §5; enforcement is service-layer only, spec §2.4).
 *
 * | Operation                | Permission             |
 * | ------------------------ | ---------------------- |
 * | get / list bill          | `bills.read`           |
 * | create / update /        |                        |
 * | discard / approve bill   | `bills.write`          |
 * | void bill                | `bills.void`           |
 * | get / list credit        | `vendor_credits.read`  |
 * | every credit write,      |                        |
 * | including void           | `vendor_credits.write` |
 *
 * Asserted through the service rather than by reading the catalog, because what
 * matters is that `requirePermission` runs **before the payload is parsed**: an
 * unauthorized caller must learn nothing about the shape of an API it cannot use.
 * Every refusal below is therefore taken with a deliberately malformed request, so
 * a check that had drifted below `parseInput` would answer `validation_failed`
 * instead of `permission_denied` and fail here.
 *
 * Every actor is a member of the *same* org as the fixture. Two orgs would make
 * each call a 404 by construction (A7) and hide the answer under test.
 */
const db = useServiceDatabase();

let s: ApScene;
/** AR-only: holds every AR code and no AP code at all. */
let ar: RequestContext;

beforeEach(async () => {
  s = await sceneIn(db);
  ar = await memberOf(db, s, 'arOnly');
});

/** Not a valid request. A permission check that runs first never looks at it. */
const MALFORMED_BILL = { contactId: 'not-a-uuid' } as unknown as CreateBillRequest;
const MALFORMED_CREDIT = { contactId: 'not-a-uuid' } as unknown as CreateVendorCreditRequest;

async function wireErrorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (thrown: unknown) => toWireError(thrown),
  );
}

function draftBill(scene: ApScene): CreateBillRequest {
  return {
    contactId: scene.vendorUuid,
    issueDate: scene.date,
    dueDate: scene.date,
    taxMode: 'exclusive',
    lines: [
      {
        description: 'Paper',
        quantity: '1',
        unitAmount: '150000',
        accountId: scene.expenseUuid,
      },
    ],
  };
}

describe('a caller with no AP permission', () => {
  it('is refused every read', async () => {
    expect(await wireErrorOf(withContext(ar, () => listBills({}, ar)))).toMatchObject({
      code: 'permission_denied',
      status: 403,
      details: { permission: 'bills.read' },
    });
    expect(await wireErrorOf(withContext(ar, () => getBill(newUuid(), ar)))).toMatchObject({
      details: { permission: 'bills.read' },
    });
  });

  it('is refused create, update, discard and approve with `bills.write`', async () => {
    const calls: readonly (() => Promise<unknown>)[] = [
      () => createBill(MALFORMED_BILL, ar),
      () => updateBill('not-a-uuid', { memo: 'x' }, ar),
      () => discardBill('not-a-uuid', ar),
      () => approveBill('not-a-uuid', ar),
    ];

    for (const call of calls) {
      expect(await wireErrorOf(withContext(ar, call))).toMatchObject({
        code: 'permission_denied',
        details: { permission: 'bills.write' },
      });
    }
  });

  it('is refused a void with `bills.void`, which is its own code', async () => {
    expect(
      await wireErrorOf(withContext(ar, () => voidBill('not-a-uuid', { date: s.date }, ar))),
    ).toMatchObject({ details: { permission: 'bills.void' } });
  });

  it('is refused a vendor credit with `vendor_credits.write`', async () => {
    expect(
      await wireErrorOf(withContext(ar, () => createVendorCredit(MALFORMED_CREDIT, ar))),
    ).toMatchObject({ details: { permission: 'vendor_credits.write' } });
  });
});

describe('a read-only caller', () => {
  it('lists bills and is refused every write', async () => {
    const reader = await memberOf(db, s, 'readOnly');

    expect((await withContext(reader, () => listBills({}, reader))).items).toEqual([]);
    expect(
      await wireErrorOf(withContext(reader, () => createBill(MALFORMED_BILL, reader))),
    ).toMatchObject({ code: 'permission_denied', details: { permission: 'bills.write' } });
  });
});

describe('the AP clerk, and the gap that stops them finishing a bill', () => {
  it('may enter and edit one', async () => {
    const clerk = await memberOf(db, s, 'apOnly');

    const bill = await withContext(clerk, () => createBill(draftBill(s), clerk));
    expect(bill.status).toBe('draft');
    expect((await withContext(clerk, () => updateBill(bill.id, { memo: 'Q1' }, clerk))).memo).toBe(
      'Q1',
    );
  });

  /**
   * **Known gap 6, arriving early.** The seeded `ap_only` role (migration
   * `0001_tenancy`) holds `bills.*` and `vendor_credits.*` and does *not* hold
   * `journals.post` or `journals.reverse`. Approving posts a journal and voiding
   * reverses one, so the role that exists to enter bills cannot finish one.
   *
   * These two tests pin the **current** behaviour deliberately. Neither is an
   * assertion that the refusal is right — it plainly is not — but a tripwire: the
   * day the role seed grants `journals.post` to `ap_only`, they fail, and whoever
   * sees them reads this paragraph and deletes them. An `it.skip` or a silent
   * omission would leave the gap invisible instead, and C11 puts it on OB-071.
   *
   * The fix is a role seed, not a change in this module. A `bills.approve` code
   * would not help either: `postJournal` checks `journals.post`, and that check is
   * the ledger's, which is exactly where it belongs.
   */
  it('cannot yet approve one — no `journals.post` (C11, gap 6)', async () => {
    const clerk = await memberOf(db, s, 'apOnly');
    const bill = await withContext(clerk, () => createBill(draftBill(s), clerk));

    expect(await wireErrorOf(withContext(clerk, () => approveBill(bill.id, clerk)))).toMatchObject({
      code: 'permission_denied',
      details: { permission: 'journals.post' },
    });
  });

  it('cannot yet void one — no `journals.reverse` (C11, gap 6)', async () => {
    const clerk = await memberOf(db, s, 'apOnly');

    // Approved by the org's owner, so the void is the only thing under test.
    const bill = await withContext(s.ctx, () => createBill(draftBill(s), s.ctx));
    await withContext(s.ctx, () => approveBill(bill.id, s.ctx));

    expect(
      await wireErrorOf(withContext(clerk, () => voidBill(bill.id, { date: s.date }, clerk))),
    ).toMatchObject({ code: 'permission_denied', details: { permission: 'journals.reverse' } });
  });
});
