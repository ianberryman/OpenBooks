import type { JournalLineInput } from '@openbooks/plugin-api';
import type {
  CreateInventoryAdjustmentRequest,
  InventoryAdjustment,
  InventoryAdjustmentLine,
  InventoryItemLedger,
  InventoryLedgerEntry,
  InventoryValuation,
  InventoryValuationQuery,
  InventoryValuationRow,
  ReorderAlert,
  ReorderAlerts,
} from '@openbooks/shared-types';
import {
  createInventoryAdjustmentRequestSchema,
  inventoryValuationQuerySchema,
  quantityFromString,
  quantityToString,
} from '@openbooks/shared-types';

import { getContext } from '../../context';
import type { RequestContext } from '../../context';
import type { TenantDatabase } from '../../db';
import { bufferToUuid, tryUuidToBuffer, uuidToBuffer } from '../../db';
import {
  assertFound,
  InternalError,
  parseInput,
  PreconditionFailedError,
  ValidationError,
} from '../../errors';
import { postJournal, reverseJournal } from '../ledger';
import { quantityFromMicros, quantityToMicros } from '../invoices/pricing';
import { requirePermission } from '../permissions';

import type { OnHand } from './costing';
import { costAddition, costSale, deriveUnitCost, receiptTrueUp } from './costing';
import type { InventoryItemRow } from './inventory.repository';
import {
  CATALOG_ITEM_RESOURCE,
  insertAdjustmentHeader,
  insertMovement,
  loadAllInventoryItems,
  loadInventoryItems,
  orgScope,
  selectAdjustmentHeaderById,
  selectInventoryShrinkageAccountId,
  selectItemMovementsOrdered,
  selectMovementsForSourceDoc,
  selectOnHandFold,
  stampAdjustmentJournal,
} from './inventory.repository';

/**
 * Tracked inventory & perpetual COGS: the posting surface (OB-224; ROADMAP
 * § Milestone INVENTORY).
 *
 * Read `costing.ts` for the pure weighted-average arithmetic and
 * `inventory.repository.ts` for the movement fold. This file is where the two
 * meet a journal: `postSaleCogs` and `recordReceiptMovements` are called from
 * inside the AR/AP posting hooks' own already-open transaction — `depreciation-
 * sweep.ts`'s `postOnePeriod` is the shape, `orgScope(ctx)` and `postJournal`
 * both joining the ambient transaction (`transaction-scope.ts`) rather than a
 * `trx` handle threaded through as an argument. `postInventoryAdjustment` is the
 * one function here that opens its own transaction, because unlike a sale or a
 * receipt it has no enclosing document post to ride.
 *
 * ## The agreement invariant, held in one place per path
 *
 * Every movement's `value_delta_minor` must equal the net amount its journal
 * posts to the item's inventory-asset account (spec §11's subledger-agreement
 * discipline, restated for inventory by `0025_inventory`). Each posting path below
 * computes the journal amount and the movement's `valueDeltaMinor` from the same
 * costing call in the same loop iteration, so the two cannot drift apart the way
 * two independent computations could.
 *
 *  - **Sale**: `Cr` the asset by the item's total `cogsValueMinor` ⇒ each of that
 *    item's `sale` movements carries `-` its own share (`costSale`'s
 *    `valueDeltaMinor`), summing to `-cogsValueMinor`.
 *  - **Receipt**: `Dr` the asset by `valueMinor` (the bill's own redirected line)
 *    ⇒ the `receipt` movement carries `+valueMinor`, verbatim.
 *  - **True-up / adjustment**: the asset `Dr`/`Cr` by `|delta|` ⇒ the matching
 *    movement carries `delta` itself, signed.
 */

/**
 * The inventory-asset account of each of `catalogItemIds` that is a tracked
 * inventory item, keyed by item uuid — the lookup the AP approve hook needs to
 * redirect an inventory line's debit from the line's own account to the item's
 * asset account before the bill journal posts (D-INV-1). A non-inventory id is
 * simply absent from the map. Takes the caller's `db` handle so the read joins the
 * bill-approval transaction (`transaction-scope.ts`).
 */
