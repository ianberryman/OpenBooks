/**
 * Statement packages (initiative P, OB-195; ROADMAP P5) — a branded P&L /
 * Balance Sheet / Cash Flow bundle rendered to one PDF for a date range, stored
 * behind the `StorageProvider` and recorded in `statement_packages` so it is
 * re-downloadable and audited.
 *
 * Two operations, both gated by `reports.read` alone — `createStatementPackage`
 * renders and stores a new bundle; `listStatementPackages` returns every package
 * this org has rendered, newest first, each with a freshly signed download URL.
 * See `statement-package.service.ts` for the full contract, including why
 * branding is read off the repository directly rather than through
 * `branding.service.ts#getBranding`.
 *
 * There are no routes here: transport is a later wave. `reports.read` is already
 * in the permission catalog — this module references it as a plain string
 * literal, the same as every other report.
 */

export { createStatementPackage, listStatementPackages } from './statement-package.service';
