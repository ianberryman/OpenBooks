import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  InfiniteData,
  UseInfiniteQueryResult,
  UseMutationResult,
  UseQueryResult,
} from '@tanstack/react-query';
import { useMemo, useRef } from 'react';

import { api, idempotencyHeader, newIdempotencyKey, unwrap } from '../../api';
import type { IdempotentVariables, components } from '../../api';

/**
 * Everything OB-167 asks of `/v1/fixed-assets`, the schedule under each one, and the org's
 * depreciation-account defaults (`/v1/settings/depreciation-accounts`, OB-115).
 *
 * Types come straight off `components['schemas'][…]` — `recurring-invoices/queries.ts`'s
 * reason applies here too: there is no hand-written mirror of a wire shape in this package,
 * and one would be a second contract the day either drifts.
 *
 * ## What this screen never computes
 *
 * A schedule row's `depreciationAmountMinor` and `periodDate` are `computeDepreciation
 * Schedule`'s own arithmetic (server-side, at registration or at an update that changes a
 * scheduling parameter) — nothing here re-derives them. `postedJournalId` is null until the
 * daily sweep posts that period (D-113) and is read, never guessed at, for the same reason
 * `nextRunDate` is read rather than derived on the recurring-invoices list.
 */
export type FixedAsset = components['schemas']['FixedAsset'];
export type FixedAssetPage = components['schemas']['FixedAssetPage'];
export type FixedAssetSchedule = components['schemas']['FixedAssetSchedule'];
export type FixedAssetScheduleRow = components['schemas']['FixedAssetScheduleRow'];
export type CreateFixedAssetRequest = components['schemas']['CreateFixedAssetRequestInput'];
export type UpdateFixedAssetRequest = components['schemas']['UpdateFixedAssetRequestInput'];
export type DisposeFixedAssetRequest = components['schemas']['DisposeFixedAssetRequestInput'];
export type DepreciationAccounts = components['schemas']['DepreciationAccounts'];
export type UpdateDepreciationAccountsRequest =
  components['schemas']['UpdateDepreciationAccountsRequestInput'];
export type FixedAssetMethod = FixedAsset['method'];
export type FixedAssetStatus = FixedAsset['status'];

export type Account = components['schemas']['Account'];

/**
 * Query keys, local to this screen — `recurring-invoices/queries.ts`'s reason: there is no
 * shared key module, so a second screen changing shape never has to agree with this one
 * about what its keys mean.
 */
const FIXED_ASSETS_SCOPE = ['fixed-assets'] as const;

export function fixedAssetListQueryKey(status: FixedAssetStatus | null): readonly unknown[] {
  return [...FIXED_ASSETS_SCOPE, 'list', status];
}

function fixedAssetDetailQueryKey(fixedAssetId: string): readonly unknown[] {
  return [...FIXED_ASSETS_SCOPE, 'detail', fixedAssetId];
}

function fixedAssetScheduleQueryKey(fixedAssetId: string): readonly unknown[] {
  return [...FIXED_ASSETS_SCOPE, 'schedule', fixedAssetId];
}

const DEPRECIATION_ACCOUNTS_QUERY_KEY = ['fixed-assets', 'depreciation-accounts'] as const;
const ACCOUNTS_QUERY_KEY = ['fixed-assets', 'accounts'] as const;

/** `PAGE_SIZE_MAX` on the server; over it is refused rather than clamped. */
const PAGE_LIMIT = 200;

/** `recurring-invoices/queries.ts`'s bound: a picker that pages forever hangs the tab. */
const MAX_PAGES = 50;

async function collectActiveAccounts(): Promise<readonly Account[]> {
  const items: Account[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = unwrap(
      await api.GET('/v1/accounts', {
        params: {
          query: {
            isActive: 'true',
            limit: PAGE_LIMIT,
            ...(cursor === undefined ? {} : { cursor }),
          },
        },
      }),
    );
    items.push(...result.items);
    if (result.nextCursor === null) return items;
    cursor = result.nextCursor;
  }

  throw new Error(
    `More than ${String(MAX_PAGES * PAGE_LIMIT)} active accounts behind one picker. Refusing ` +
      `to keep paging rather than list part of the chart as though it were all of it.`,
  );
}

