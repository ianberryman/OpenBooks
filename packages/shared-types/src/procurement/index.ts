/**
 * Procure-to-pay wire contracts (initiative M; ROADMAP D-M1…D-M8).
 *
 * Three non-posting or bill-shaped resources, each explained where it is
 * defined: `purchase-orders.ts` for the pre-document lifecycle POs and
 * estimates share (D-M3, D-M6, D-M7) and for `predocumentLineInputSchema`,
 * `estimates.ts` for the AR mirror, and `expenses.ts` for why an expense's
 * responses are `Bill`/`BillSummary`/`BillPage` under new names rather than
 * a fourth document shape (D-M2). `deliveries.ts` is the fourth: sending
 * either pre-document to its counterparty, lean by decision (D-M5).
 */

export {
  PREDOCUMENT_DELIVERY_STATUSES,
  PREDOCUMENT_KINDS,
  predocumentDeliverySchema,
  sendPredocumentRequestSchema,
} from './deliveries';
export type {
  PredocumentDelivery,
  PredocumentDeliveryStatus,
  PredocumentKind,
  SendPredocumentRequest,
} from './deliveries';

export {
  ESTIMATE_STATUSES,
  createEstimateRequestSchema,
  estimatePageSchema,
  estimateSchema,
  estimateSummarySchema,
  estimatesSummaryQuerySchema,
  estimatesSummarySchema,
  listEstimatesQuerySchema,
  updateEstimateRequestSchema,
} from './estimates';
export type {
  CreateEstimateRequest,
  Estimate,
  EstimatePage,
  EstimateStatus,
  EstimateSummary,
  EstimatesSummary,
  EstimatesSummaryQuery,
  ListEstimatesQuery,
  UpdateEstimateRequest,
} from './estimates';

export {
  createExpenseRequestSchema,
  listExpensesQuerySchema,
  updateExpenseRequestSchema,
} from './expenses';
export type {
  CreateExpenseRequest,
  Expense,
  ExpensePage,
  ExpenseSummary,
  ListExpensesQuery,
  UpdateExpenseRequest,
} from './expenses';

export {
  PURCHASE_ORDER_STATUSES,
  createPurchaseOrderRequestSchema,
  listPurchaseOrdersQuerySchema,
  predocumentLineInputSchema,
  purchaseOrderPageSchema,
  purchaseOrderSchema,
  purchaseOrderSummarySchema,
  updatePurchaseOrderRequestSchema,
} from './purchase-orders';
export type {
  CreatePurchaseOrderRequest,
  ListPurchaseOrdersQuery,
  PredocumentLineInput,
  PurchaseOrder,
  PurchaseOrderPage,
  PurchaseOrderStatus,
  PurchaseOrderSummary,
  UpdatePurchaseOrderRequest,
} from './purchase-orders';