export async function loadInventoryLineInfo(
  db: TenantDatabase,
  catalogItemIds: readonly string[],
): Promise<Map<string, { readonly inventoryAssetAccountId: string }>> {
  if (catalogItemIds.length === 0) return new Map();
  const idBufs = [...new Set(catalogItemIds.map((id) => uuidToBuffer(id)))];
  const items = await loadInventoryItems(db, idBufs);
  return new Map(
    items.map((item) => [
      bufferToUuid(item.id),
      { inventoryAssetAccountId: bufferToUuid(item.inventoryAssetAccountId) },
    ]),
  );
}

export interface SaleCogsLine {
  readonly catalogItemId: string;
  readonly quantityMicros: bigint;
}

/**
 * Posts perpetual COGS for a sale's inventory-type lines, as one journal
 * (`source: 'inventory'`) separate from the invoice's own revenue journal — D-INV-7:
 * a void reverses both, independently, which only works if they are two journals.
 *
 * Runs inside the caller's already-open transaction (the AR approve hook); does
 * not open one of its own. On-hand is folded once, up front, and then walked
 * locally per line so that two lines of the same item in one sale cost the second
 * against what the first left behind rather than both against the pre-sale
 * balance.
 *
 * Returns the COGS journal's id, or `null` when there are no inventory-type lines
 * or the total cost is zero — `postJournal` refuses a zero-amount line, and with
 * no journal there is nothing for a movement's `journal_id` (`NOT NULL`) to name,
 * so in that case no movement is appended either.
 */
export async function postSaleCogs(
  input: {
    readonly lines: readonly SaleCogsLine[];
    readonly date: string;
    readonly sourceDocId: string;
    readonly memo?: string;
  },
  ctx: RequestContext,
): Promise<string | null> {
  const db = orgScope(ctx);

  const itemIds = [...new Set(input.lines.map((line) => uuidToBuffer(line.catalogItemId)))];
  const items = await loadInventoryItems(db, itemIds);
  const itemsById = new Map(items.map((item) => [item.id.toString('hex'), item]));

  const inventoryLines = input.lines.filter((line) =>
    itemsById.has(uuidToBuffer(line.catalogItemId).toString('hex')),
  );
  if (inventoryLines.length === 0) return null;

  const onHandFold = await selectOnHandFold(db, {});
  const running = new Map<string, OnHand>(onHandFold);

  interface PendingMovement {
    readonly item: InventoryItemRow;
    readonly qtyDeltaMicros: bigint;
    readonly valueDeltaMinor: bigint;
  }
  const pendingMovements: PendingMovement[] = [];
  const cogsByItem = new Map<string, { readonly item: InventoryItemRow; total: bigint }>();

  for (const line of inventoryLines) {
    const key = uuidToBuffer(line.catalogItemId).toString('hex');
    // Filtered to keys present in `itemsById` above.
    const item = itemsById.get(key) as InventoryItemRow;
    const current = running.get(key) ?? { qtyMicros: 0n, valueMinor: 0n };

    const costing = costSale(current, line.quantityMicros, item.defaultCostMinor);

    running.set(key, {
      qtyMicros: current.qtyMicros - line.quantityMicros,
      valueMinor: current.valueMinor + costing.valueDeltaMinor,
    });

    pendingMovements.push({
      item,
      qtyDeltaMicros: -line.quantityMicros,
      valueDeltaMinor: costing.valueDeltaMinor,
    });

    const aggregate = cogsByItem.get(key) ?? { item, total: 0n };
    cogsByItem.set(key, { item, total: aggregate.total + costing.cogsValueMinor });
  }

  const journalLines: JournalLineInput[] = [];
  for (const { item, total } of cogsByItem.values()) {
    if (total === 0n) continue; // `postJournal` refuses a zero-amount line.
    journalLines.push({
      accountId: bufferToUuid(item.cogsAccountId),
      side: 'debit',
      amount: total,
    });
    journalLines.push({
      accountId: bufferToUuid(item.inventoryAssetAccountId),
      side: 'credit',
      amount: total,
    });
  }

  if (journalLines.length === 0) return null;

  const posted = await postJournal(
    {
      date: input.date,
      source: 'inventory',
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      ...(ctx.invocationMode === undefined ? {} : { invocationMode: ctx.invocationMode }),
      ...(input.memo === undefined ? {} : { memo: input.memo }),
      lines: journalLines,
    },
    ctx,
  );

  const journalIdBytes = uuidToBuffer(posted.journalId);
  const sourceDocIdBytes = uuidToBuffer(input.sourceDocId);

  for (const movement of pendingMovements) {
    await insertMovement(db, {
      catalogItemId: movement.item.id,
      movementType: 'sale',
      qtyDeltaMicros: movement.qtyDeltaMicros,
      valueDeltaMinor: movement.valueDeltaMinor,
      journalId: journalIdBytes,
      sourceDocType: 'invoice',
      sourceDocId: sourceDocIdBytes,
      movementDate: input.date,
    });
  }

  return posted.journalId;
}

