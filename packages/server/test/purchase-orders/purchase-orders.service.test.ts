import type { CreatePurchaseOrderRequest } from '@openbooks/shared-types';
import { beforeEach, describe, expect, it } from 'vitest';

import { toWireError } from '../../src/errors';
import {
  approvePurchaseOrder,
  convertPurchaseOrderToBill,
  createPurchaseOrder,
  getPurchaseOrder,
} from '../../src/modules/purchase-orders';
import type { PoScene } from './support';
import { journalCount, sceneIn, useServiceDatabase, withContext } from './support';

/**
 * The purchase-order lifecycle (initiative M, OB-170…173; ROADMAP D-M3, D-M4,
 * D-M6, D-M7).
 *
 * Everything here runs against real MySQL through the real service, as the app
 * user (spec §11 — never SQLite, never mocks). This suite's one distinctive
 * claim, repeated by every AP/AR document suite for its own tables, is that a
 * draft purchase order posts no journal at all — not even a zero one — because
 * it is a non-posting pre-document (D-92) until it converts.
 */
const db = useServiceDatabase();

let s: PoScene;

beforeEach(async () => {
  s = await sceneIn(db);
});

/** A purchase order for 1 × £1,500.00, net (no tax rate on this line). */
function simplePurchaseOrder(
  overrides: Partial<CreatePurchaseOrderRequest> = {},
): CreatePurchaseOrderRequest {
  return {
    contactId: s.vendorUuid,
    issueDate: s.date,
    taxMode: 'exclusive',
    lines: [
      {
        description: 'Paper',
        quantity: '1',
        unitAmount: '150000',
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

describe('a draft purchase order', () => {
  it('is created with no number and posts no journal (D-92, D-M3, D-M6)', async () => {
    const before = await journalCount(db, s.orgId);

    const po = await withContext(s.ctx, () => createPurchaseOrder(simplePurchaseOrder(), s.ctx));

    expect(po).toMatchObject({
      documentNumber: null,
      status: 'draft',
      approvedAt: null,
      convertedBillId: null,
    });
    expect(po.totals).toEqual({ net: '150000', tax: '0', gross: '150000' });

    // D-92: a purchase order that has not converted has told the ledger
    // nothing, so the trial balance — every org's journal count, here, since
    // no journal at all means no balance moved — is exactly what it was
    // before this purchase order existed.
    expect(await journalCount(db, s.orgId)).toBe(before);
  });
});

describe('approving a purchase order', () => {
  it('allocates a gapless number and stamps approvedAt, still posting no journal (D-M6)', async () => {
    const po = await withContext(s.ctx, () => createPurchaseOrder(simplePurchaseOrder(), s.ctx));
    const before = await journalCount(db, s.orgId);

    const approved = await withContext(s.ctx, () => approvePurchaseOrder(po.id, s.ctx));

    expect(approved.documentNumber).not.toBeNull();
    expect(approved.status).toBe('approved');
    expect(approved.approvedAt).not.toBeNull();
    expect(await journalCount(db, s.orgId)).toBe(before);
  });
});

describe('converting a purchase order', () => {
  it('produces a draft bill carrying the same lines, and marks the purchase order converted (D-M4)', async () => {
    const po = await withContext(s.ctx, () => createPurchaseOrder(simplePurchaseOrder(), s.ctx));
    await withContext(s.ctx, () => approvePurchaseOrder(po.id, s.ctx));

    const bill = await withContext(s.ctx, () => convertPurchaseOrderToBill(po.id, s.ctx));

    expect(bill.contactId).toBe(s.vendorUuid);
    expect(bill.status).toBe('draft');
    expect(bill.journalId).toBeNull();
    expect(bill.totals).toEqual({ net: '150000', tax: '0', gross: '150000' });
    expect(bill.lines).toHaveLength(1);
    expect(bill.lines[0]).toMatchObject({
      description: 'Paper',
      quantity: '1',
      unitAmount: '150000',
      accountId: s.expenseUuid,
      netAmount: '150000',
    });

    const converted = await withContext(s.ctx, () => getPurchaseOrder(po.id, s.ctx));
    expect(converted.status).toBe('converted');
    expect(converted.convertedBillId).toBe(bill.id);
  });

  it('refuses a second convert of the same purchase order (D-M4)', async () => {
    const po = await withContext(s.ctx, () => createPurchaseOrder(simplePurchaseOrder(), s.ctx));
    await withContext(s.ctx, () => approvePurchaseOrder(po.id, s.ctx));
    await withContext(s.ctx, () => convertPurchaseOrderToBill(po.id, s.ctx));

    const error = await wireErrorOf(
      withContext(s.ctx, () => convertPurchaseOrderToBill(po.id, s.ctx)),
    );

    expect(error).toMatchObject({
      code: 'precondition_failed',
      details: { precondition: 'purchase_order_already_converted' },
    });
  });

  it('refuses to convert a purchase order that has not been approved', async () => {
    const po = await withContext(s.ctx, () => createPurchaseOrder(simplePurchaseOrder(), s.ctx));

    const error = await wireErrorOf(
      withContext(s.ctx, () => convertPurchaseOrderToBill(po.id, s.ctx)),
    );

    expect(error).toMatchObject({
      code: 'precondition_failed',
      details: { precondition: 'purchase_order_not_approved' },
    });
  });
});
