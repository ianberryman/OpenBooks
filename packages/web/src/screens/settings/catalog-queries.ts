import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  InfiniteData,
  UseInfiniteQueryResult,
  UseMutationResult,
  UseQueryResult,
} from '@tanstack/react-query';

import { api, idempotencyHeader, unwrap } from '../../api';
import type { IdempotentVariables, components } from '../../api';

/**
 * Everything the item catalog needs of `/v1/catalog-items` (initiative Catalog, D-CAT-1…5).
 *
 * Types come straight off `components['schemas'][…]` — `estimates/queries.ts`'s reason: there
 * is no hand-written mirror of a wire shape in this package, and one would be a second
 * contract the day either drifts.
 *
 * ## Two reads of the same list, for two consumers
 *
 * The Settings screen pages the whole catalog (`useCatalogItemList`), archived rows and all,
 * because managing them is the point. A line-editor picker wants only the *active* items of
 * its own direction, small enough to filter in the browser (`useCatalogItemChoices`) —
 * `estimates/queries.ts`'s `collect()` bound applies, since a picker that pages forever hangs
 * the tab.
 */
export type CatalogItem = components['schemas']['CatalogItem'];
export type CatalogItemPage = components['schemas']['CatalogItemPage'];
export type CatalogDirection = CatalogItem['direction'];
export type CreateCatalogItemRequest = components['schemas']['CreateCatalogItemRequestInput'];
export type UpdateCatalogItemRequest = components['schemas']['UpdateCatalogItemRequestInput'];

export type Account = components['schemas']['Account'];
export type TaxRate = components['schemas']['TaxRate'];

const CATALOG_SCOPE = ['settings', 'catalog-items'] as const;

export interface CatalogItemFilters {
  readonly direction: CatalogDirection | null;
  /** `null` shows active and archived alike; a boolean restricts to one. */
  readonly isActive: boolean | null;
  /** Name/code substring, or `''` for no text filter. */
  readonly q: string;
}

function listQueryKey(filters: CatalogItemFilters): readonly unknown[] {
  return [...CATALOG_SCOPE, 'list', filters.direction, filters.isActive, filters.q];
}

function choicesQueryKey(direction: CatalogDirection): readonly unknown[] {
  return [...CATALOG_SCOPE, 'choices', direction];
}

/** `PAGE_SIZE_MAX` on the server; over it is refused rather than clamped. */
const PAGE_LIMIT = 200;

/** `estimates/queries.ts`'s bound: a picker that pages forever hangs the tab. */
const MAX_PAGES = 50;

function invalidateCatalog(queryClient: ReturnType<typeof useQueryClient>): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: CATALOG_SCOPE });
}

/**
 * One page of the org's catalog items, oldest first by creation (the wire's own order — a
 * cursor into a name-ordered list drops rows that moved behind it). Presence of `nextCursor`
 * is the only signal that more exists.
 */
export function useCatalogItemList(
  filters: CatalogItemFilters,
): UseInfiniteQueryResult<InfiniteData<CatalogItemPage, string | null>, Error> {
  return useInfiniteQuery({
    queryKey: listQueryKey(filters),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      unwrap(
        await api.GET('/v1/catalog-items', {
          params: {
            query: {
              limit: PAGE_LIMIT,
              ...(filters.direction === null ? {} : { direction: filters.direction }),
              ...(filters.isActive === null
                ? {}
                : { isActive: filters.isActive ? 'true' : 'false' }),
              ...(filters.q.trim() === '' ? {} : { q: filters.q.trim() }),
              ...(pageParam === null ? {} : { cursor: pageParam }),
            },
          },
        }),
      ),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
}

/**
 * The active items of one direction, sorted by name for a picker — `estimates/queries.ts`'s
 * `useEstimateReferenceData` `collect()` pattern: load every active row, page-bounded, and
 * order client-side, because the wire orders by creation and a picker reads better by name.
 */
export function useCatalogItemChoices(
  direction: CatalogDirection,
): UseQueryResult<readonly CatalogItem[], Error> {
  return useQuery({
    queryKey: choicesQueryKey(direction),
    queryFn: async () => {
      const all: CatalogItem[] = [];
      let cursor: string | undefined;

      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = unwrap(
          await api.GET('/v1/catalog-items', {
            params: {
              query: {
                limit: PAGE_LIMIT,
                direction,
                isActive: 'true',
                ...(cursor === undefined ? {} : { cursor }),
              },
            },
          }),
        );
        all.push(...result.items);
        if (result.nextCursor === null) {
          return [...all].sort((a, b) => a.name.localeCompare(b.name));
        }
        cursor = result.nextCursor;
      }

      throw new Error(
        `More than ${String(MAX_PAGES * PAGE_LIMIT)} active items behind one picker. Refusing to ` +
          `keep paging rather than offer part of the set as though it were all of it.`,
      );
    },
  });
}

/**
 * The account and tax-rate pickers a catalog-item form offers, for one direction. A `sales`
 * item seeds an income (revenue) account and a sales-usable rate; a `purchase` item an
 * expense account and a purchase-usable rate (D-CAT-1). Loaded here rather than passed in, so
 * the dialog is self-contained wherever it is hosted — the Settings screen and all four line
 * editors. Both lists arrive unfiltered by their own active flag so an item that already
 * names an archived account or rate still shows which one; the form offers those disabled.
 */
export interface CatalogReferenceData {
  readonly accounts: readonly Account[];
  readonly taxRates: readonly TaxRate[];
}

async function collect<T>(
  load: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor: string | null }>,
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await load(cursor);
    all.push(...result.items);
    if (result.nextCursor === null) return all;
    cursor = result.nextCursor;
  }

  throw new Error(`More than ${String(MAX_PAGES * PAGE_LIMIT)} rows behind one catalog picker.`);
}