export interface ReceiptLine {
  readonly catalogItemId: string;
  readonly quantityMicros: bigint;
  readonly valueMinor: bigint;
}

/**
 * Appends a `receipt` movement per inventory-type line, tied to the bill's own
 * journal (its Dr already redirected to the item's inventory-asset account by the
 * caller — this function does not post that journal, only records the movement).
 *
 * Then, for any item whose on-hand was negative before this receipt, reconciles
 * the negative-inventory estimate against this receipt's real unit cost
 * (`receiptTrueUp`) and — when the reconciliation is non-zero — posts a *separate*
 * `source: 'inventory'` journal per item and appends the matching `true_up`
 * movement. Runs inside the caller's already-open transaction (the AP approve
 * hook); does not open one of its own.
 */
export async function recordReceiptMovements(
  input: {
    readonly lines: readonly ReceiptLine[];
    readonly journalId: string;
    readonly date: string;
    readonly sourceDocId: string;
  },
  ctx: RequestContext,
): Promise<void> {
  const db = orgScope(ctx);

  const itemIds = [...new Set(input.lines.map((line) => uuidToBuffer(line.catalogItemId)))];
  const items = await loadInventoryItems(db, itemIds);
  const itemsById = new Map(items.map((item) => [item.id.toString('hex'), item]));

  const inventoryLines = input.lines.filter((line) =>
    itemsById.has(uuidToBuffer(line.catalogItemId).toString('hex')),
  );
  if (inventoryLines.length === 0) return;

  const onHandFold = await selectOnHandFold(db, {});
  const running = new Map<string, OnHand>(onHandFold);
  const journalIdBytes = uuidToBuffer(input.journalId);
  const sourceDocIdBytes = uuidToBuffer(input.sourceDocId);

  interface PendingTrueUp {
    readonly item: InventoryItemRow;
    readonly valueDeltaMinor: bigint;
  }
  const pendingTrueUps: PendingTrueUp[] = [];

  for (const line of inventoryLines) {
    const key = uuidToBuffer(line.catalogItemId).toString('hex');
    const item = itemsById.get(key) as InventoryItemRow;
    const pre = running.get(key) ?? { qtyMicros: 0n, valueMinor: 0n };

    await insertMovement(db, {
      catalogItemId: item.id,
      movementType: 'receipt',
      qtyDeltaMicros: line.quantityMicros,
      valueDeltaMinor: line.valueMinor,
      journalId: journalIdBytes,
      sourceDocType: 'bill',
      sourceDocId: sourceDocIdBytes,
      movementDate: input.date,
    });

    running.set(key, {
      qtyMicros: pre.qtyMicros + line.quantityMicros,
      valueMinor: pre.valueMinor + line.valueMinor,
    });

    const trueUp = receiptTrueUp(pre, line.quantityMicros, line.valueMinor);
    if (trueUp !== null && trueUp.valueDeltaMinor !== 0n) {
      pendingTrueUps.push({ item, valueDeltaMinor: trueUp.valueDeltaMinor });
    }
  }

  for (const { item, valueDeltaMinor } of pendingTrueUps) {
    const amount = valueDeltaMinor < 0n ? -valueDeltaMinor : valueDeltaMinor;

    // Positive delta: the reconciled value is higher than a plain receipt left on
    // hand — raise the asset, and the offset is a COGS credit (the earlier
    // estimated sale expensed too much). Negative: the mirror image.
    const lines: JournalLineInput[] =
      valueDeltaMinor > 0n
        ? [
            { accountId: bufferToUuid(item.inventoryAssetAccountId), side: 'debit', amount },
            { accountId: bufferToUuid(item.cogsAccountId), side: 'credit', amount },
          ]
        : [
            { accountId: bufferToUuid(item.cogsAccountId), side: 'debit', amount },
            { accountId: bufferToUuid(item.inventoryAssetAccountId), side: 'credit', amount },
          ];

    const posted = await postJournal(
      {
        date: input.date,
        source: 'inventory',
        actorType: ctx.actorType,
        actorId: ctx.actorId,
        ...(ctx.invocationMode === undefined ? {} : { invocationMode: ctx.invocationMode }),
        lines,
      },
      ctx,
    );

    await insertMovement(db, {
      catalogItemId: item.id,
      movementType: 'true_up',
      qtyDeltaMicros: 0n,
      valueDeltaMinor,
      journalId: uuidToBuffer(posted.journalId),
      sourceDocType: 'bill',
      sourceDocId: sourceDocIdBytes,
      movementDate: input.date,
    });
  }
}

