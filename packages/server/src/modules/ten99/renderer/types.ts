import type { Ten99BoxCode, Ten99FormType } from '@openbooks/shared-types';

/**
 * The renderer's public contract (OB-228), split into its own file for
 * `account-statements/renderer/types.ts`'s exact reason: `index.ts` (constructs the
 * pdfmake-backed implementation) and `document.ts` (builds the document definition) both
 * depend on it without depending on each other, which is what keeps `no-circular`
 * (`.dependency-cruiser.cjs`) satisfied. `index.ts` re-exports both names, so nothing
 * outside this directory needs to know the split exists.
 */

/**
 * The letterhead this renderer draws — the same shape and the same reason
 * `CustomerStatementBranding` (`account-statements/renderer/types.ts`) takes its own
 * narrower copy rather than `BrandingRow`: `ten99.service.ts` reads `org_branding` through
 * `selectBranding` directly rather than through `branding.service.ts#getBranding`, because
 * `getBranding` additionally gates on `branding.read` — a permission a `ten99.read` holder
 * does not necessarily hold. Typing this renderer's input against `BrandingRow` would pull
 * that mismatched gate back in through the type alone, so it gets its own narrower shape
 * instead — only the fields the letterhead actually draws.
 */
export interface Ten99FormBranding {
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
 * What one render call needs: the payer letterhead and one recipient's filed amount — a
 * recipient **Copy B** style 1099-NEC/MISC, the copy the vendor themselves receives.
 */
export interface Ten99FormRenderInput {
  readonly branding: Ten99FormBranding;
  /** Decoded logo bytes to embed, when the org has one. See `InvoiceRenderInput.logo`. */
  readonly logo?: Uint8Array;
  readonly taxYear: number;
  readonly formType: Ten99FormType;
  readonly boxCode: Ten99BoxCode;
  /** Cents-only string (D-13) — the reported box amount. */
  readonly amountMinor: string;
  readonly recipientLegalName: string;
  readonly recipientTinLast4: string | null;
  /** The address snapshot taken at generate time, one line per `\n`. See `ten99.service.ts`. */
  readonly recipientAddress: string | null;
}

/** Swappable so every consumer depends on this interface, not on pdfmake (D-71). */
export interface Ten99FormRenderer {
  /** The rendered PDF, as bytes ready to store or stream. */
  render(input: Ten99FormRenderInput): Promise<Uint8Array>;
}
