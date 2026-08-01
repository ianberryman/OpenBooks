/**
 * 1099 contractor tax reporting (OB-228).
 *
 * Vendor W-9/tax profiles (TIN write-only, D-228-2), the calendar-year cash-paid worksheet
 * (card/third-party payments excluded, D-228-3/4), and immutable filing runs/forms
 * (D-228-5), rendered to a recipient Copy B PDF and optionally submitted for e-file
 * (`Form1099Provider`, D-228-7). A reporting/compliance overlay — it posts no journals.
 *
 * ## Surface
 *
 * | Operation                  | Callers                                    |
 * | --------------------------- | ------------------------------------------- |
 * | `upsertVendorTaxProfile`   | `transport/routes/ten99.ts` (not yet wired) |
 * | `getVendorTaxProfile`      | same                                        |
 * | `listVendorTaxProfiles`    | same                                        |
 * | `computeTen99Worksheet`    | same                                        |
 * | `generateTen99Run`         | same                                        |
 * | `getTen99Run`              | same                                        |
 * | `listTen99Runs`            | same                                        |
 * | `renderTen99FormPdf`       | same                                        |
 * | `efileTen99Run`            | same                                        |
 * | `getTen99FilingStatus`     | same                                        |
 *
 * See `ten99.service.ts`'s own header for the permission table and the three assumptions
 * this module's implementation makes.
 */
export {
  computeTen99Worksheet,
  efileTen99Run,
  generateTen99Run,
  getTen99FilingStatus,
  getTen99Run,
  getVendorTaxProfile,
  listTen99Runs,
  listVendorTaxProfiles,
  renderTen99FormPdf,
  upsertVendorTaxProfile,
} from './ten99.service';

export { createTen99Renderer } from './renderer';
export type { Ten99FormRenderInput, Ten99FormRenderer } from './renderer';
export type { Ten99FormBranding } from './renderer/types';
