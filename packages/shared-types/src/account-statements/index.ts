/**
 * Customer statement of account (OB-220, ROADMAP part 1) — a per-customer branded
 * open-item statement rendered to a PDF, delivered via the INV download/email path.
 * The data is the AR aging report scoped to one contact (D-40), so this domain adds
 * only the delivery/record wire shape, not a new definition of outstanding.
 */

export type {
  CreateCustomerStatementRequest,
  CustomerStatement,
  CustomerStatementList,
  CustomerStatementStatus,
} from './statement';
export {
  CUSTOMER_STATEMENT_STATUSES,
  createCustomerStatementRequestSchema,
  customerStatementListSchema,
  customerStatementSchema,
  customerStatementStatusSchema,
} from './statement';
