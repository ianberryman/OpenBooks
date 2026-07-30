import type { ReportBasis } from '@openbooks/shared-types';

import type { BalanceSheet, ProfitAndLoss, StatementOfCashFlows } from '../../reports';

/**
 * The renderer's public contract (initiative P, OB-195), split into its own file
 * for `delivery/renderer/types.ts`'s exact reason: `index.ts` (constructs the
 * pdfmake-backed implementation) and `document.ts` (builds the document
 * definition) both depend on it without depending on each other, which is what
 * keeps `no-circular` (`.dependency-cruiser.cjs`) satisfied. `index.ts`
 * re-exports both names, so nothing outside this directory needs to know the
 * split exists.
 */

/**
 * The letterhead this renderer draws on the cover page — the same shape
 * `InvoiceRenderInput`'s branding slice carries (`delivery/renderer/types.ts`),
 * restated here rather than imported from `branding.repository.ts`'s
 * `BrandingRow`. `statement-package.service.ts` reads `org_branding` through
 * `selectBranding` directly rather than through `branding.service.ts#getBranding`,
 * because `getBranding` additionally gates on `branding.read` — a permission
 * `apOnly`/`arOnly` do not hold despite holding the `reports.read` this package
 * is gated on (`0001_tenancy.ts`'s per-role grants). Typing this renderer's input
 * against `BrandingRow` would pull that mismatched gate back in through the type
 * alone, so it gets its own narrower shape instead — only the fields the cover
 * page actually draws.
 */
export interface StatementPackageBranding {
  readonly displayName: string;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly city: string | null;
  readonly region: string | null;
  readonly postalCode: string | null;
  readonly country: string | null;
  readonly brandColor: string | null;
}

/** What one render call needs: the letterhead, the three reports, and the request behind them. */
export interface StatementPackageRenderInput {
  readonly branding: StatementPackageBranding;
  /** Decoded logo bytes to embed, when the org has one. See `InvoiceRenderInput.logo`. */
  readonly logo?: Uint8Array;
  readonly periodStart: string;
  readonly periodEnd: string;
  /** The basis the P&L and cash flow ran at. The balance sheet is always accrual (D-22). */
  readonly basis: ReportBasis;
  /**
   * A calendar date for the cover page. Supplied rather than read off the clock
   * in here, so this stays a pure function of its input.
   */
  readonly generatedAt: string;
  readonly profitAndLoss: ProfitAndLoss;
  readonly balanceSheet: BalanceSheet;
  readonly cashFlow: StatementOfCashFlows;
}

/** Swappable so every consumer depends on this interface, not on pdfmake (D-71). */
export interface StatementPackageRenderer {
  /** The rendered PDF, as bytes ready to store or stream. */
  render(input: StatementPackageRenderInput): Promise<Uint8Array>;
}
