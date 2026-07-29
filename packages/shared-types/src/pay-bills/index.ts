/**
 * Pay Bills (initiative G, OB-109…118; ROADMAP D-63…D-69, D-109…D-112).
 *
 * `pay-bills.ts` holds the whole wire surface: the pending-payment queue and its
 * intents, the batch build request, the rail classification, the issue request and
 * per-payment result, the Pay Bills window's per-bill payability, the external
 * list-by-rail read, and a vendor's disbursement details. OB-115's `/v1` routes are
 * where these gain their `.meta({ id })` — see that file's header for why none does
 * yet.
 */

export {
  ACH_NUMBER_MAX_LENGTH,
  PAYMENT_RAILS,
  PENDING_PAYMENT_STATUSES,
  WIRE_INSTRUCTIONS_MAX_LENGTH,
  createPendingPaymentRequestSchema,
  issueOutcomeSchema,
  issuePendingPaymentRequestSchema,
  issuePendingPaymentsRequestSchema,
  issueResultSchema,
  payBillsRequestSchema,
  payableBillListSchema,
  payableBillSchema,
  pendingPaymentIntentInputSchema,
  pendingPaymentIntentSchema,
  pendingPaymentListSchema,
  pendingPaymentSchema,
  pendingPaymentStatusSchema,
  railDisbursementListSchema,
  railDisbursementSchema,
  railSchema,
  routeToRailRequestSchema,
  updatePendingPaymentRequestSchema,
  updateVendorDisbursementDetailsRequestSchema,
  vendorDisbursementDetailsSchema,
} from './pay-bills';
export type {
  CreatePendingPaymentRequest,
  IssueOutcome,
  IssuePendingPaymentRequest,
  IssuePendingPaymentsRequest,
  IssueResult,
  PayBillsRequest,
  PayableBill,
  PayableBillList,
  PaymentRail,
  PendingPayment,
  PendingPaymentIntent,
  PendingPaymentIntentInput,
  PendingPaymentList,
  PendingPaymentStatus,
  RailDisbursement,
  RailDisbursementList,
  RouteToRailRequest,
  UpdatePendingPaymentRequest,
  UpdateVendorDisbursementDetailsRequest,
  VendorDisbursementDetails,
} from './pay-bills';
