import { useMutation } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';

import type { IdempotentVariables } from '../../api';
import { thinRequest } from '../../lib/thin-client';

/**
 * The QuickBooks CSV cutover (Phase 3 — the launch gate) — `POST /v1/imports/quickbooks/preview`
 * and `POST /v1/imports/quickbooks`.
 *
 * **Mocked**, for the reason `../settings/branding-client.ts` and `../sales/delivery-client.ts`
 * give: these two routes are authored in the transport stream in parallel with this screen and
 * are not in `schema.d.ts` yet, so `api.POST` cannot name them and will not compile against
 * them. Every type below is hand-mirrored from the pinned wire contract,
 * `packages/shared-types/src/imports/quickbooks.ts` (`quickbooksImportRequestSchema`,
 * `quickbooksImportPreviewSchema`, `quickbooksImportResultSchema`) — see `../../lib/thin-client.ts`
 * for why they are copied rather than imported (`@openbooks/shared-types` is not a dependency of
 * `@openbooks/web`).
 *
 * ORCHESTRATOR: the one-line swap once the server routes land — delete this file's request/
 * response interfaces, replace `previewQuickBooksImport`/`importQuickBooks`'s bodies with
 * `unwrap(await api.POST('/v1/imports/quickbooks/preview', ...))` and
 * `unwrap(await api.POST('/v1/imports/quickbooks', ...))`, and import
 * `QuickBooksImportRequest`/`QuickBooksImportPreview`/`QuickBooksImportResult` from `../../api`
 * (`components['schemas'][...]`) instead of from here. `quickbooks-import.tsx` and `preview.tsx`
 * import their types from this module and need no change beyond that swap.
 */

export type QuickBooksAccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
export type QuickBooksNormalBalance = 'debit' | 'credit';
export type QuickBooksImportFile = 'accounts' | 'customers' | 'vendors' | 'trialBalance';

/**
 * The request — one date and up to four CSV files, read to text client-side exactly as
 * `bank-import` reads its file (`FileReader.readAsText`). `accounts` is the only required
 * file; `customers`, `vendors` and `trialBalance` are omitted rather than sent empty when
 * their file was never chosen.
 */
export interface QuickBooksImportRequest {
  readonly asOfDate: string;
  readonly accounts: string;
  readonly customers?: string;
  readonly vendors?: string;
  readonly trialBalance?: string;
}

/** One thing wrong with one row, located by file and 1-based row (excluding the header). */
export interface QuickBooksImportIssue {
  readonly file: QuickBooksImportFile;
  readonly row: number;
  readonly message: string;
}

/** An account the import would create, after type mapping. */
export interface QuickBooksAccountDraft {
  readonly code: string;
  readonly name: string;
  readonly type: QuickBooksAccountType;
  readonly normalBalance: QuickBooksNormalBalance;
}

/** A contact (customer and/or vendor) the import would create. */
export interface QuickBooksContactDraft {
  readonly displayName: string;
  readonly code: string | null;
  readonly email: string | null;
  readonly isCustomer: boolean;
  readonly isVendor: boolean;
}

/**
 * The opening balance's own summary. `balanced` is `totalDebits === totalCredits`, and
 * `totalDebits`/`totalCredits` are minor-unit strings (D-13) — format with
 * `formatMinorUnits`, never with arithmetic. `unmatchedAccounts` names any trial-balance line
 * whose account is not in the chart.
 */
export interface QuickBooksOpeningBalancePreview {
  readonly balanced: boolean;
  readonly totalDebits: string;
  readonly totalCredits: string;
  readonly lineCount: number;
  readonly unmatchedAccounts: readonly string[];
}

/**
 * The preview: what the commit would create, and everything wrong with the input. Writes
 * nothing. `accounts.conflicts`/`contacts.conflicts` name codes already in use — the commit is
 * all-or-nothing, so any conflict fails it.
 */
export interface QuickBooksImportPreview {
  readonly accounts: {
    readonly toCreate: number;
    readonly drafts: readonly QuickBooksAccountDraft[];
    readonly conflicts: readonly string[];
  };
  readonly contacts: {
    readonly customers: number;
    readonly vendors: number;
    readonly drafts: readonly QuickBooksContactDraft[];
    readonly conflicts: readonly string[];
  };
  readonly openingBalance: QuickBooksOpeningBalancePreview | null;
  readonly issues: readonly QuickBooksImportIssue[];
}

/** The result of a committed import. `openingJournalId` is null when no trial balance was sent. */
export interface QuickBooksImportResult {
  readonly accountsCreated: number;
  readonly customersCreated: number;
  readonly vendorsCreated: number;
  readonly openingJournalId: string | null;
}

async function previewQuickBooksImport(
  body: QuickBooksImportRequest,
  idempotencyKey: string,
): Promise<QuickBooksImportPreview> {
  return thinRequest<QuickBooksImportPreview>('/v1/imports/quickbooks/preview', {
    method: 'POST',
    body,
    idempotencyKey,
  });
}

async function importQuickBooks(
  body: QuickBooksImportRequest,
  idempotencyKey: string,
): Promise<QuickBooksImportResult> {
  return thinRequest<QuickBooksImportResult>('/v1/imports/quickbooks', {
    method: 'POST',
    body,
    idempotencyKey,
  });
}

/**
 * Reads the four files and reports what importing them would do, writing nothing — the
 * dry run `quickbooksImportPreviewSchema` documents. A fresh key per click is correct here,
 * the same reasoning `usePreviewImport` gives in `bank-import/queries.ts`: each preview is a
 * distinct question and the call is side-effect-free, so a replay and a fresh key are
 * indistinguishable to the server.
 */
export function usePreviewQuickBooksImport(): UseMutationResult<
  QuickBooksImportPreview,
  Error,
  IdempotentVariables<QuickBooksImportRequest>
> {
  return useMutation({
    mutationFn: async ({ idempotencyKey, ...body }) =>
      previewQuickBooksImport(body, idempotencyKey),
  });
}

/**
 * Commits the cutover — accounts, contacts and the opening journal, all-or-nothing, in one
 * transaction (the module header's reasoning on why this is synchronous rather than queued).
 * The key is minted once per import intent by the screen, at the point `newIdempotencyKey()`
 * is called on click, so a retried commit is the same import rather than a second one.
 */
export function useImportQuickBooks(): UseMutationResult<
  QuickBooksImportResult,
  Error,
  IdempotentVariables<QuickBooksImportRequest>
> {
  return useMutation({
    mutationFn: async ({ idempotencyKey, ...body }) => importQuickBooks(body, idempotencyKey),
  });
}
