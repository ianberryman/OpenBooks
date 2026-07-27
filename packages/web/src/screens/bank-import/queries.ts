import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';

import { api, idempotencyHeader, unwrap } from '../../api';
import type { IdempotentVariables, components } from '../../api';

/**
 * Everything OB-085 calls, and the keys it caches under.
 *
 * Keys are local by ticket instruction, as in `screens/money-in/queries.ts`: nothing
 * outside this folder reads them, and a shared `query-keys.ts` is the one file every
 * wave-4 screen would have edited. The org is ambient — no key names it — and the
 * switcher clears the cache wholesale (`src/query/client.ts`).
 *
 * Types come from `components['schemas'][…]` and are never restated by hand, so this
 * screen cannot describe a field the server does not serve. The request bodies use the
 * `…Input` variants openapi-fetch expects; the responses use the plain ones.
 */

export type BankAccount = components['schemas']['BankAccount'];
export type BankImportMapping = components['schemas']['BankImportMapping'];
export type BankImportMappingDefinition = components['schemas']['BankImportMappingDefinitionInput'];
export type BankAmountConvention = BankImportMappingDefinition['amountConvention'];
export type BankDateOrder = BankImportMappingDefinition['dateOrder'];
export type BankStatementFormat = components['schemas']['BankStatementImport']['format'];
export type BankStatementImportPreview = components['schemas']['BankStatementImportPreview'];
export type BankStatementLineDraft = components['schemas']['BankStatementLineDraft'];
export type BankStatementImportResult = components['schemas']['BankStatementImportResult'];
export type BankStatementImportQueued = components['schemas']['BankStatementImportQueued'];

/**
 * The lifecycle shape the poll reads.
 *
 * OB-084 routed `getBankStatementImport`, so `BankStatementImport` is a generated
 * component and this alias is the whole of the poll's dependency on it. If that type is
 * ever reshaped, `useStatementImport` below is the single place that reconciles — the
 * poll is deliberately isolated here for exactly that reason.
 */
export type BankStatementImport = components['schemas']['BankStatementImport'];
export type BankStatementImportStatus = BankStatementImport['status'];

type PreviewRequestBody = components['schemas']['PreviewBankStatementImportRequestInput'];
type StartRequestBody = components['schemas']['CreateBankStatementImportRequestInput'];
type SaveMappingBody = components['schemas']['CreateBankImportMappingRequestInput'];

const ROOT = 'bank-import';

export const bankImportKeys = {
  accounts: [ROOT, 'accounts'] as const,
  mappings: (bankAccountId: string) => [ROOT, 'mappings', bankAccountId] as const,
  import: (importId: string) => [ROOT, 'import', importId] as const,
};

const PICKER_PAGE_LIMIT = 100;

/**
 * The bank accounts a statement can be imported into.
 *
 * A picker rather than a view, so the fetcher follows `nextCursor` to the end (D-21) —
 * an account the user cannot find here is assumed not to exist. Active only: an inactive
 * account accepts no new lines (`BankAccount.isActive`), so importing into one would fail
 * after every question had been answered.
 */
export function useBankAccountOptions(): readonly BankAccount[] {
  const query = useQuery({
    queryKey: bankImportKeys.accounts,
    queryFn: async (): Promise<readonly BankAccount[]> => {
      const items: BankAccount[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = unwrap(
          await api.GET('/v1/bank-accounts', {
            params: {
              query: {
                isActive: 'true',
                limit: PICKER_PAGE_LIMIT,
                ...(cursor === undefined ? {} : { cursor }),
              },
            },
          }),
        );
        items.push(...page.items);
        if (page.nextCursor === null) return items;
        cursor = page.nextCursor;
      }
    },
  });

  return query.data ?? [];
}

/**
 * The saved column mappings for one account (OB-076).
 *
 * Reused across a bank's monthly uploads: the column layout is a property of the bank,
 * not of the file, so a returning user picks a mapping rather than rebuilding it. Ordered
 * newest-updated first, so the most-recently-used sits at the top of the offer.
 */