export function useCatalogReferenceData(direction: CatalogDirection): {
  readonly data: CatalogReferenceData | null;
  readonly error: unknown;
  readonly refetch: () => void;
} {
  const accountType = direction === 'sales' ? 'revenue' : 'expense';
  const appliesTo = direction === 'sales' ? 'sales' : 'purchases';

  const accounts = useQuery({
    queryKey: [...CATALOG_SCOPE, 'accounts', accountType],
    queryFn: async () =>
      collect<Account>(async (cursor) =>
        unwrap(
          await api.GET('/v1/accounts', {
            params: {
              query: {
                limit: PAGE_LIMIT,
                type: accountType,
                ...(cursor === undefined ? {} : { cursor }),
              },
            },
          }),
        ),
      ),
  });

  const taxRates = useQuery({
    queryKey: [...CATALOG_SCOPE, 'tax-rates', appliesTo],
    queryFn: async () =>
      collect<TaxRate>(async (cursor) =>
        unwrap(
          await api.GET('/v1/tax-rates', {
            params: {
              query: {
                limit: PAGE_LIMIT,
                appliesTo,
                ...(cursor === undefined ? {} : { cursor }),
              },
            },
          }),
        ),
      ),
  });

  const data =
    accounts.data === undefined || taxRates.data === undefined
      ? null
      : { accounts: accounts.data, taxRates: taxRates.data };

  return {
    data,
    error: accounts.error ?? taxRates.error,
    refetch: () => {
      void accounts.refetch();
      void taxRates.refetch();
    },
  };
}

export function useCreateCatalogItem(): UseMutationResult<
  CatalogItem,
  Error,
  IdempotentVariables<CreateCatalogItemRequest>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      idempotencyKey,
      ...body
    }: IdempotentVariables<CreateCatalogItemRequest>) =>
      unwrap(
        await api.POST('/v1/catalog-items', {
          body,
          params: { header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateCatalog(queryClient);
    },
  });
}

export interface UpdateCatalogItemVariables {
  readonly catalogItemId: string;
  readonly patch: UpdateCatalogItemRequest;
}

export function useUpdateCatalogItem(): UseMutationResult<
  CatalogItem,
  Error,
  IdempotentVariables<UpdateCatalogItemVariables>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ catalogItemId, patch, idempotencyKey }) =>
      unwrap(
        await api.PATCH('/v1/catalog-items/{catalogItemId}', {
          body: patch,
          params: { path: { catalogItemId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateCatalog(queryClient);
    },
  });
}

/**
 * The only removal a referenced item allows (D-CAT-5): the FK is `ON DELETE RESTRICT`, so an
 * item any line already cites cannot be deleted — deactivation keeps every such line and
 * stops the item being offered for a new one.
 */
export function useDeactivateCatalogItem(): UseMutationResult<
  CatalogItem,
  Error,
  IdempotentVariables<{ readonly catalogItemId: string }>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ catalogItemId, idempotencyKey }) =>
      unwrap(
        await api.POST('/v1/catalog-items/{catalogItemId}/deactivate', {
          params: { path: { catalogItemId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateCatalog(queryClient);
    },
  });
}

export function useReactivateCatalogItem(): UseMutationResult<
  CatalogItem,
  Error,
  IdempotentVariables<{ readonly catalogItemId: string }>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ catalogItemId, idempotencyKey }) =>
      unwrap(
        await api.POST('/v1/catalog-items/{catalogItemId}/reactivate', {
          params: { path: { catalogItemId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateCatalog(queryClient);
    },
  });
}