/**
 * Compensates every movement a source document carries, on a void — the subledger
 * half of D-INV-7. One negated `reversal` movement per movement being undone, so Σ
 * movements for the item still agrees with the reversed GL.
 *
 * The subtlety a naive version misses: a document's movements may name **more than
 * one journal**. A sale's `sale` movements all ride the one COGS journal the caller
 * already reversed (`mainOriginalJournalId` → `mainReversalJournalId`). But a
 * receipt that reconciled a backorder posted a *separate* `true_up` journal, which
 * the caller's document reversal does **not** touch — so this function reverses
 * every original journal it finds that is not the main one, and ties each
 * compensating movement to the reversal of *its own* journal. Tying a true-up's
 * compensation to the document reversal instead would negate the movement while
 * leaving the true-up's GL effect standing, and Σ movements would stop agreeing with
 * the control account by exactly the true-up (the failure the OB-088 property test
 * exists to catch).
 */
export async function reverseInventoryMovements(
  input: {
    readonly sourceDocId: string;
    readonly mainOriginalJournalId: string;
    readonly mainReversalJournalId: string;
    readonly date: string;
  },
  ctx: RequestContext,
): Promise<void> {
  const db = orgScope(ctx);
  const sourceDocIdBytes = uuidToBuffer(input.sourceDocId);

  const priorMovements = await selectMovementsForSourceDoc(db, sourceDocIdBytes);
  if (priorMovements.length === 0) return;

  // The main document journal is already reversed by the caller; seed the map with
  // it. Every other distinct journal the movements name (a `true_up`) is reversed
  // here, once each.
  const reversalByOriginal = new Map<string, Buffer>([
    [
      uuidToBuffer(input.mainOriginalJournalId).toString('hex'),
      uuidToBuffer(input.mainReversalJournalId),
    ],
  ]);
  for (const movement of priorMovements) {
    const originalHex = movement.journalId.toString('hex');
    if (reversalByOriginal.has(originalHex)) continue;
    const reversal = await reverseJournal(
      {
        journalId: bufferToUuid(movement.journalId),
        date: input.date,
        actorType: ctx.actorType,
        actorId: ctx.actorId,
        ...(ctx.invocationMode === undefined ? {} : { invocationMode: ctx.invocationMode }),
      },
      ctx,
    );
    reversalByOriginal.set(originalHex, uuidToBuffer(reversal.journalId));
  }

  for (const movement of priorMovements) {
    const reversalJournalIdBytes = reversalByOriginal.get(movement.journalId.toString('hex'));
    if (reversalJournalIdBytes === undefined) {
      throw new InternalError(
        'A prior inventory movement names a journal with no reversal, which cannot happen: every ' +
          'distinct journal was reversed above.',
      );
    }
    await insertMovement(db, {
      catalogItemId: movement.catalogItemId,
      movementType: 'reversal',
      qtyDeltaMicros: -movement.qtyDeltaMicros,
      valueDeltaMinor: -movement.valueDeltaMinor,
      journalId: reversalJournalIdBytes,
      sourceDocType: movement.sourceDocType,
      sourceDocId: sourceDocIdBytes,
      movementDate: input.date,
    });
  }
}

/**
 * The user an adjustment is recorded by — `fixed-assets.service.ts`'s own
 * `requireRecordingUser`, restated rather than imported (that function is
 * `fixed-assets.service.ts`'s private helper, not a shared one).
 */