export interface FixedAssetReferenceData {
  /** Every active account. `assetAccountId`, `proceedsAccountId` and `gainLossAccountId`
   *  carry no type constraint on the server (the ticket names none for the first, and
   *  `disposeFixedAsset` hands the other two straight to `postJournal`), so all three
   *  pickers offer this list unfiltered. */
  readonly accounts: readonly Account[];
  readonly accountsById: ReadonlyMap<string, Account>;
  /** `type === 'asset'` — the one `assertAccountUsable` requires for `accumulated
   *  DepreciationAccountId` (D-115: "accumulated depreciation is an ordinary asset/credit
   *  account"). Not narrowed further by `normalBalance`, because the server itself does
   *  not: a debit-normal asset account is refused only once it is actually posted to. */
  readonly assetTypeAccounts: readonly Account[];
  /** `type === 'expense'` — what `assertAccountUsable` requires for `depreciationExpense
   *  AccountId`. */
  readonly expenseTypeAccounts: readonly Account[];
}

function index<T extends { readonly id: string }>(rows: readonly T[]): ReadonlyMap<string, T> {
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * The org's active chart, once, sliced three ways client-side rather than fetched three
 * times — unlike `recurring-invoices/queries.ts`'s `useTemplateReferenceData`, which needs
 * one server-side filter (`type=revenue`) and nothing else. This screen's pickers need
 * three different views of the same active accounts (unfiltered, asset-typed, expense-
 * typed), and a chart large enough to need three separate paged fetches for that would need
 * one for every other picker in the app too — `settings/discount-accounts.tsx`'s
 * `collectActiveAccounts`, mirrored rather than imported for the same self-containment
 * reason every screen folder here gives.
 */
export function useFixedAssetReferenceData(): {
  readonly data: FixedAssetReferenceData | null;
  readonly error: unknown;
  readonly refetch: () => void;
} {
  const accounts = useQuery({
    queryKey: ACCOUNTS_QUERY_KEY,
    queryFn: collectActiveAccounts,
  });

  const data = useMemo<FixedAssetReferenceData | null>(() => {
    if (accounts.data === undefined) return null;
    return {
      accounts: accounts.data,
      accountsById: index(accounts.data),
      assetTypeAccounts: accounts.data.filter((account) => account.type === 'asset'),
      expenseTypeAccounts: accounts.data.filter((account) => account.type === 'expense'),
    };
  }, [accounts.data]);

  return {
    data,
    error: accounts.error,
    refetch: () => {
      void accounts.refetch();
    },
  };
}

/**
 * The org's default depreciation accounts (D-115) — consulted by `registerFixedAsset` only
 * when a request leaves one of the two fields unset. Read here so the register form can
 * show the same default it will fall back to, and written here for the small settings panel
 * this screen carries (`depreciation-accounts-panel.tsx`) rather than the Settings screen,
 * because nothing else in the app needs to change these two accounts.
 */
export function useDepreciationAccounts(): UseQueryResult<DepreciationAccounts, Error> {
  return useQuery({
    queryKey: DEPRECIATION_ACCOUNTS_QUERY_KEY,
    queryFn: async () => unwrap(await api.GET('/v1/settings/depreciation-accounts')),
  });
}

export function useUpdateDepreciationAccounts(): UseMutationResult<
  DepreciationAccounts,
  Error,
  IdempotentVariables<UpdateDepreciationAccountsRequest>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      idempotencyKey,
      ...body
    }: IdempotentVariables<UpdateDepreciationAccountsRequest>) =>
      unwrap(
        await api.PATCH('/v1/settings/depreciation-accounts', {
          body,
          params: { header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: (saved) => {
      queryClient.setQueryData(DEPRECIATION_ACCOUNTS_QUERY_KEY, saved);
    },
  });
}

/**
 * The register, keyset-paged over `(created_at, id)` — `recurring-invoices/queries.ts`'s
 * `useTemplateList` shape: presence of `nextCursor` is the only signal that more exists.
 */
export function useFixedAssetList(
  status: FixedAssetStatus | null,
): UseInfiniteQueryResult<InfiniteData<FixedAssetPage, string | null>, Error> {
  return useInfiniteQuery({
    queryKey: fixedAssetListQueryKey(status),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      unwrap(
        await api.GET('/v1/fixed-assets', {
          params: {
            query: {
              limit: PAGE_LIMIT,
              ...(status === null ? {} : { status }),
              ...(pageParam === null ? {} : { cursor: pageParam }),
            },
          },
        }),
      ),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
}

export function useFixedAsset(fixedAssetId: string): UseQueryResult<FixedAsset, Error> {
  return useQuery({
    queryKey: fixedAssetDetailQueryKey(fixedAssetId),
    queryFn: async () =>
      unwrap(
        await api.GET('/v1/fixed-assets/{fixedAssetId}', {
          params: { path: { fixedAssetId } },
        }),
      ),
  });
}

/**
 * The whole precomputed schedule for one asset, ordered by `periodIndex` — `Σ depreciation
 * AmountMinor` over every row equals `acquisitionCostMinor − salvageValueMinor` exactly (L6,
 * `FixedAssetScheduleRow`'s own description). This screen shows what was computed; it does
 * not re-add the column to check the server's arithmetic.
 */
export function useFixedAssetSchedule(
  fixedAssetId: string,
): UseQueryResult<FixedAssetSchedule, Error> {
  return useQuery({
    queryKey: fixedAssetScheduleQueryKey(fixedAssetId),
    queryFn: async () =>
      unwrap(
        await api.GET('/v1/fixed-assets/{fixedAssetId}/schedule', {
          params: { path: { fixedAssetId } },
        }),
      ),
  });
}

/**
 * One idempotency key per user intent — `recurring-invoices/queries.ts`'s `useIntentKey`,
 * copied rather than imported for the self-containment reason this file's other hooks give.
 * The key is held against a fingerprint of what would be sent, so a retry after a dropped
 * response replays the original outcome and a corrected form gets a fresh key.
 */
export function useIntentKey(): (intent: string) => string {
  const held = useRef<{ intent: string; key: string } | null>(null);

  return (intent: string): string => {
    const current = held.current;
    if (current !== null && current.intent === intent) return current.key;

    const key = newIdempotencyKey();
    held.current = { intent, key };
    return key;
  };
}

function invalidateFixedAssets(queryClient: ReturnType<typeof useQueryClient>): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: FIXED_ASSETS_SCOPE });
}

