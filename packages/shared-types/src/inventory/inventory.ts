import { z } from 'zod';

import { quantitySchema } from '../subledger';
import { calendarDateSchema, minorUnitsSchema } from '../wire';

/**
 * The wire contract for tracked inventory & perpetual COGS (initiative INVENTORY,
 * OB-224; ROADMAP § Milestone INVENTORY).
 *
 * ## What the numbers are
 *
 * On-hand *quantity* is a `Quantity` (the decimal-string `quantitySchema` every
 * document line uses; the DB carries it in micros and the server converts). On-hand
 * *value* and every movement's value are `minorUnitsSchema` — an exact `bigint`
 * cent count, and **signed**: a sale or a shrinkage carries a negative delta, which
 * `minorUnitsSchema` admits (`"-150000"`). The per-unit cost is *derived*
 * `value / quantity` and never a stored field — weighted average maps onto the
 * append-only movement log, where each movement appends a signed
 * `(quantityDelta, valueDelta)` and on-hand is a fold (see the `0025_inventory`
 * header). When on-hand quantity reaches zero the value is exactly zero — the
 * residual-cent sweep, the inventory analogue of `no-float-money`.
 *
 * ## The `id`s
 *
 * `catalog.ts`'s rule holds: an `id` goes on a body or response schema a route
 * references, and the querystring schemas (`inventoryValuationQuerySchema`) carry
 * none — a querystring is emitted as individual `parameters`.
 *
 * ## Item costing fields live on the catalog item
 *
 * `INVENTORY_ITEM_TYPES` and `INVENTORY_COSTING_METHODS` are declared here — the
 * inventory concept — and the catalog item schema imports them for the costing
 * fields it grew (`item_type`, the asset/COGS accounts, the costing method, the
 * default cost and the reorder point). Those fields ride `catalog.write`; the
 * valuation views and the stock-adjustment document below ride `inventory.read`/
 * `inventory.write` (D-INV-8).
 */

/**
 * What kind of thing a catalog item is. Only an `'inventory'` item is stock-tracked
 * — it carries an inventory-asset account, a COGS account and a costing method, and
 * a purchase of it raises the asset while a sale of it posts COGS. `'non_inventory'`
 * (the default, matching every item that existed before OB-224) and `'service'`
 * items post exactly as they did: the line's own account, no movement, no COGS.
 */
export const INVENTORY_ITEM_TYPES = ['inventory', 'non_inventory', 'service'] as const;

export type InventoryItemType = (typeof INVENTORY_ITEM_TYPES)[number];

export const inventoryItemTypeSchema = z.enum(INVENTORY_ITEM_TYPES).meta({
  description:
    'What kind of catalog item this is. Only `inventory` items are stock-tracked (asset + COGS ' +
    'accounts, a costing method, perpetual COGS on sale and asset on purchase). `non_inventory` ' +
    'and `service` items post the line’s own account with no movement (D-INV-1).',
});

/**
 * The costing method. Weighted-average ships first because it maps onto the
 * append-only movement log — the unit cost is a derived rational, never a mutable
 * layer state. FIFO is the deferred second method (ROADMAP § Milestone INVENTORY).
 */
export const INVENTORY_COSTING_METHODS = ['weighted_average'] as const;

export type InventoryCostingMethod = (typeof INVENTORY_COSTING_METHODS)[number];

export const inventoryCostingMethodSchema = z.enum(INVENTORY_COSTING_METHODS).meta({
  description:
    'How units are costed. `weighted_average` is the only method in v1 — it maps onto the ' +
    'append-only movement log as a derived rational; FIFO is deferred (ROADMAP § Milestone INVENTORY).',
});

/**
 * The kinds of stock movement, mirroring the `inventory_movements.movement_type`
 * CHECK. A `receipt` rides a bill's journal; a `sale` and its COGS ride a separate
 * `source='inventory'` journal; an `adjustment` is a count/shrinkage document; a
 * `true_up` reconciles a negative-inventory sale to the real receipt cost; a
 * `reversal` compensates a voided document.
 */
export const INVENTORY_MOVEMENT_TYPES = [
  'receipt',
  'sale',
  'adjustment',
  'true_up',
  'reversal',
] as const;

export type InventoryMovementType = (typeof INVENTORY_MOVEMENT_TYPES)[number];

