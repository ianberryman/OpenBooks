/**
 * Payment terms (initiative I, Cash application; ROADMAP D-79, D-107).
 *
 * `payment-terms.ts` is the whole of it for now: the term itself, the computed
 * due-date/discount-window shape, and the discount-suggestion preview. No
 * `.meta({ id })` until OB-139's routes exist to reference these — see that
 * file's header.
 */

export {
  PAYMENT_TERM_NAME_MAX_LENGTH,
  computedPaymentTermSchema,
  createPaymentTermRequestSchema,
  discountSuggestionSchema,
  paymentTermSchema,
} from './payment-terms';
export type {
  ComputedPaymentTerm,
  CreatePaymentTermRequest,
  DiscountSuggestion,
  PaymentTerm,
} from './payment-terms';
