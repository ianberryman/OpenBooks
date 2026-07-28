/**
 * One-time migration importers (Phase 3).
 *
 * A directory rather than a flat module because a second source — Xero, a raw
 * CSV a bookkeeper hand-built — is the expected next addition, and each gets its
 * own subdirectory mirroring `quickbooks/`'s three-file shape (`mapping.ts`,
 * `parse.ts`, `service.ts`) rather than a shared one that would have to abstract
 * over formats nobody has written yet.
 */
export { importQuickBooks, previewQuickBooksImport } from './quickbooks/service';
