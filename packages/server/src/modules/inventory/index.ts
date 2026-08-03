/**
 * Tracked inventory & perpetual COGS (initiative INVENTORY, OB-224; ROADMAP
 * § Milestone INVENTORY).
 *
 * `costing.ts` is the pure weighted-average arithmetic; `inventory.repository.ts`
 * is the movement/adjustment data access; `inventory.service.ts` is the surface
 * below. The AR/AP posting hooks call `postSaleCogs` / `recordReceiptMovements` /
 * `reverseInventoryMovements` directly (not through a route); `postInventoryAdjustment`,
 * `getInventoryValuation` and `getReorderAlerts` are the operations a route or an
 * MCP tool drives.
 *
 * ## Surface
 *
 * | Operation                          | Permission          |
 * | ----------------------------------- | -------------------- |
 * | `postInventoryAdjustment(req, ctx)` | `inventory.write`     |
 * | `getInventoryValuation(query, ctx)` | `inventory.read`      |
 * | `getReorderAlerts(ctx)`             | `inventory.read`      |
 *
 * `postSaleCogs`, `recordReceiptMovements` and `reverseInventoryMovements` check
 * no permission of their own — they run inside an already-open transaction from a
 * caller (the AR/AP approve or void hook) that has already checked its own
 * (`invoices.write`, `bills.write`).
 */

export type { SaleCogsLine, ReceiptLine } from './inventory.service';
export {
  loadInventoryLineInfo,
  postSaleCogs,
  recordReceiptMovements,
  reverseInventoryMovements,
  postInventoryAdjustment,
  getInventoryValuation,
  getInventoryItemLedger,
  getReorderAlerts,
} from './inventory.service';

export type { OnHand, SaleCosting, ReceiptTrueUp } from './costing';