export const inventoryMovementTypeSchema = z.enum(INVENTORY_MOVEMENT_TYPES).meta({
  description:
    'What produced a movement: `receipt` (a bill), `sale` (an invoice’s COGS), `adjustment` (a ' +
    'count/shrinkage), `true_up` (a negative-inventory cost reconciliation), or `reversal` (a void).',
});

const catalogItemIdSchema = z.uuid().meta({
  description: 'The tracked catalog item this figure is for.',
});

const onHandQuantitySchema = quantitySchema.meta({
  description:
    'Units on hand — a signed decimal quantity folded over the movement log. Negative when a sale ' +
    'ran the item below zero (the backorder accommodation, allowed with a warning; D-INV).',
});

/**
 * One movement, as the API returns it. The append-only subledger row: a signed
 * quantity and value delta tied to the journal that carried its GL effect.
 */
export const inventoryMovementSchema = z
  .strictObject({
    id: z.uuid(),
    catalogItemId: catalogItemIdSchema,
    movementType: inventoryMovementTypeSchema,
    quantityDelta: quantitySchema.meta({
      description: 'Signed change in on-hand units. A receipt is positive; a sale is negative.',
    }),
    valueDelta: minorUnitsSchema.meta({
      description:
        'Signed change in inventory value, in minor units. Its sign matches `quantityDelta`; the ' +
        'zero-out sweep sets it so a zero on-hand quantity has exactly zero value.',
    }),
    journalId: z.uuid().meta({
      description: 'The journal that carried this movement’s GL effect (never mutated; spec §2.2).',
    }),
    sourceDocType: z
      .string()
      .nullable()
      .meta({
        description: 'Which document produced the movement — `bill`, `invoice`, `adjustment`.',
      }),
    sourceDocId: z.uuid().nullable(),
    movementDate: calendarDateSchema,
    createdAt: z.iso.datetime(),
  })
  .meta({
    id: 'InventoryMovement',
    description:
      'One append-only stock movement — a signed quantity and value delta tied to the journal that ' +
      'posted its GL effect. On-hand is a fold over these; a correction is a compensating movement.',
  });

export type InventoryMovement = z.infer<typeof inventoryMovementSchema>;

// ── Inventory valuation report ───────────────────────────────────────────────

/**
 * The valuation report query. `asOf` defaults to today on the server when absent —
 * a querystring report like the balance sheet, so no `.meta({ id })`.
 */
export const inventoryValuationQuerySchema = z.strictObject({
  asOf: calendarDateSchema.optional().meta({
    description: 'Value the stock as at this date (inclusive). Defaults to today when omitted.',
  }),
});

export type InventoryValuationQuery = z.infer<typeof inventoryValuationQuerySchema>;

export const inventoryValuationRowSchema = z
  .strictObject({
    catalogItemId: catalogItemIdSchema,
    name: z.string(),
    code: z.string().nullable(),
    onHandQuantity: onHandQuantitySchema,
    value: minorUnitsSchema.meta({
      description:
        'The on-hand value in minor units — the sum of the item’s value deltas as at `asOf`.',
    }),
    unitCost: minorUnitsSchema.nullable().meta({
      description:
        'The derived moving-average unit cost (`value / quantity`) in minor units, rounded for ' +
        'display only. Null when on-hand quantity is zero — there is no meaningful average.',
    }),
    reorderPoint: quantitySchema.nullable().meta({
      description: 'The item’s reorder point, or null when none is set.',
    }),
    belowReorderPoint: z.boolean().meta({
      description: 'True when a reorder point is set and on-hand quantity is at or below it.',
    }),
  })
  .meta({
    id: 'InventoryValuationRow',
    description: 'One tracked item’s on-hand quantity, value, and derived unit cost as at `asOf`.',
  });

export type InventoryValuationRow = z.infer<typeof inventoryValuationRowSchema>;

export const inventoryValuationSchema = z
  .strictObject({
    asOf: calendarDateSchema,
    rows: z.array(inventoryValuationRowSchema),
    totalValue: minorUnitsSchema.meta({
      description:
        'Every row’s value summed, in minor units. Ties to the inventory-asset account balance as ' +
        'at `asOf` — the subledger-agreement invariant the property suite asserts (spec §11, OB-088).',
    }),
  })
  .meta({
    id: 'InventoryValuation',
    description:
      'On-hand quantity and value for every tracked item as at a date, with a total that ties to ' +
      'the inventory-asset GL account.',
  });

