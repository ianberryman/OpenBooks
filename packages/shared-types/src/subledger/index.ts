/**
 * The subledger's wire contracts (OB-061; ROADMAP D-34 through D-40).
 *
 * Read `documents.ts` first: it holds the vocabulary the four documents share, and
 * it is where the two absences that shape all of M3 are argued — no stored balance
 * and no stored status. `allocations.ts` explains why one mechanism settles
 * everything and why an allocation posts no journal; `aging.ts` explains why the
 * report is computed as at a date and why it does not state the control account.
 */

export {
  DOCUMENT_LINE_DESCRIPTION_MAX_LENGTH,
  DOCUMENT_MAX_LINES,
  DOCUMENT_MEMO_MAX_LENGTH,
  DOCUMENT_REFERENCE_MAX_LENGTH,
  DOCUMENT_STATUSES,
  SUBLEDGER_DOCUMENT_TYPES,
  documentDateRangeShape,
  documentLineInputSchema,
  documentLineSchema,
  documentMemoSchema,
  documentNumberSchema,
  documentReferenceSchema,
  documentSettlementSchema,
  documentStatusSchema,
  documentTaxSummaryRowSchema,
  documentTotalsSchema,
  isOrderedRange,
  quantitySchema,
  subledgerDocumentTypeSchema,
  taxModeSchema,
  voidDocumentRequestSchema,
} from './documents';
export type {
  DocumentLine,
  DocumentLineInput,
  DocumentSettlement,
  DocumentStatus,
  DocumentTaxSummaryRow,
  DocumentTotalsResponse,
  SubledgerDocumentType,
  VoidDocumentRequest,
} from './documents';

export { ALLOCATION_SOURCE_TYPES, ALLOCATION_TARGET_TYPES } from './allocations';
export type {
  Allocation,
  AllocationInput,
  AllocationList,
  AllocationSourceType,
  AllocationTargetType,
  CreateAllocationsRequest,
} from './allocations';
export {
  allocationInputSchema,
  allocationListSchema,
  allocationSchema,
  allocationSourceTypeSchema,
  allocationTargetTypeSchema,
  createAllocationsRequestSchema,
} from './allocations';

export type {
  CreateCreditNoteRequest,
  CreateInvoiceRequest,
  CreditNote,
  CreditNotePage,
  CreditNoteSummary,
  Invoice,
  InvoicePage,
  InvoicesSummary,
  InvoicesSummaryQuery,
  InvoiceSummary,
  ListCreditNotesQuery,
  ListInvoicesQuery,
  UpdateCreditNoteRequest,
  UpdateInvoiceRequest,
} from './invoices';
export {
  createCreditNoteRequestSchema,
  createInvoiceRequestSchema,
  creditNotePageSchema,
  creditNoteSchema,
  creditNoteSummarySchema,
  invoicePageSchema,
  invoiceSchema,
  invoicesSummaryQuerySchema,
  invoicesSummarySchema,
  invoiceSummarySchema,
  listCreditNotesQuerySchema,
  listInvoicesQuerySchema,
  updateCreditNoteRequestSchema,
  updateInvoiceRequestSchema,
} from './invoices';

export type {
  Bill,
  BillPage,
  BillsSummary,
  BillsSummaryQuery,
  BillSummary,
  CreateBillRequest,
  CreateVendorCreditRequest,
  ListBillsQuery,
  ListVendorCreditsQuery,
  UpdateBillRequest,
  UpdateVendorCreditRequest,
  VendorCredit,
  VendorCreditPage,
  VendorCreditSummary,
} from './bills';
export {
  billPageSchema,
  billSchema,
  billsSummaryQuerySchema,
  billsSummarySchema,
  billSummarySchema,
  createBillRequestSchema,
  createVendorCreditRequestSchema,
  listBillsQuerySchema,
  listVendorCreditsQuerySchema,
  updateBillRequestSchema,
  updateVendorCreditRequestSchema,
  vendorCreditPageSchema,
  vendorCreditSchema,
  vendorCreditSummarySchema,
} from './bills';

export { CAPTURE_SOURCES, CAPTURE_STATUSES, DOCUMENT_CAPTURE_MAX_BYTES } from './captures';
export type {
  CaptureSource,
  CaptureStatus,
  CreateDraftFromCaptureRequest,
  DocumentCapture,
  DocumentCapturePage,
  ExtractedCaptureLine,
  UploadCaptureRequest,
} from './captures';
export {
  captureSourceSchema,
  captureStatusSchema,
  createDraftFromCaptureRequestSchema,
  documentCapturePageSchema,
  documentCaptureSchema,
  extractedCaptureLineSchema,
  uploadCaptureRequestSchema,
} from './captures';

export { PAYMENT_DIRECTIONS, PAYMENT_STATUSES } from './payments';
export type {
  CreatePaymentRequest,
  ListPaymentsQuery,
  Payment,
  PaymentDirection,
  PaymentPage,
  PaymentStatus,
  PaymentSummary,
  UpdatePaymentRequest,
} from './payments';
export {
  createPaymentRequestSchema,
  listPaymentsQuerySchema,
  paymentDirectionSchema,
  paymentPageSchema,
  paymentSchema,
  paymentStatusSchema,
  paymentSummarySchema,
  updatePaymentRequestSchema,
} from './payments';

export {
  AGING_BUCKETS,
  AGING_BUCKET_UPPER_BOUNDS,
  AGING_DETAIL_TYPES,
  AGING_LEDGERS,
} from './aging';
export type {
  Aging,
  AgingAmounts,
  AgingBucket,
  AgingDetailType,
  AgingDocument,
  AgingLedger,
  AgingQueryParams,
  AgingRow,
} from './aging';
export {
  agingAmountsSchema,
  agingBucketSchema,
  agingDetailTypeSchema,
  agingDocumentSchema,
  agingLedgerSchema,
  agingQuerySchema,
  agingRowSchema,
  agingSchema,
} from './aging';
