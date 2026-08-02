import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';

import { api, idempotencyHeader, unwrap } from '../../api';
import type { IdempotentVariables, components } from '../../api';

/**
 * Stripe payout sync (OB-237; ROADMAP D-237-1, D-237-2, D-237-6) — the config a connection
 * posts payouts under, and the "payouts to review" queue that config feeds.
 *
 * `queries.ts`'s idiom, copied rather than imported: every screen folder in this app is
 * self-contained (see that module's own header), so this file carries its own account
 * loader and its own query keys instead of reaching into the connections module.
 *
 * ## Why `UpdatePayoutSyncConfigRequestInput`, not `UpdatePayoutSyncConfigRequest`
 *
 * The two differ only in that the shared-types-derived `Request` schema's `.optional()`
 * fields resolve to `T | undefined`, which `exactOptionalPropertyTypes` refuses to hand to
 * the generated client's `body?: T | null` parameter. `discount-accounts.tsx` hits the same
 * wall with a hand-written body type instead; here the body has no optional field to begin
 * with (`autoPost`/`entries`/`syncMode` are all required), but the `*Input` schema is the
 * one `openapi-fetch` actually types the request body against, so it is what this module
 * reads off `components['schemas']` rather than the response-shaped sibling.
 */
export type PayoutSyncConfig = components['schemas']['PayoutSyncConfig'];
export type PayoutSync = components['schemas']['PayoutSync'];
export type PayoutAccountMapEntry = components['schemas']['PayoutAccountMapEntry'];
export type UpdatePayoutSyncConfigRequest =
  components['schemas']['UpdatePayoutSyncConfigRequestInput'];
export type Account = components['schemas']['Account'];
export type PayoutSyncStatus = PayoutSync['status'];

/** Query keys, local to this module — `queries.ts`'s "no shared key module" reasoning. */
const configKey = (connectionId: string) =>
  ['processing', 'payout-sync', 'config', connectionId] as const;
const syncsScope = (connectionId: string) =>
  ['processing', 'payout-sync', 'syncs', connectionId] as const;
const syncsKey = (connectionId: string, status: PayoutSyncStatus | undefined) =>
  [...syncsScope(connectionId), status ?? 'all'] as const;
const ACCOUNTS_KEY = ['processing', 'payout-sync', 'accounts'] as const;

/** `PAGE_SIZE_MAX` on the server; over it is refused rather than clamped — `queries.ts`. */
const PAGE_LIMIT = 200;

/** `queries.ts`'s bound: a picker that pages forever hangs the tab. */
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
    `More than ${String(MAX_PAGES * PAGE_LIMIT)} accounts behind one picker. Refusing to keep ` +
      `paging rather than list part of the chart as though it were all of it.`,
  );
}

/** Every active ledger account, for the six reporting-category pickers on the config
 *  screen — unnarrowed, because a category's "usual" type (D-237-6) is a placement
 *  convention, not a server-enforced account-type restriction the way `clearingAccountId`/
 *  `feeAccountId` are on the connection itself. */
export function useAccounts(): {
  readonly accounts: readonly Account[];
  readonly isPending: boolean;
  readonly error: unknown;
  readonly refetch: () => void;
} {
  const query = useQuery({
    queryKey: ACCOUNTS_KEY,
    queryFn: collectActiveAccounts,
  });

  return {
    accounts: query.data ?? [],
    isPending: query.isPending,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
}

export function usePayoutSyncConfig(connectionId: string): {
  readonly config: PayoutSyncConfig | undefined;
  readonly isPending: boolean;
  readonly error: unknown;
  readonly refetch: () => void;
} {
  const query = useQuery({
    queryKey: configKey(connectionId),
    queryFn: async () =>
      unwrap(
        await api.GET('/v1/processing/connections/{connectionId}/payout-sync/config', {
          params: { path: { connectionId } },
        }),
      ),
  });

  return {
    config: query.data,
    isPending: query.isPending,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
}

export function useUpdatePayoutSyncConfig(
  connectionId: string,
): UseMutationResult<PayoutSyncConfig, Error, IdempotentVariables<UpdatePayoutSyncConfigRequest>> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      idempotencyKey,
      ...body
    }: IdempotentVariables<UpdatePayoutSyncConfigRequest>) =>
      unwrap(
        await api.PUT('/v1/processing/connections/{connectionId}/payout-sync/config', {
          params: { path: { connectionId }, header: idempotencyHeader(idempotencyKey) },
          body,
        }),
      ),
    onSuccess: async (saved) => {
      queryClient.setQueryData(configKey(connectionId), saved);
      // A changed mapping can move which category a pending sync's breakdown resolves
      // against once it is (re)posted, so the review queue is invalidated alongside the
      // config it reads mapping from — not just re-fetched optimistically.
      await queryClient.invalidateQueries({ queryKey: syncsScope(connectionId) });
    },
  });
}

export function usePayoutSyncs(
  connectionId: string,
  status?: PayoutSyncStatus,
): {
  readonly syncs: readonly PayoutSync[];
  readonly isPending: boolean;
  readonly error: unknown;
  readonly refetch: () => void;
} {
  const query = useQuery({
    queryKey: syncsKey(connectionId, status),
    queryFn: async () =>
      unwrap(
        await api.GET('/v1/processing/connections/{connectionId}/payout-syncs', {
          params: {
            path: { connectionId },
            query: status === undefined ? {} : { status },
          },
        }),
      ),
  });

  return {
    syncs: query.data ?? [],
    isPending: query.isPending,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
}

export function usePostPayoutSync(
  connectionId: string,
): UseMutationResult<PayoutSync, Error, IdempotentVariables<{ readonly payoutSyncId: string }>> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ payoutSyncId, idempotencyKey }) =>
      unwrap(
        await api.POST('/v1/processing/payout-syncs/{payoutSyncId}/post', {
          params: { path: { payoutSyncId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: syncsScope(connectionId) });
    },
  });
}

export interface SkipPayoutSyncVariables {
  readonly payoutSyncId: string;
  readonly reason?: string;
}

export function useSkipPayoutSync(
  connectionId: string,
): UseMutationResult<PayoutSync, Error, IdempotentVariables<SkipPayoutSyncVariables>> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ payoutSyncId, reason, idempotencyKey }) =>
      unwrap(
        await api.POST('/v1/processing/payout-syncs/{payoutSyncId}/skip', {
          params: { path: { payoutSyncId }, header: idempotencyHeader(idempotencyKey) },
          body: reason === undefined ? {} : { reason },
        }),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: syncsScope(connectionId) });
    },
  });
}
