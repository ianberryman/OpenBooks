import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRequestContext, runInContext, type RequestContext } from '../../src/context';
import {
  bufferToUuid,
  destroyDatabase,
  initializeDatabase,
  isDatabaseInitialized,
  newUuidBuffer,
  uuidToBuffer,
} from '../../src/db';
import { approveBill, createBill } from '../../src/modules/bills';
import { createCatalogItem } from '../../src/modules/catalog';
import {
  getInventoryValuation,
  getReorderAlerts,
  postInventoryAdjustment,
} from '../../src/modules/inventory';
import { approveInvoice, createInvoice, voidInvoice } from '../../src/modules/invoices';
import { SYSTEM_ROLE_UUIDS, systemRoleId, useTestDatabase } from '../db';

/**
 * Tracked inventory & perpetual COGS end to end (OB-224).
 *
 * The property that ties the subsystem together is **subledger agreement** (spec §11,
 * the OB-088 discipline): the inventory-asset account's GL balance equals the sum of
 * `inventory_movements.value_delta_minor` at every point, because every movement's
 * value is posted to that account by a journal in lockstep. This file drives the real
 * path — a bill receives stock, an invoice sells it and posts COGS, a void reverses
 * both, an adjustment writes some off — and after each reads the GL and the movement
 * fold two independent ways and asserts they agree.
 */

const db = useTestDatabase();

beforeAll(() => {
  if (!isDatabaseInitialized()) initializeDatabase(db.appConnectionConfig);
});

afterAll(async () => {
  await destroyDatabase();
});

let codeSeq = 0;

interface InventoryScene {
  readonly ctx: RequestContext;
  readonly orgId: Buffer;
  readonly date: string;
  readonly contactId: string;
  readonly revenueUuid: string;
  readonly cogsUuid: string;
  readonly inventoryAssetId: Buffer;
  readonly cogsId: Buffer;
  readonly itemId: string;
}

async function sceneIn(): Promise<InventoryScene> {
  const seq = (codeSeq += 1);
  const pad = (n: number): string => String(n).padStart(2, '0');

  const org = await db.factories.org();
  const user = await db.factories.user();
  await db.factories.orgMember({ orgId: org.id, userId: user.id, roleId: systemRoleId('owner') });
  const period = await db.factories.fiscalPeriod({ orgId: org.id });

  const acct = (
    code: string,
    name: string,
    type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense',
    normalBalance: 'debit' | 'credit',
  ) => db.factories.account({ orgId: org.id, code, name, type, normalBalance });

  const [inventoryAsset, cogs, revenue, receivable, payable, shrinkage] = await Promise.all([
    acct(`13${pad(seq)}`, 'Inventory', 'asset', 'debit'),
    acct(`50${pad(seq)}`, 'COGS', 'expense', 'debit'),
    acct(`40${pad(seq)}`, 'Sales', 'revenue', 'credit'),
    acct(`11${pad(seq)}`, 'Accounts receivable', 'asset', 'debit'),
    acct(`20${pad(seq)}`, 'Accounts payable', 'liability', 'credit'),
    acct(`51${pad(seq)}`, 'Shrinkage', 'expense', 'debit'),
  ]);

  await db.factories.controlAccounts({
    orgId: org.id,
    receivableId: receivable.id,
    payableId: payable.id,
    inventoryShrinkageId: shrinkage.id,
  });

  // One party is both a customer (the sale) and a vendor (the receipt).
  const contactId = newUuidBuffer();
  await db.app
    .insertInto('contacts')
    .values({
      id: contactId,
      org_id: org.id,
      display_name: 'Widget Co',
      is_customer: 1,
      is_vendor: 1,
    })
    .execute();

  const ctx = createRequestContext({
    orgId: org.uuid,
    roleId: SYSTEM_ROLE_UUIDS.owner,
    userId: user.uuid,
    actorType: 'user',
    actorId: user.uuid,
  });

  // A tracked item, weighted-average, reorder point 5 units.
  const item = await runInContext(ctx, () =>
    createCatalogItem(
      {
        direction: 'inventory',
        itemType: 'inventory',
        name: 'Widget',
        inventoryAssetAccountId: inventoryAsset.uuid,
        cogsAccountId: cogs.uuid,
        costingMethod: 'weighted_average',
        reorderPoint: '5',
      },
      ctx,
    ),
  );

  return {
    ctx,
    orgId: org.id,
    date: period.startDate,
    contactId: bufferToUuid(contactId),
    revenueUuid: revenue.uuid,
    cogsUuid: cogs.uuid,
    inventoryAssetId: inventoryAsset.id,
    cogsId: cogs.id,
    itemId: item.id,
  };
}

/** The signed GL balance of one account: debits minus credits. */
async function accountBalance(orgId: Buffer, accountId: Buffer): Promise<bigint> {
  const { rows } = await sql<{ debits: string | null; credits: string | null }>`
    SELECT SUM(debit_minor) AS debits, SUM(credit_minor) AS credits
      FROM journal_lines
     WHERE org_id = ${orgId} AND account_id = ${accountId}
  `.execute(db.app);
  const row = rows[0];
  return BigInt(row?.debits ?? '0') - BigInt(row?.credits ?? '0');
}

/** Σ of an item's movement value deltas — the subledger side of the agreement. */
async function movementValue(orgId: Buffer): Promise<bigint> {
  const { rows } = await sql<{ total: string | null }>`
    SELECT SUM(value_delta_minor) AS total FROM inventory_movements WHERE org_id = ${orgId}
  `.execute(db.app);
  return BigInt(rows[0]?.total ?? '0');
}

