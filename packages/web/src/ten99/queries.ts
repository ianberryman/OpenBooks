import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';

import type {
  EfileTen99RunRequest,
  Ten99Run,
  Ten99RunList,
  Ten99Worksheet,
  VendorTaxProfile,
} from '@openbooks/shared-types';

import { api, idempotencyHeader, unwrap } from '../api';
import type { IdempotentVariables, components } from '../api';

// Write bodies are the openapi-generated request types (the accounts-api.ts convention), not
// the shared-types schemas: the latter's `.optional()` fields carry `| undefined`, which
// `exactOptionalPropertyTypes` refuses to pass to the client's `?: T | null` body params.
type UpsertVendorTaxProfileBody = components['schemas']['UpsertVendorTaxProfileRequestInput'];
type GenerateTen99RunBody = components['schemas']['GenerateTen99RunRequestInput'];

/**
 * Everything the 1099 Center reads and writes (OB-228 Wave-1 Stream D).
 *
 * Mirrors `screens/customer-statements/queries.ts`'s shape — local, namespaced query keys,
 * a plain `useQuery` per read (none of these lists is large enough to paginate in v1), and
 * `IdempotentVariables` on every write, minted once per user intent the way every other
 * write on this API is (spec §12).
 *
 * **Types come from `@openbooks/shared-types` directly** rather than `components['schemas']`
 * (contrast the customer-statements exemplar) because the wire contract for OB-228 already
 * lives there (`packages/shared-types/src/ten99/ten99.ts`, committed in Wave 0) and this
 * stream was scoped against it before `openapi.json`/`schema.d.ts` regenerate in Wave 2 to
 * include the `/v1/ten99/*` and `/v1/vendor-tax-profiles/*` paths. Until that regen lands,
 * `@openbooks/web` also has no dependency on `@openbooks/shared-types` in `package.json` —
 * see this file's report to the orchestrator for why that is a Wave 2 integration item
 * rather than something this stream can fix (`package.json` is a shared file, ADD-ONLY
 * forbids editing it here, and `money/format.ts` / `lib/thin-client.ts` document the
 * historical reason the dependency was never added).
 *
 * The `api.GET`/`api.POST`/`api.PUT` calls below name paths `schema.d.ts` does not have
 * yet, so they will not typecheck until Wave 2's `yarn spec` + `yarn workspace
 * @openbooks/web codegen` runs — expected, not a bug in this stream.
 */

const TEN99_WORKSHEET_KEY = ['ten99', 'worksheet'] as const;
const TEN99_RUNS_KEY = ['ten99', 'runs'] as const;
const VENDOR_TAX_PROFILES_KEY = ['ten99', 'vendor-tax-profiles'] as const;

/** The calendar-year cash-paid worksheet, for human review before a run is generated
 * (D-228-3). `thresholdMinor` is optional — absent takes the server's NEC default. */
export function useTen99Worksheet(
  taxYear: number,
  thresholdMinor?: string,
): UseQueryResult<Ten99Worksheet, Error> {
  return useQuery({
    queryKey: [...TEN99_WORKSHEET_KEY, taxYear, thresholdMinor ?? null],
    queryFn: async () =>
      unwrap(
        await api.GET('/v1/ten99/worksheet', {
          params: {
            query: {
              taxYear,
              ...(thresholdMinor === undefined ? {} : { threshold: thresholdMinor }),
            },
          },
        }),
      ),
  });
}

/** Every vendor with a stored 1099 profile. The TIN is never in this response — only
 * `taxIdLast4` (D-228-2) — so this list is safe to hold in the query cache at rest. */
export function useVendorTaxProfiles(): UseQueryResult<
  { readonly profiles: readonly VendorTaxProfile[] },
  Error
> {
  return useQuery({
    queryKey: VENDOR_TAX_PROFILES_KEY,
    queryFn: async () => unwrap(await api.GET('/v1/vendor-tax-profiles')),
  });
}

/** One vendor's profile, fetched fresh when the edit dialog opens. `null` disables the
 * query — the dialog has no contact chosen yet, the same `enabled` gate `useDocument`
 * (`sales/queries.ts`) uses for "nothing open". */
