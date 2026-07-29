/**
 * Invoice delivery — the hosted page and its capability token (OB-121, Phase 1).
 *
 * ## Surface
 *
 * | Operation                              | Callers                                          |
 * | ---------------------------------------- | --------------------------------------------------- |
 * | `mintDeliveryToken()`                  | `sendInvoice` (C1, OB-126) — mints once per send |
 * | `verifyDeliveryToken(token)`           | `public-invoice.service.ts`, internal to this module |
 * | `getPublicInvoiceView(token)`          | `transport/routes/public-invoices.ts`            |
 * | `getPublicInvoiceArtifact(token)`      | `transport/routes/public-invoices.ts`            |
 * | `resolvePublicInvoiceIdentity(token)`  | `transport/routes/public-pay-link.ts` (OB-150)   |
 *
 * There are no routes for `mintDeliveryToken`/`verifyDeliveryToken` themselves —
 * minting is C1's, at the moment a delivery row is written, and verifying is
 * `public-invoice.service.ts`'s own first step, not something a caller does apart
 * from asking one of the two public-view functions.
 *
 * Everything a caller needs to know about the token format, the hashed-token
 * storage, and why `token.ts` is allowed to reach `invoice_deliveries` with no org
 * context is in that file's header and in `src/db/delivery-lookup.ts`'s. Everything
 * about why the two public functions take a bare token and no `RequestContext` is
 * in `public-invoice.service.ts`'s header.
 */
export { mintDeliveryToken, verifyDeliveryToken } from './token';
export type { DeliveryTokenMatch, MintedDeliveryToken } from './token';

export {
  getPublicInvoiceArtifact,
  getPublicInvoiceView,
  resolvePublicInvoiceIdentity,
} from './public-invoice.service';
export type { PublicInvoiceArtifact, PublicInvoiceIdentity } from './public-invoice.service';

export { sendInvoice } from './send-invoice.service';
