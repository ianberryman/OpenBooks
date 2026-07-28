import type { PublicInvoiceView } from '@openbooks/shared-types';

/**
 * The renderer's public contract (OB-125), split into its own file so `index.ts`
 * (constructs the pdfmake-backed implementation) and `document.ts` (builds the
 * document definition) can both depend on it without depending on each other —
 * `no-circular` in `.dependency-cruiser.cjs` is an error-severity check, and
 * `index.ts` importing `buildInvoiceDocDefinition` from `document.ts` while
 * `document.ts` imported `InvoiceRenderInput` back from `index.ts` would be
 * exactly that cycle. `index.ts` re-exports both names, so nothing outside this
 * directory needs to know the split exists.
 */

/** What one render call needs: the customer-safe invoice, and a logo to embed. */
export interface InvoiceRenderInput {
  /** The customer-safe invoice — `packages/shared-types/src/delivery/delivery.ts`. */
  readonly view: PublicInvoiceView;
  /**
   * Decoded logo bytes to embed, when the org has one. Never `branding.logoUrl` —
   * that is a URL a caller resolved from storage; embedding requires the bytes
   * themselves, and fetching them is not this module's job (it has no
   * `StorageProvider`).
   */
  readonly logo?: Uint8Array;
}

/** Swappable so every consumer depends on this interface, not on pdfmake (D-71). */
export interface InvoiceRenderer {
  /** The rendered PDF, as bytes ready to store or stream. */
  render(input: InvoiceRenderInput): Promise<Uint8Array>;
}