function requireRecordingUser(ctx: RequestContext): Buffer {
  const userId = ctx.userId === null ? undefined : tryUuidToBuffer(ctx.userId);
  if (userId === undefined) {
    throw new ValidationError('An inventory adjustment is recorded by a user.', [
      {
        path: 'actor',
        message:
          'This caller has no user identity, so it cannot record a stock adjustment. Recording is ' +
          'attributed to the person who made it.',
      },
    ]);
  }
  return userId;
}

/**
 * The org's nominated shrinkage account, or a refusal naming the setting —
 * `resolveControlAccount`'s own two-part shape (a plain repository read plus the
 * service-level error), restated here because `settings/control-accounts.ts` is
 * hand-written for the receivable/payable pair and gains nothing from a third,
 * unrelated setting reaching into it.
 */
async function resolveShrinkageAccount(db: TenantDatabase): Promise<Buffer> {
  const nominated = await selectInventoryShrinkageAccountId(db);
  if (nominated === null) {
    throw new PreconditionFailedError(
      'inventory_shrinkage_account_not_set',
      'This organization has not nominated an inventory-shrinkage account, so a stock adjustment ' +
        'has nowhere to post its offsetting entry. Nominate one in the organization’s accounting ' +
        'settings and try again.',
    );
  }
  return nominated;
}

function toInventoryAdjustmentLine(line: {
  readonly item: InventoryItemRow;
  readonly quantityDelta: bigint;
  readonly valueDelta: bigint;
}): InventoryAdjustmentLine {
  return {
    catalogItemId: bufferToUuid(line.item.id),
    name: line.item.name,
    quantityDelta: quantityToString(quantityFromMicros(line.quantityDelta)),
    valueDelta: line.valueDelta.toString(),
  };
}

/**
 * Posts a stock count or write-off: a `Dr`/`Cr` between each line's item and the
 * org's nominated shrinkage account, one `adjustment` movement per line, all in
 * one transaction this function opens itself (unlike `postSaleCogs`/
 * `recordReceiptMovements`, an adjustment has no enclosing document post to ride).
 *
 * A positive `quantityDelta` (found stock) is valued at the item's current
 * average, or its `default_cost_minor` when it has none (`costAddition`). A
 * negative one (shrinkage, a write-off) is valued the same way a sale consumes
 * stock, zero-out invariant included (`costSale`) — removing more than is on hand
 * is accepted the same way an oversold sale is, at the current average, flagged
 * `estimated` upstream in `costSale` even though this caller does not surface
 * that flag on the wire.
 */
