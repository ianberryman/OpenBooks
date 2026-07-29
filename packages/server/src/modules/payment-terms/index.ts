/**
 * Payment terms (OB-136/OB-138; initiative I, Cash application; ROADMAP D-79,
 * D-106, D-107, D-108).
 *
 * A term computes a document's due date from `netDays` and, when it carries an
 * early-pay discount, the discount amount and its deadline — `compute-term.ts`,
 * pure and colocated-tested. `terms.service.ts` is the CRUD surface
 * (`orgs.read`/`orgs.write`, D-107) plus `resolveDocumentTerm`, the
 * contact-default-then-document-override resolution `createArDocument` and
 * `createBill` call so a document's due date needs no explicit `dueDate` when a
 * term already says what it is. `suggestion.service.ts` is OB-138's read/preview
 * surface: it turns a rich term's discount window, checked against a document's
 * outstanding and a caller-supplied date, into the `discountSuggestionSchema`
 * shape a bank-match or money-in screen shows before a human confirms it as a
 * `discount`-kind allocation plus a real journal line (D-106) — never written
 * here, never auto-posted (D-43).
 *
 * ## What is not here
 *
 * - **The `/v1` routes** (OB-139) — payment-terms CRUD, the
 *   `GET /v1/payment-terms/discount-suggestion` preview, and the
 *   `paymentTermId` document-create field are transport
 *   (`transport/routes/payment-terms.ts`); this module holds the services they
 *   call.
 * - **Discount-account nomination** — `discount_given_account_id`/
 *   `discount_received_account_id` live in `org_accounting_settings` beside the
 *   control accounts, so `getDiscountAccounts`/`updateDiscountAccounts`/
 *   `resolveDiscountAccount` are in `modules/settings`, not here.
 * - **The confirmed discount's own allocation and journal** — a `discount`-kind
 *   entry on the multi-entry clear (OB-137/D-80) or the money-in path; this
 *   module only ever previews.
 */

export type { PaymentTermFields } from './compute-term';
export { computePaymentTerm } from './compute-term';

export type { SuggestDiscountInput } from './suggestion.service';
export { suggestDiscount } from './suggestion.service';

export {
  createPaymentTerm,
  deactivatePaymentTerm,
  getPaymentTerm,
  listPaymentTerms,
  resolveDocumentTerm,
  updatePaymentTerm,
} from './terms.service';
