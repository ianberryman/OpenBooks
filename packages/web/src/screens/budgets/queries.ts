import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import { useMemo, useRef } from 'react';

import { api, idempotencyHeader, newIdempotencyKey, unwrap } from '../../api';
import type { IdempotentVariables, components } from '../../api';

/**
 * Everything OB-180…184 (initiative N) asks of `/v1/budgets`, the org's P&L accounts, its
 * fiscal periods and, when a per-slice figure is entered, one dimension's values.
 *
 * Types come straight off `components['schemas'][…]` — `fixed-assets/queries.ts`'s reason
 * applies here too: there is no hand-written mirror of a wire shape in this package, and
 * one would be a second contract the day either drifts.
 *
 * ## What a budget slot is, and what this screen never computes
 *
 * A `Budget` targets one `(account, period)` pair, optionally narrowed to one dimension
 * value — `SetBudgetsRequest`'s own words. Only revenue and expense accounts are budgeted
 * in v1 (D-N2, balance-sheet budgeting deferred), and `setBudgets` posts no journal: it is
 * a target the budget-vs-actual report (`reports/*`, not touched here) compares actuals
 * against. This screen enters and edits those targets; it never computes a variance.
 *
 * `listBudgets` filters by `periodId` and, optionally, `accountId` — there is no
 * `dimensionValueId` filter on the wire. A period's budgets therefore arrive unsliced, and
 * matching them to the chosen slice (account-total when no dimension value is chosen) is
 * this module's own filtering, done client-side in `budgetsForSlice`.
 */
export type Budget = components['schemas']['Budget'];
export type BudgetList = components['schemas']['BudgetList'];
export type SetBudgetsRequest = components['schemas']['SetBudgetsRequestInput'];
export type Account = components['schemas']['Account'];
export type FiscalPeriod = components['schemas']['FiscalPeriod'];
export type FiscalPeriodList = components['schemas']['FiscalPeriodList'];
export type Dimension = components['schemas']['Dimension'];
export type DimensionValue = components['schemas']['DimensionValue'];

/**
 * Query keys, local to this screen — `fixed-assets/queries.ts`'s reason: there is no
 * shared key module, so a second screen changing shape never has to agree with this one
 * about what its keys mean.
 */
const BUDGETS_SCOPE = ['budgets'] as const;

function budgetListQueryKey(
  periodId: string | null,
  accountId: string | undefined,
): readonly unknown[] {
  return [...BUDGETS_SCOPE, 'list', periodId, accountId ?? null];
}

const PERIODS_QUERY_KEY = ['budgets', 'fiscal-periods'] as const;
const ACCOUNTS_QUERY_KEY = ['budgets', 'accounts'] as const;
const DIMENSIONS_QUERY_KEY = ['budgets', 'dimensions'] as const;

function dimensionValuesQueryKey(dimensionId: string | null): readonly unknown[] {
  return ['budgets', 'dimension-values', dimensionId];
}

/** `PAGE_SIZE_MAX` on the server; over it is refused rather than clamped. */
const PAGE_LIMIT = 200;

/** `fixed-assets/queries.ts`'s bound: a picker that pages forever hangs the tab. */
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

/**
 * The org's active revenue and expense accounts — the grid's rows. Filtered client-side
 * from the same active-chart fetch every screen folder here repeats
 * (`fixed-assets/queries.ts`'s `collectActiveAccounts`, mirrored rather than imported for
 * the self-containment reason every screen folder gives), because `GET /v1/accounts` takes
 * one `type` and this screen needs two.
 */
export function usePlAccounts(): {
  readonly data: readonly Account[] | null;
  readonly error: unknown;
  readonly refetch: () => void;
} {
  const accounts = useQuery({
    queryKey: ACCOUNTS_QUERY_KEY,
    queryFn: collectActiveAccounts,
  });

  const data = useMemo<readonly Account[] | null>(() => {
    if (accounts.data === undefined) return null;
    return accounts.data.filter(
      (account) => account.type === 'revenue' || account.type === 'expense',
    );
  }, [accounts.data]);

  return {
    data,
    error: accounts.error,
    refetch: () => {
      void accounts.refetch();
    },
  };
}