export type InventoryValuation = z.infer<typeof inventoryValuationSchema>;

// ── Reorder alerts ───────────────────────────────────────────────────────────

export const reorderAlertSchema = z
  .strictObject({
    catalogItemId: catalogItemIdSchema,
    name: z.string(),
    code: z.string().nullable(),
    onHandQuantity: onHandQuantitySchema,
    reorderPoint: quantitySchema.meta({
      description: 'The reorder point on-hand has fallen to or below.',
    }),
  })
  .meta({
    id: 'ReorderAlert',
    description: 'A tracked item whose on-hand quantity is at or below its reorder point.',
  });

export type ReorderAlert = z.infer<typeof reorderAlertSchema>;

export const reorderAlertsSchema = z
  .strictObject({
    alerts: z.array(reorderAlertSchema),
  })
  .meta({
    id: 'ReorderAlerts',
    description: 'Every tracked item currently at or below its reorder point.',
  });

export type ReorderAlerts = z.infer<typeof reorderAlertsSchema>;

// ── Stock adjustment document ────────────────────────────────────────────────

/**
 * One line of a stock adjustment: a signed change to an item's on-hand quantity.
 * A negative delta is shrinkage or a write-off; a positive one is found stock. The
 * value is computed on the server at the item's moving-average cost (or its
 * `default_cost` when it has never held stock) — never supplied by the client, so a
 * caller cannot restate inventory value out of step with the quantity.
 */
export const inventoryAdjustmentLineInputSchema = z.strictObject({
  catalogItemId: catalogItemIdSchema,
  quantityDelta: quantitySchema.meta({
    description:
      'The signed change to on-hand units — negative for shrinkage or a write-off, positive for ' +
      'found stock. Its value is costed on the server at the item’s moving average.',
  }),
});

export type InventoryAdjustmentLineInput = z.infer<typeof inventoryAdjustmentLineInputSchema>;

export const createInventoryAdjustmentRequestSchema = z
  .strictObject({
    adjustmentDate: calendarDateSchema.meta({
      description: 'The date the adjustment posts under. Must fall in an open period.',
    }),
    memo: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .nullish()
      .meta({ description: 'An optional note — the reason for the count or write-off.' }),
    lines: z
      .array(inventoryAdjustmentLineInputSchema)
      .min(1)
      .meta({ description: 'At least one item line. Each item may appear once.' }),
  })
  .meta({
    id: 'CreateInventoryAdjustmentRequest',
    description:
      'Posts a stock adjustment — a Dr/Cr between the inventory-asset accounts and the org’s ' +
      'nominated shrinkage account (D-INV-6), plus one movement per line. Gated `inventory.write`.',
  });

export type CreateInventoryAdjustmentRequest = z.infer<
  typeof createInventoryAdjustmentRequestSchema
>;

export const inventoryAdjustmentLineSchema = z
  .strictObject({
    catalogItemId: catalogItemIdSchema,
    name: z.string(),
    quantityDelta: quantitySchema,
    valueDelta: minorUnitsSchema.meta({
      description: 'The signed value posted for this line, costed at the item’s moving average.',
    }),
  })
  .meta({
    id: 'InventoryAdjustmentLine',
    description:
      'One posted adjustment line — its signed quantity and the value the server costed it at.',
  });

export type InventoryAdjustmentLine = z.infer<typeof inventoryAdjustmentLineSchema>;

export const inventoryAdjustmentSchema = z
  .strictObject({
    id: z.uuid(),
    adjustmentDate: calendarDateSchema,
    memo: z.string().nullable(),
    journalId: z.uuid().nullable().meta({
      description: 'The journal the adjustment posted, or null while it is still a draft.',
    }),
    reversedByJournalId: z.uuid().nullable().meta({
      description: 'The reversing journal, once the adjustment has been reversed (D-02).',
    }),
    lines: z.array(inventoryAdjustmentLineSchema),
    createdAt: z.iso.datetime(),
  })
  .meta({
    id: 'InventoryAdjustment',
    description: 'A posted stock adjustment: its lines, the journal it posted, and any reversal.',
  });

export type InventoryAdjustment = z.infer<typeof inventoryAdjustmentSchema>;
