import type { AgingAmounts, AgingDocument } from '@openbooks/shared-types';

/**
 * The renderer's public contract (OB-220), split into its own file for
 * `statements/renderer/types.ts`'s exact reason: `index.ts` (constructs the
 * pdfmake-backed implementation) and `document.ts` (builds the document
 * definition) both depend on it without depending on each other, which is what
 * keeps `no-circular` (`.dependency-cruiser.cjs`) satisfied. `index.ts`
 * re-exports both names, so nothing outside this directory needs to know the
 * split exists.
 */

/**
 * The letterhead this renderer draws — the same shape and the same reason
 * `StatementPackageBranding` (`modules/statements/renderer/types.ts`) takes its
 * own narrower copy rather than `BrandingRow`: `account-statement.service.ts`
 * reads `org_branding` through `selectBranding` directly rather than through
 * `branding.service.ts#getBranding`, because `getBranding` additionally gates on
 * `branding.read` — a permission `apOnly`/`arOnly` do not hold despite holding the
 * `reports.read` this statement is gated on (`0001_tenancy.ts`'s per-role
 * grants). Typing this renderer's input against `BrandingRow` would pull that
 * mismatched gate back in through the type alone, so it gets its own narrower
 * shape instead — only the fields the letterhead actually draws.
 */
export interface CustomerStatementBranding {
  readonly displayName: string;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly city: string | null;
  readonly region: string | null;
  readonly postalCode: string | null;
  readonly country: string | null;
  readonly brandColor: string | null;
}

/**
 * What one render call needs: the letterhead, the customer, and the open items
 * behind the closing balance.
 *
 * `documents` and `bucketTotals` are `getAging`'s own `AgingRow.documents` and
 * `AgingRow.amounts` (`@openbooks/shared-types`, `subledger/aging.ts`), passed
 * through rather than copied into a parallel shape — a customer statement *is*
 * the aging report for one contact with `detail: true` (`aging.service.ts`'s file
 * header: "There is no second report for 'what does this customer owe and since
 * when'"), so a row this renderer prints is a row a `reports.read` holder could
 * already see on `/v1/reports/aging`, and a second type here would only be a
 * second place for the two to drift apart.
 */
export interface StatementRenderInput {
  readonly branding: CustomerStatementBranding;
  /** Decoded logo bytes to embed, when the org has one. See `InvoiceRenderInput.logo`. */
  readonly logo?: Uint8Array;
  readonly contactName: string;
  readonly asOf: string;
  /**
   * A calendar date for the letterhead. Supplied rather than read off the clock in
   * here, so this stays a pure function of its input (`statements/renderer/index.ts`'s
   * determinism section explains why that matters: pdfmake's own creation-date
   * stamping is fixed at the printer, not here, for the identical reason).
   */
  readonly generatedAt: string;
  readonly documents: readonly AgingDocument[];
  readonly bucketTotals: AgingAmounts;
  readonly closingBalanceMinor: string;
}

/** Swappable so every consumer depends on this interface, not on pdfmake (D-71). */
export interface StatementRenderer {
  /** The rendered PDF, as bytes ready to store or stream. */
  render(input: StatementRenderInput): Promise<Uint8Array>;
}