/** The org's fiscal periods (`settings/periods.tsx`'s own endpoint), unpaginated in M1. */
export function useFiscalPeriods(): UseQueryResult<FiscalPeriodList, Error> {
  return useQuery({
    queryKey: PERIODS_QUERY_KEY,
    queryFn: async () => unwrap(await api.GET('/v1/fiscal-periods')),
  });
}

/**
 * Every dimension the org has defined — `reports/controls.tsx`'s `useDimensions`, mirrored
 * rather than imported for the self-containment reason every screen folder here gives.
 * Paged to the end: an org is bounded at eight axes (D-29), but this is a pick-from-all
 * control and not a first-page preview of one.
 */
export function useDimensions(): readonly Dimension[] {
  const query = useQuery({
    queryKey: DIMENSIONS_QUERY_KEY,
    queryFn: async (): Promise<readonly Dimension[]> => {
      const items: Dimension[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = unwrap(
          await api.GET('/v1/dimensions', {
            params: {
              query: {
                isActive: 'true',
                limit: PAGE_LIMIT,
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
 * One dimension's values, paged to the end — `reports/controls.tsx`'s `useDimensionValues`,
 * mirrored rather than imported for the self-containment reason every screen folder here
 * gives. `dimensionId === null` means no axis is chosen yet, so the query stays disabled
 * rather than fetching every value of whichever axis happened to render first.
 */
export function useDimensionValues(dimensionId: string | null): readonly DimensionValue[] {
  const query = useQuery({
    queryKey: dimensionValuesQueryKey(dimensionId),
    enabled: dimensionId !== null,
    queryFn: async (): Promise<readonly DimensionValue[]> => {
      if (dimensionId === null) return [];
      const items: DimensionValue[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = unwrap(
          await api.GET('/v1/dimensions/{dimensionId}/values', {
            params: {
              path: { dimensionId },
              query: { limit: PAGE_LIMIT, ...(cursor === undefined ? {} : { cursor }) },
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

export interface BudgetListParams {
  readonly periodId: string | null;
  readonly accountId?: string;
}

/**
 * Every stored budget for one period — unfiltered by dimension value, because the wire
 * offers no such filter (`listBudgets`'s own parameters). Disabled while no period is
 * chosen, the same `enabled` gate `useDimensionValues` uses for the same reason: there is
 * nothing to ask for yet.
 */
export function useBudgetList({
  periodId,
  accountId,
}: BudgetListParams): UseQueryResult<BudgetList, Error> {
  return useQuery({
    queryKey: budgetListQueryKey(periodId, accountId),
    enabled: periodId !== null,
    queryFn: async () =>
      unwrap(
        await api.GET('/v1/budgets', {
          params: {
            query: {
              // `enabled` guarantees `periodId` is non-null whenever this actually runs.
              periodId: periodId as string,
              ...(accountId === undefined ? {} : { accountId }),
            },
          },
        }),
      ),
  });
}

/**
 * The rows of `list` that belong to one slice: the account-total budgets when
 * `dimensionValueId` is `null`, or the per-value budgets tagged to it otherwise. Kept as a
 * small pure function rather than folded into the query, so the screen can recompute it
 * the instant the slice picker changes without waiting on a refetch.
 */
export function budgetsForSlice(
  list: readonly Budget[],
  dimensionValueId: string | null,
): readonly Budget[] {
  return list.filter((budget) => budget.dimensionValueId === dimensionValueId);
}

/**
 * One idempotency key per user intent — `fixed-assets/queries.ts`'s `useIntentKey`, copied
 * rather than imported for the self-containment reason this file's other hooks give. The
 * key is held against a fingerprint of what would be sent, so a retry after a dropped
 * response replays the original outcome and a corrected batch gets a fresh key.
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

/**
 * The one write this screen makes: a batch upsert of every slot the user set or changed
 * (D-N5). Each entry replaces whatever the slot held before, so a row the user never
 * touched is never sent — the grid tracks that itself and this hook takes exactly the
 * entries it is given.
 */
export function useSetBudgets(): UseMutationResult<
  BudgetList,
  Error,
  IdempotentVariables<SetBudgetsRequest>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ idempotencyKey, ...body }: IdempotentVariables<SetBudgetsRequest>) =>
      unwrap(
        await api.POST('/v1/budgets', {
          body,
          params: { header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: BUDGETS_SCOPE });
    },
  });
}
