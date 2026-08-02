/**
 * The tracked-inventory & COGS wire contract (initiative INVENTORY, OB-224).
 *
 * Read `inventory.ts` for why on-hand value is a signed minor-units count while
 * quantity is the decimal-string `Quantity`, why the per-unit cost is derived and
 * never stored, and why the valuation total ties to the inventory-asset GL account
 * (the subledger-agreement invariant, spec §11).
 *
 * The bodies and responses carry `.meta({ id })`; the valuation query deliberately
 * does not — a querystring is emitted as individual `parameters`. The item-type and
 * costing-method enums are declared here (the inventory concept) and imported by the
 * catalog item schema for the costing fields it grew.
 */

export type {
  CreateInventoryAdjustmentRequest,
  InventoryAdjustment,
  InventoryAdjustmentLine,
  InventoryAdjustmentLineInput,
  InventoryCostingMethod,
  InventoryItemType,
  InventoryMovement,
  InventoryMovementType,
  InventoryValuation,
  InventoryValuationQuery,
  InventoryValuationRow,
  ReorderAlert,
  ReorderAlerts,
} from './inventory';
export {
  createInventoryAdjustmentRequestSchema,
  INVENTORY_COSTING_METHODS,
  INVENTORY_ITEM_TYPES,
  INVENTORY_MOVEMENT_TYPES,
  inventoryAdjustmentLineInputSchema,
  inventoryAdjustmentLineSchema,
  inventoryAdjustmentSchema,
  inventoryCostingMethodSchema,
  inventoryItemTypeSchema,
  inventoryMovementSchema,
  inventoryMovementTypeSchema,
  inventoryValuationQuerySchema,
  inventoryValuationRowSchema,
  inventoryValuationSchema,
  reorderAlertSchema,
  reorderAlertsSchema,
} from './inventory';
