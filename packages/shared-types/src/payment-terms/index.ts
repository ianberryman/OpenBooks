/**
 * Payment terms (initiative I, Cash application; ROADMAP D-79, D-107).
 *
 * `payment-terms.ts` is the whole of it for now: the term itself, its list
 * envelope, its update patch, the computed due-date/discount-window shape, and
 * the discount-suggestion preview. OB-139's `/v1/payment-terms` routes reference
 * every one of these but `computedPaymentTermSchema` — see that file's header for
 * which schemas carry `.meta({ id })` and why that one still does not.
 */

export {
  PAYMENT_TERM_NAME_MAX_LENGTH,
  computedPaymentTermSchema,
  createPaymentTermRequestSchema,
  discountSuggestionSchema,
  paymentTermListSchema,
  paymentTermSchema,
  updatePaymentTermRequestSchema,
} from './payment-terms';
export type {
  ComputedPaymentTerm,
  CreatePaymentTermRequest,
  DiscountSuggestion,
  PaymentTerm,
  PaymentTermList,
  UpdatePaymentTermRequest,
} from './payment-terms';
