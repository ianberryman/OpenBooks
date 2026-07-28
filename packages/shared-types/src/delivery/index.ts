/**
 * Invoice-delivery wire contracts (OB-123, Phase 1).
 *
 * Read `branding.ts` first: it holds the org letterhead an invoice is printed under,
 * and it is where the column widths the F2 schema stream provisions are declared.
 * `delivery.ts` holds the send itself, the record it returns, and the customer-safe
 * `publicInvoiceViewSchema` the hosted page renders — and its header documents the
 * capability-token format (`{prefix}.{secret}`) and the hashed-token pattern the
 * delivery row stores, the seam the F2 (schema) and S3 (hosted page) streams share.
 *
 * No schema here carries a `.meta({ id })`: the routes arrive in a later stream, and
 * an id with no route publishes a `components.schemas` entry nothing can reach.
 */

export {
  ORG_BRANDING_ADDRESS_LINE_MAX_LENGTH,
  ORG_BRANDING_CITY_MAX_LENGTH,
  ORG_BRANDING_COUNTRY_MAX_LENGTH,
  ORG_BRANDING_DISPLAY_NAME_MAX_LENGTH,
  ORG_BRANDING_EMAIL_MAX_LENGTH,
  ORG_BRANDING_FOOTER_MAX_LENGTH,
  ORG_BRANDING_LOGO_STORAGE_KEY_MAX_LENGTH,
  ORG_BRANDING_PHONE_MAX_LENGTH,
  ORG_BRANDING_POSTAL_CODE_MAX_LENGTH,
  ORG_BRANDING_REGION_MAX_LENGTH,
  ORG_BRANDING_TAX_NUMBER_MAX_LENGTH,
  ORG_BRANDING_WEBSITE_MAX_LENGTH,
  orgBrandingSchema,
  updateOrgBrandingRequestSchema,
} from './branding';
export type { OrgBranding, UpdateOrgBrandingRequest } from './branding';

export {
  INVOICE_DELIVERY_STATUSES,
  invoiceDeliverySchema,
  invoiceDeliveryStatusSchema,
  publicInvoiceViewSchema,
  sendInvoiceRequestSchema,
} from './delivery';
export type {
  InvoiceDelivery,
  InvoiceDeliveryStatus,
  PublicInvoiceView,
  SendInvoiceRequest,
} from './delivery';