export function useVendorTaxProfile(
  contactId: string | null,
): UseQueryResult<VendorTaxProfile, Error> {
  return useQuery({
    queryKey: [...VENDOR_TAX_PROFILES_KEY, contactId],
    queryFn: async () =>
      unwrap(
        await api.GET('/v1/vendor-tax-profiles/{contactId}', {
          params: { path: { contactId: contactId as string } },
        }),
      ),
    enabled: contactId !== null,
  });
}

/** Create or update a vendor's profile. Invalidates both the profile list and the
 * worksheet — a changed eligibility, TIN or classification changes what the worksheet
 * shows for that vendor (`hasTaxId`, `likelyExempt`), so a stale worksheet after saving
 * the dialog that produced the edit would contradict what the user just typed. */
export function useUpsertVendorTaxProfile(): UseMutationResult<
  VendorTaxProfile,
  Error,
  IdempotentVariables<UpsertVendorTaxProfileBody> & { readonly contactId: string }
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ contactId, idempotencyKey, ...body }) =>
      unwrap(
        await api.PUT('/v1/vendor-tax-profiles/{contactId}', {
          body,
          params: {
            path: { contactId },
            header: idempotencyHeader(idempotencyKey),
          },
        }),
      ),
    onSuccess: async (updated) => {
      queryClient.setQueryData([...VENDOR_TAX_PROFILES_KEY, updated.contactId], updated);
      await queryClient.invalidateQueries({ queryKey: VENDOR_TAX_PROFILES_KEY });
      await queryClient.invalidateQueries({ queryKey: TEN99_WORKSHEET_KEY });
    },
  });
}

/** Generate a filing run: one immutable `Ten99Form` snapshot per eligible over-threshold
 * vendor (D-228-5). The worksheet stays what it was before the run — a run is a snapshot,
 * not a second source of truth for "who is over threshold today" — so this does not
 * invalidate `TEN99_WORKSHEET_KEY`. */
export function useCreateTen99Run(): UseMutationResult<
  Ten99Run,
  Error,
  IdempotentVariables<GenerateTen99RunBody>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ idempotencyKey, ...body }) =>
      unwrap(
        await api.POST('/v1/ten99/runs', {
          body,
          params: { header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async (created) => {
      queryClient.setQueryData([...TEN99_RUNS_KEY, created.id], created);
      await queryClient.invalidateQueries({ queryKey: TEN99_RUNS_KEY });
    },
  });
}

/** Every filing run this org has generated, newest first. */
export function useTen99Runs(): UseQueryResult<Ten99RunList, Error> {
  return useQuery({
    queryKey: TEN99_RUNS_KEY,
    queryFn: async () => unwrap(await api.GET('/v1/ten99/runs')),
  });
}

/** One run and its immutable forms, addressed by the run-detail route. */
export function useTen99Run(runId: string | null): UseQueryResult<Ten99Run, Error> {
  return useQuery({
    queryKey: [...TEN99_RUNS_KEY, runId],
    queryFn: async () =>
      unwrap(
        await api.GET('/v1/ten99/runs/{runId}', {
          params: { path: { runId: runId as string } },
        }),
      ),
    enabled: runId !== null,
  });
}

/** Submit a generated run to an e-file provider. v1 offers `manual` only from this
 * screen (D-228-6 — there is no dedicated transmit SoD key yet); the response is the
 * updated run, so the caller re-renders the new status off the mutation result rather
 * than refetching. */
export function useEfileTen99Run(): UseMutationResult<
  Ten99Run,
  Error,
  IdempotentVariables<EfileTen99RunRequest> & { readonly runId: string }
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ runId, idempotencyKey, ...body }) =>
      unwrap(
        await api.POST('/v1/ten99/runs/{runId}/efile', {
          body,
          params: {
            path: { runId },
            header: idempotencyHeader(idempotencyKey),
          },
        }),
      ),
    onSuccess: async (updated) => {
      queryClient.setQueryData([...TEN99_RUNS_KEY, updated.id], updated);
      await queryClient.invalidateQueries({ queryKey: TEN99_RUNS_KEY });
    },
  });
}
