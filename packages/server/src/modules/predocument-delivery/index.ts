/**
 * Predocument delivery — emailing a purchase order to its vendor, or an estimate
 * to its customer (initiative M, OB-177; ROADMAP D-M5).
 *
 * ## Surface
 *
 * | Operation             | Callers                                        |
 * | ---------------------- | ----------------------------------------------- |
 * | `sendPurchaseOrder(id, input, ctx)` | `transport/routes/predocument-delivery.ts` |
 * | `sendEstimate(id, input, ctx)`      | `transport/routes/predocument-delivery.ts` |
 *
 * **D-M5, lean v1 (flagged):** this is email + an append-only delivery record
 * only. There is deliberately no token-gated hosted page and no themed PDF here —
 * unlike `modules/delivery` (OB-121…126), which mints a capability token and
 * renders/retains a PDF snapshot for `sendInvoice`. Both are DEFERRED follow-ups
 * (see `send.service.ts`'s header for why they are a different feature, not a
 * smaller version of this one).
 */
export { sendEstimate, sendPurchaseOrder } from './send.service';
