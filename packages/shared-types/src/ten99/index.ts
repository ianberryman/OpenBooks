/**
 * 1099 contractor tax reporting (OB-228) — vendor tax profiles (write-only TIN, D-228-2),
 * the calendar-year cash-paid worksheet (card excluded, D-228-3/4), and immutable filing
 * runs/forms (D-228-5). A reporting overlay that posts no journals.
 */

export type {
  EfileTen99RunRequest,
  GenerateTen99RunRequest,
  Ten99BoxCode,
  Ten99EfileProvider,
  Ten99Form,
  Ten99FormType,
  Ten99Run,
  Ten99RunList,
  Ten99RunStatus,
  Ten99Worksheet,
  Ten99WorksheetRow,
  TaxClassification,
  TaxIdType,
  UpsertVendorTaxProfileRequest,
  VendorTaxProfile,
} from './ten99';
export {
  TAX_CLASSIFICATIONS,
  TAX_ID_TYPES,
  TEN99_BOX_CODES,
  TEN99_EFILE_PROVIDERS,
  TEN99_FORM_TYPES,
  TEN99_RUN_STATUSES,
  efileTen99RunRequestSchema,
  generateTen99RunRequestSchema,
  taxClassificationSchema,
  taxIdTypeSchema,
  ten99BoxCodeSchema,
  ten99EfileProviderSchema,
  ten99FormSchema,
  ten99FormTypeSchema,
  ten99RunListSchema,
  ten99RunSchema,
  ten99RunStatusSchema,
  ten99WorksheetRowSchema,
  ten99WorksheetSchema,
  upsertVendorTaxProfileRequestSchema,
  vendorTaxProfileSchema,
} from './ten99';
