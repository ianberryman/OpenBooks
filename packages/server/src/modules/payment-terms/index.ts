/**
 * Payment terms (OB-136; initiative I, Cash application; ROADMAP D-79, D-106,
 * D-107, D-108).
 *
 * A term computes a document's due date from `netDays` and, when it carries an
 * early-pay discount, the discount amount and its deadline — `compute-term.ts`,
 * pure and colocated-tested. `terms.service.ts` is the CRUD surface
 * (`orgs.read`/`orgs.write`, D-107) plus `resolveDocumentTerm`, the
 * contact-default-then-document-override resolution `createArDocument` and
 * `createBill` call so a document's due date needs no explicit `dueDate` when a
 * term already says what it is.
 *
 * ## What is not here
 *
 * - **OB-138's discount suggestion** — the read/preview surface that turns a
 *   rich term's discount window, checked against today, into the
 *   `discountSuggestionSchema` a bank-match or money-in screen shows before a
 *   human confirms it as a `discount` clearing entry (D-106). This module
 *   supplies the arithmetic (`computePaymentTerm`); it does not decide when a
 *   suggestion is still live.
 * - **OB-139's routes** — no `.meta({ id })` on `paymentTermSchema` or
 *   `updatePaymentTermRequestSchema` until then, per `payment-terms.ts`'s own
 *   header.
 * - **Discount-account nomination** — `discount_given_account_id`/
 *   `discount_received_account_id` live in `org_accounting_settings` beside the
 *   control accounts, so `getDiscountAccounts`/`updateDiscountAccounts`/
 *   `resolveDiscountAccount` are in `modules/settings`, not here.
 */

export type { PaymentTermFields } from './compute-term';
export { computePaymentTerm } from './compute-term';

export {
  createPaymentTerm,
  deactivatePaymentTerm,
  getPaymentTerm,
  listPaymentTerms,
  resolveDocumentTerm,
  updatePaymentTerm,
} from './terms.service';
