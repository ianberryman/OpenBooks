/**
 * Purchase orders (initiative M, OB-170…173; ROADMAP D-M3, D-M4, D-M6, D-M7).
 *
 * A purchase order is a non-posting pre-document (D-92): create, edit, and
 * discard behave like a bill's own draft lifecycle, `approvePurchaseOrder`
 * allocates its gapless number, and `convertPurchaseOrderToBill` — the one
 * financial event a purchase order ever causes — builds a draft bill from its
 * header and stored lines and hands it to `createBill` (`modules/bills`),
 * which gates on its own `bills.write` permission. Read `purchase-orders.service.ts`
 * for the lifecycle in full and `purchase-orders.repository.ts` for the schema
 * this mirrors from `bills/ap-documents.repository.ts`.
 *
 * ## Surface
 *
 * | Operation                                       | Permission              |
 * | ------------------------------------------------ | ----------------------- |
 * | `createPurchaseOrder(input, ctx)`                | `purchase_orders.write` |
 * | `getPurchaseOrder(id, ctx)`                      | `purchase_orders.read`  |
 * | `listPurchaseOrders(query, ctx)`                 | `purchase_orders.read`  |
 * | `updatePurchaseOrder(id, input, ctx)`            | `purchase_orders.write` |
 * | `discardPurchaseOrder(id, ctx)`                  | `purchase_orders.write` |
 * | `approvePurchaseOrder(id, ctx)`                  | `purchase_orders.write` |
 * | `convertPurchaseOrderToBill(id, ctx)`            | `purchase_orders.write` (→ `bills.write`) |
 *
 * There are no routes here: transport is `transport/routes/purchase-orders.ts`.
 * There is no `send` operation here either — `modules/predocument-delivery`
 * owns `POST /{id}/send` (D-M5).
 */

export {
  approvePurchaseOrder,
  convertPurchaseOrderToBill,
  createPurchaseOrder,
  discardPurchaseOrder,
  getPurchaseOrder,
  listPurchaseOrders,
  updatePurchaseOrder,
} from './purchase-orders.service';

export { PURCHASE_ORDER_RESOURCE } from './purchase-orders.repository';