export function useBankImportMappings(
  bankAccountId: string | null,
): UseQueryResult<readonly BankImportMapping[], Error> {
  return useQuery({
    queryKey: bankImportKeys.mappings(bankAccountId ?? ''),
    queryFn: async (): Promise<readonly BankImportMapping[]> => {
      const items: BankImportMapping[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = unwrap(
          // Listing is a query filter, not a nested collection: the service answers an
          // unknown account with an empty page rather than a 404 (its E9 design), and a
          // path-nested list would promise a 404 it does not give. Saving a mapping stays
          // account-nested below, because it *does* 404 on an unknown account.
          await api.GET('/v1/import-mappings', {
            params: {
              query: {
                bankAccountId: bankAccountId ?? '',
                limit: PICKER_PAGE_LIMIT,
                ...(cursor === undefined ? {} : { cursor }),
              },
            },
          }),
        );
        items.push(...page.items);
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      return [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    enabled: bankAccountId !== null,
  });
}

export interface SaveMappingVariables extends SaveMappingBody {
  readonly bankAccountId: string;
}

/**
 * Saves a built mapping under a name so the next upload from this bank sends only its id.
 *
 * The mapping is a named row someone can look at and correct later (D-41), which is what
 * makes a mis-mapping fixable rather than a choice made in a wizard and forgotten. The
 * account's mapping list is invalidated on success, so the just-saved mapping appears in
 * the reuse offer immediately.
 */
export function useSaveMapping(): UseMutationResult<
  BankImportMapping,
  Error,
  IdempotentVariables<SaveMappingVariables>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ bankAccountId, idempotencyKey, ...body }) =>
      unwrap(
        await api.POST('/v1/bank-accounts/{bankAccountId}/import-mappings', {
          body,
          params: { path: { bankAccountId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async (_mapping, { bankAccountId }) => {
      await queryClient.invalidateQueries({ queryKey: bankImportKeys.mappings(bankAccountId) });
    },
  });
}

/**
 * Reads the file and reports what importing it would do, writing nothing.
 *
 * A `POST` that mutates nothing but still carries an `Idempotency-Key`, because the
 * generated types require one on every write method (`src/api/idempotency.ts`). A fresh
 * key per click is correct here: each preview is a distinct question, and the call is
 * side-effect-free so a replay and a fresh key are indistinguishable to the server.
 */
export function usePreviewImport(): UseMutationResult<
  BankStatementImportPreview,
  Error,
  IdempotentVariables<PreviewRequestBody>
> {
  return useMutation({
    mutationFn: async ({ idempotencyKey, ...body }) =>
      unwrap(
        await api.POST('/v1/bank-statement-imports/preview', {
          body,
          params: { header: idempotencyHeader(idempotencyKey) },
        }),
      ),
  });
}

/**
 * Starts the import — `202` with a queued handle, not a finished import (D-47, D-49).
 *
 * The parse runs on the worker; this call returns the moment the file is accepted, and
 * `useStatementImport` polls the handle to completion. The key is minted once per import
 * intent so a retried start is the same import, not a second one.
 */
export function useStartImport(): UseMutationResult<
  BankStatementImportQueued,
  Error,
  IdempotentVariables<StartRequestBody>
> {
  return useMutation({
    mutationFn: async ({ idempotencyKey, ...body }) =>
      unwrap(
        await api.POST('/v1/bank-statement-imports', {
          body,
          params: { header: idempotencyHeader(idempotencyKey) },
        }),
      ),
  });
}

/** How often the queued import is re-read while the worker parses it. */
export const IMPORT_POLL_INTERVAL_MS = 400;

/**
 * The poll (OB-085), isolated in one hook on purpose.
 *
 * Start-import returns a queued handle (D-49); the worker moves it `queued` →
 * `processing` → `complete`/`failed`. This re-reads `getBankStatementImport` on an
 * interval and stops the moment the status settles — a completed import needs no further
 * fetch, and polling a terminal row forever is a request with nothing behind it.
 *
 * Everything the transport agent's `getBankStatementImport` produces is read through the
 * `BankStatementImport` alias above, so a change to that generated shape is reconciled
 * here and nowhere else.
 */
export function useStatementImport(
  importId: string | null,
): UseQueryResult<BankStatementImport, Error> {
  return useQuery({
    queryKey: bankImportKeys.import(importId ?? ''),
    queryFn: async (): Promise<BankStatementImport> =>
      unwrap(
        await api.GET('/v1/bank-statement-imports/{importId}', {
          params: { path: { importId: importId ?? '' } },
        }),
      ),
    enabled: importId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'complete' || status === 'failed' ? false : IMPORT_POLL_INTERVAL_MS;
    },
  });
}