/** Receives `quantity` units at `unitAmount` cents each through an approved bill. */
function receive(s: InventoryScene, quantity: string, unitAmount: string): Promise<void> {
  return runInContext(s.ctx, async () => {
    const bill = await createBill(
      {
        contactId: s.contactId,
        issueDate: s.date,
        taxMode: 'exclusive',
        reference: `PO-${String(codeSeq)}-${quantity}-${unitAmount}`,
        // The line's own account is the COGS account; the approve hook redirects the
        // debit to the item's inventory-asset account (D-INV-1).
        lines: [
          {
            description: 'Widget',
            quantity,
            unitAmount,
            accountId: s.cogsUuid,
            catalogItemId: s.itemId,
          },
        ],
      },
      s.ctx,
    );
    await approveBill(bill.id, s.ctx);
  });
}

/** Sells `quantity` units at `unitAmount` cents each through an approved invoice. */
function sell(s: InventoryScene, quantity: string, unitAmount: string): Promise<string> {
  return runInContext(s.ctx, async () => {
    const invoice = await createInvoice(
      {
        contactId: s.contactId,
        issueDate: s.date,
        taxMode: 'exclusive',
        lines: [
          {
            description: 'Widget',
            quantity,
            unitAmount,
            accountId: s.revenueUuid,
            catalogItemId: s.itemId,
          },
        ],
      },
      s.ctx,
    );
    await approveInvoice(invoice.id, s.ctx);
    return invoice.id;
  });
}

describe('perpetual inventory and COGS', () => {
  it('receives stock, sells it at moving-average COGS, and keeps the subledger tied to the GL', async () => {
    const s = await sceneIn();

    // Receive 10 @ $100 → inventory asset debited $1,000; on-hand 10 @ $100.
    await receive(s, '10', '10000');
    expect(await accountBalance(s.orgId, s.inventoryAssetId)).toBe(100000n);
    expect(await movementValue(s.orgId)).toBe(100000n);

    // Sell 4 @ $150 → COGS $400 (4 × the $100 average), inventory → $600.
    const invoiceId = await sell(s, '4', '15000');

    expect(await accountBalance(s.orgId, s.cogsId)).toBe(40000n);
    expect(await accountBalance(s.orgId, s.inventoryAssetId)).toBe(60000n);

    // Agreement, read three independent ways.
    const report = await runInContext(s.ctx, () => getInventoryValuation({}, s.ctx));
    expect(report.totalValue).toBe('60000');
    expect(await movementValue(s.orgId)).toBe(60000n);
    expect(BigInt(report.totalValue)).toBe(await accountBalance(s.orgId, s.inventoryAssetId));

    const row = report.rows.find((r) => r.catalogItemId === s.itemId);
    expect(row?.onHandQuantity).toBe('6');
    expect(row?.value).toBe('60000');
    expect(row?.unitCost).toBe('10000');
    expect(row?.belowReorderPoint).toBe(false);

    // The invoice recorded a COGS journal distinct from its revenue journal.
    const stamped = await db.app
      .selectFrom('ar_documents')
      .select(['journal_id', 'cogs_journal_id'])
      .where('id', '=', uuidToBuffer(invoiceId))
      .executeTakeFirstOrThrow();
    expect(stamped.cogs_journal_id).not.toBeNull();
    expect(stamped.cogs_journal_id?.equals(stamped.journal_id as Buffer)).toBe(false);
  });

  it('reverses both revenue and COGS on void, restoring stock and agreement', async () => {
    const s = await sceneIn();
    await receive(s, '10', '10000');
    const invoiceId = await sell(s, '4', '15000');
    expect(await accountBalance(s.orgId, s.inventoryAssetId)).toBe(60000n);

    await runInContext(s.ctx, () => voidInvoice(invoiceId, { date: s.date }, s.ctx));

    expect(await accountBalance(s.orgId, s.cogsId)).toBe(0n);
    expect(await accountBalance(s.orgId, s.inventoryAssetId)).toBe(100000n);
    expect(await movementValue(s.orgId)).toBe(100000n);
    const report = await runInContext(s.ctx, () => getInventoryValuation({}, s.ctx));
    expect(report.rows.find((r) => r.catalogItemId === s.itemId)?.onHandQuantity).toBe('10');
  });

  it('writes stock off through an adjustment against the shrinkage account', async () => {
    const s = await sceneIn();
    await receive(s, '10', '10000');

    // Write off 2 units at the $100 average → inventory −$200, shrinkage +$200.
    await runInContext(s.ctx, () =>
      postInventoryAdjustment(
        {
          adjustmentDate: s.date,
          memo: 'Damaged',
          lines: [{ catalogItemId: s.itemId, quantityDelta: '-2' }],
        },
        s.ctx,
      ),
    );

    expect(await accountBalance(s.orgId, s.inventoryAssetId)).toBe(80000n);
    expect(await movementValue(s.orgId)).toBe(80000n);
    const report = await runInContext(s.ctx, () => getInventoryValuation({}, s.ctx));
    expect(report.rows.find((r) => r.catalogItemId === s.itemId)?.onHandQuantity).toBe('8');
  });

  it('flags an item at or below its reorder point', async () => {
    const s = await sceneIn();
    await receive(s, '4', '10000'); // below the reorder point of 5

    const alerts = await runInContext(s.ctx, () => getReorderAlerts(s.ctx));
    const alert = alerts.alerts.find((a) => a.catalogItemId === s.itemId);
    expect(alert).toBeDefined();
    expect(alert?.onHandQuantity).toBe('4');
    expect(alert?.reorderPoint).toBe('5');
  });
});
