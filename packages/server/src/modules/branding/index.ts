/**
 * Org branding — the letterhead an org's invoices are printed under (OB-124,
 * Phase 1 delivery; shared-types contract in `shared-types/src/delivery/branding.ts`).
 *
 * One row per org (`org_branding`, `0007_invoice_delivery`), shaped and lazily
 * created exactly like `org_accounting_settings`
 * (`modules/settings/settings.repository.ts`): absent until the first write, and
 * absence is not an error anywhere in this module — `getBranding` synthesizes a
 * default rather than reporting a miss, for the reason `branding.service.ts` gives
 * in full.
 *
 * ## Why a module of its own, rather than `modules/orgs` or `modules/invoices`
 *
 * `modules/orgs`, for `modules/settings/index.ts`'s reason restated: whoever owns
 * this must be reachable from the invoice-rendering path (`modules/invoices`, once
 * PDF rendering lands) without that path taking on an edge asserting invoicing is
 * *built on* the orgs module. `modules/invoices` itself cannot own it either — the
 * letterhead is not specific to invoices, and OB-124 is explicit that credit notes
 * and any future document type read the same row.
 *
 * ## The three operations
 *
 * `getBranding` (`branding.read`) never throws — an org with no letterhead yet
 * still has a name to print. `updateBranding` (`branding.write`) upserts a partial
 * patch in which an absent field is left alone and an explicit `null` clears a
 * nullable one, the same three-valued shape `ControlAccountsPatch` uses.
 * `uploadLogo` (`branding.write`) writes the bytes through the configured
 * `StorageProvider` and points `logo_storage_key` at the result.
 *
 * There are no routes here: transport is a later stream. `branding.read` and
 * `branding.write` are added to the permission catalog by that stream as well —
 * this module references them as plain string literals.
 */

export type { BrandingRow, BrandingPatch, OrgIdentityRow } from './branding.repository';
export { getBranding, updateBranding, uploadLogo } from './branding.service';