export async function postInventoryAdjustment(
  request: CreateInventoryAdjustmentRequest,
  ctx: RequestContext = getContext('postInventoryAdjustment()'),
): Promise<InventoryAdjustment> {
  await requirePermission(ctx, 'inventory.write');
  const input = parseInput(createInventoryAdjustmentRequestSchema, request);
  const createdByUserId = requireRecordingUser(ctx);

  return orgScope(ctx).transaction(async (trx) => {
    const shrinkageAccountId = await resolveShrinkageAccount(trx);

    const itemIds = input.lines.map((line) =>
      assertFound(tryUuidToBuffer(line.catalogItemId), CATALOG_ITEM_RESOURCE),
    );
    const items = await loadInventoryItems(trx, itemIds);
    const itemsById = new Map(items.map((item) => [item.id.toString('hex'), item]));

    const onHandFold = await selectOnHandFold(trx, {});
    const running = new Map<string, OnHand>(onHandFold);

    interface PostedLine {
      readonly item: InventoryItemRow;
      readonly quantityDelta: bigint;
      readonly valueDelta: bigint;
    }
    const postedLines: PostedLine[] = [];
    const journalLines: JournalLineInput[] = [];

    for (const line of input.lines) {
      const idBytes = assertFound(tryUuidToBuffer(line.catalogItemId), CATALOG_ITEM_RESOURCE);
      const key = idBytes.toString('hex');
      const item = assertFound(itemsById.get(key), CATALOG_ITEM_RESOURCE);
      const quantityDeltaMicros = quantityToMicros(quantityFromString(line.quantityDelta));
      const current = running.get(key) ?? { qtyMicros: 0n, valueMinor: 0n };

      const valueDelta =
        quantityDeltaMicros >= 0n
          ? costAddition(current, quantityDeltaMicros, item.defaultCostMinor)
          : costSale(current, -quantityDeltaMicros, item.defaultCostMinor).valueDeltaMinor;

      running.set(key, {
        qtyMicros: current.qtyMicros + quantityDeltaMicros,
        valueMinor: current.valueMinor + valueDelta,
      });

      postedLines.push({ item, quantityDelta: quantityDeltaMicros, valueDelta });

      if (valueDelta !== 0n) {
        const amount = valueDelta < 0n ? -valueDelta : valueDelta;
        // Positive: found stock raises the asset, offset against shrinkage.
        // Negative: shrinkage lowers the asset, offset the other way.
        journalLines.push(
          valueDelta > 0n
            ? { accountId: bufferToUuid(item.inventoryAssetAccountId), side: 'debit', amount }
            : { accountId: bufferToUuid(shrinkageAccountId), side: 'debit', amount },
        );
        journalLines.push(
          valueDelta > 0n
            ? { accountId: bufferToUuid(shrinkageAccountId), side: 'credit', amount }
            : { accountId: bufferToUuid(item.inventoryAssetAccountId), side: 'credit', amount },
        );
      }
    }

    const headerId = await insertAdjustmentHeader(trx, {
      adjustmentDate: input.adjustmentDate,
      memo: input.memo ?? null,
      createdByUserId,
    });

    const posted = await postJournal(
      {
        date: input.adjustmentDate,
        source: 'inventory',
        actorType: ctx.actorType,
        actorId: ctx.actorId,
        ...(ctx.invocationMode === undefined ? {} : { invocationMode: ctx.invocationMode }),
        ...(input.memo === undefined || input.memo === null ? {} : { memo: input.memo }),
        lines: journalLines,
      },
      ctx,
    );

    await stampAdjustmentJournal(trx, headerId, uuidToBuffer(posted.journalId));

    const journalIdBytes = uuidToBuffer(posted.journalId);
    for (const line of postedLines) {
      await insertMovement(trx, {
        catalogItemId: line.item.id,
        movementType: 'adjustment',
        qtyDeltaMicros: line.quantityDelta,
        valueDeltaMinor: line.valueDelta,
        journalId: journalIdBytes,
        sourceDocType: 'adjustment',
        sourceDocId: headerId,
        movementDate: input.adjustmentDate,
      });
    }

    const header = assertFound(
      await selectAdjustmentHeaderById(trx, headerId),
      'inventory_adjustment',
    );

    return {
      id: bufferToUuid(header.id),
      adjustmentDate: header.adjustmentDate,
      memo: header.memo,
      journalId: header.journalId === null ? null : bufferToUuid(header.journalId),
      reversedByJournalId:
        header.reversedByJournalId === null ? null : bufferToUuid(header.reversedByJournalId),
      lines: postedLines.map(toInventoryAdjustmentLine),
      createdAt: header.createdAt.toISOString(),
    };
  });
}