export function useCreateFixedAsset(): UseMutationResult<
  FixedAsset,
  Error,
  IdempotentVariables<CreateFixedAssetRequest>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ idempotencyKey, ...body }: IdempotentVariables<CreateFixedAssetRequest>) =>
      unwrap(
        await api.POST('/v1/fixed-assets', {
          body,
          params: { header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateFixedAssets(queryClient);
    },
  });
}

export interface UpdateFixedAssetVariables {
  readonly fixedAssetId: string;
  readonly patch: UpdateFixedAssetRequest;
}

export function useUpdateFixedAsset(): UseMutationResult<
  FixedAsset,
  Error,
  IdempotentVariables<UpdateFixedAssetVariables>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ fixedAssetId, patch, idempotencyKey }) =>
      unwrap(
        await api.PATCH('/v1/fixed-assets/{fixedAssetId}', {
          body: patch,
          params: { path: { fixedAssetId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateFixedAssets(queryClient);
    },
  });
}

export interface DisposeFixedAssetVariables {
  readonly fixedAssetId: string;
  readonly request: DisposeFixedAssetRequest;
}

/**
 * The one-way disposal (D-116). There is no path back to `active` — `FixedAsset.status`'s
 * own description calls it "the same one-way shape a voided document takes" — so, unlike
 * `useSetTemplateActive`, this is never wired to a plain toggle; it only ever opens
 * `dispose-dialog.tsx`'s confirmation.
 */
export function useDisposeFixedAsset(): UseMutationResult<
  FixedAsset,
  Error,
  IdempotentVariables<DisposeFixedAssetVariables>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ fixedAssetId, request, idempotencyKey }) =>
      unwrap(
        await api.POST('/v1/fixed-assets/{fixedAssetId}/dispose', {
          body: request,
          params: { path: { fixedAssetId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateFixedAssets(queryClient);
    },
  });
}
