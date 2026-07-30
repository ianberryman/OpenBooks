import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';

import { api, idempotencyHeader, unwrap } from '../../api';
import type { IdempotentVariables, components } from '../../api';

/**
 * Everything this screen asks of `/v1/statement-packages` (initiative P, OB-195).
 *
 * A statement package is a branded P&L / Balance Sheet / Cash Flow bundle rendered to one
 * PDF for a date range — `transport/routes/statement-packages.ts`'s own description. The
 * render *is* a write: it stores an artifact and records a row, so `create` carries an
 * `Idempotency-Key` like every other write and a replayed request returns the same package
 * rather than rendering a second one. The list is unpaginated in v1 (the schema's own
 * words), so it is a plain `useQuery` rather than the keyset pattern the paged lists use.
 */

export type StatementPackage = components['schemas']['StatementPackage'];
export type StatementPackageList = components['schemas']['StatementPackageList'];
export type CreateStatementPackageRequest =
  components['schemas']['CreateStatementPackageRequestInput'];
/**
 * `reportBasisSchema` (`shared-types/reports/profit-and-loss.ts`) carries no `id`, so it
 * publishes as an inline `'accrual' | 'cash'` union wherever it is embedded rather than as
 * a named component — `reports/layout.tsx`'s `BasisBadge` takes the same inline type for
 * the same reason. Derived from the response rather than duplicated here.
 */
export type ReportBasis = StatementPackage['basis'];

const PACKAGES_QUERY_KEY = ['statement-packages', 'list'] as const;

/**
 * Every package this org has rendered, newest first — each `downloadUrl` is a freshly
 * signed URL minted on this very read, which is also the reason this list is refetched
 * (rather than merely revalidated) after a create: the row the create returned already
 * carries a working link, but the *next* time this screen is opened that link should still
 * be a fresh one and not the one the render happened to mint.
 */
export function useStatementPackages(): UseQueryResult<StatementPackageList, Error> {
  return useQuery({
    queryKey: PACKAGES_QUERY_KEY,
    queryFn: async () => unwrap(await api.GET('/v1/statement-packages')),
  });
}

export function useCreateStatementPackage(): UseMutationResult<
  StatementPackage,
  Error,
  IdempotentVariables<CreateStatementPackageRequest>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      idempotencyKey,
      ...body
    }: IdempotentVariables<CreateStatementPackageRequest>) =>
      unwrap(
        await api.POST('/v1/statement-packages', {
          body,
          params: { header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: PACKAGES_QUERY_KEY });
    },
  });
}