/** `YYYY-MM-DD` in UTC — `invoices/summary.service.ts`'s own `todayCalendarDate`. */
function todayCalendarDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * On-hand quantity, value, and derived unit cost for every tracked item as at a
 * date (default today) — a fold over `inventory_movements`, never a cached
 * balance (`selectOnHandFold`'s own reasoning). `totalValue` is the figure the
 * OB-088 property suite ties to the inventory-asset account balance (spec §11).
 */
export async function getInventoryValuation(
  query: InventoryValuationQuery = {},
  ctx: RequestContext = getContext('getInventoryValuation()'),
): Promise<InventoryValuation> {
  await requirePermission(ctx, 'inventory.read');
  const request = parseInput(inventoryValuationQuerySchema, query);
  const asOf = request.asOf ?? todayCalendarDate();

  const db = orgScope(ctx);
  const items = await loadAllInventoryItems(db);
  const onHandFold = await selectOnHandFold(db, { asOf });

  let totalValue = 0n;
  const rows: InventoryValuationRow[] = items.map((item) => {
    const onHand = onHandFold.get(item.id.toString('hex')) ?? { qtyMicros: 0n, valueMinor: 0n };
    totalValue += onHand.valueMinor;
    const unitCost = deriveUnitCost(onHand);

    return {
      catalogItemId: bufferToUuid(item.id),
      name: item.name,
      code: item.code,
      onHandQuantity: quantityToString(quantityFromMicros(onHand.qtyMicros)),
      value: onHand.valueMinor.toString(),
      unitCost: unitCost === null ? null : unitCost.toString(),
      reorderPoint:
        item.reorderPointMicros === null
          ? null
          : quantityToString(quantityFromMicros(item.reorderPointMicros)),
      belowReorderPoint:
        item.reorderPointMicros !== null && onHand.qtyMicros <= item.reorderPointMicros,
    };
  });

  return { asOf, rows, totalValue: totalValue.toString() };
}

/** Every tracked item currently at or below its reorder point. */
export async function getReorderAlerts(
  ctx: RequestContext = getContext('getReorderAlerts()'),
): Promise<ReorderAlerts> {
  await requirePermission(ctx, 'inventory.read');

  const db = orgScope(ctx);
  const items = await loadAllInventoryItems(db);
  const onHandFold = await selectOnHandFold(db, {});

  const alerts: ReorderAlert[] = [];
  for (const item of items) {
    if (item.reorderPointMicros === null) continue;
    const onHand = onHandFold.get(item.id.toString('hex')) ?? { qtyMicros: 0n, valueMinor: 0n };
    if (onHand.qtyMicros > item.reorderPointMicros) continue;

    alerts.push({
      catalogItemId: bufferToUuid(item.id),
      name: item.name,
      code: item.code,
      onHandQuantity: quantityToString(quantityFromMicros(onHand.qtyMicros)),
      reorderPoint: quantityToString(quantityFromMicros(item.reorderPointMicros)),
    });
  }

  return { alerts };
}

/**
 * One tracked item's full movement ledger, oldest first, with the running on-hand
 * each movement leaves (OB-224). The item detail view's data. A non-inventory or
 * cross-org id is A7's 404 — `loadInventoryItems` returns nothing for it, and
 * `assertFound` converts that to the miss.
 */
export async function getInventoryItemLedger(
  catalogItemId: string,
  ctx: RequestContext = getContext('getInventoryItemLedger()'),
): Promise<InventoryItemLedger> {
  await requirePermission(ctx, 'inventory.read');

  const db = orgScope(ctx);
  const itemBytes = assertFound(tryUuidToBuffer(catalogItemId), CATALOG_ITEM_RESOURCE);
  const items = await loadInventoryItems(db, [itemBytes]);
  const item = assertFound(items[0], CATALOG_ITEM_RESOURCE);

  const movements = await selectItemMovementsOrdered(db, itemBytes);

  let runningQty = 0n;
  let runningValue = 0n;
  const entries: InventoryLedgerEntry[] = movements.map((movement) => {
    runningQty += movement.qtyDeltaMicros;
    runningValue += movement.valueDeltaMinor;
    return {
      id: bufferToUuid(movement.id),
      movementType: movement.movementType as InventoryLedgerEntry['movementType'],
      quantityDelta: quantityToString(quantityFromMicros(movement.qtyDeltaMicros)),
      valueDelta: movement.valueDeltaMinor.toString(),
      runningQuantity: quantityToString(quantityFromMicros(runningQty)),
      runningValue: runningValue.toString(),
      journalId: bufferToUuid(movement.journalId),
      sourceDocType: movement.sourceDocType,
      sourceDocId: movement.sourceDocId === null ? null : bufferToUuid(movement.sourceDocId),
      movementDate: movement.movementDate,
      createdAt: movement.createdAt.toISOString(),
    };
  });

  const onHand: OnHand = { qtyMicros: runningQty, valueMinor: runningValue };
  const unitCost = deriveUnitCost(onHand);

  return {
    catalogItemId: bufferToUuid(item.id),
    name: item.name,
    code: item.code,
    onHandQuantity: quantityToString(quantityFromMicros(runningQty)),
    value: runningValue.toString(),
    unitCost: unitCost === null ? null : unitCost.toString(),
    reorderPoint:
      item.reorderPointMicros === null
        ? null
        : quantityToString(quantityFromMicros(item.reorderPointMicros)),
    entries,
  };
}
