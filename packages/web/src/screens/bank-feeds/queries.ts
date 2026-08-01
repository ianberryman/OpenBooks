import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  InfiniteData,
  QueryClient,
  UseInfiniteQueryResult,
  UseMutationResult,
  UseQueryResult,
} from '@tanstack/react-query';
import { useCallback, useRef } from 'react';

import { api, idempotencyHeader, newIdempotencyKey, unwrap } from '../../api';
import type { IdempotentVariables, components } from '../../api';

/**
 * Everything the bank-feeds screen calls, and the keys it caches under (OB-227; ROADMAP
 * D-126…D-131). A live feed is a bank account plus the credential that lets this org's own
 * Stripe Financial Connections pull its statement — the analog of `processing/queries.ts`,
 * where a processor connection is two ledger accounts plus a secret.
 *
 * The keys are local by `bank-accounts/queries.ts`'s reasoning: sibling banking screens are
 * built in parallel, a shared key module is the one file all of them would edit at once, and
 * nothing in a key names the org — the org is ambient and the switcher clears the cache
 * wholesale (`src/query/client.ts`).
 *
 * `restrictedKey` is inbound-only (D-83): `ConnectBankFeedRequestInput` and
 * `CreateBankFeedLinkSessionRequestInput` carry it, and `BankFeedConnection` — everything a
 * read returns — does not, so no type here could echo it back even by accident.
 */
export type BankFeedConnection = components['schemas']['BankFeedConnection'];
export type BankFeedConnectionPage = components['schemas']['BankFeedConnectionPage'];
export type BankFeedLinkSession = components['schemas']['BankFeedLinkSession'];
export type BankFeedSyncResult = components['schemas']['BankFeedSyncResult'];
export type ConnectBankFeedBody = components['schemas']['ConnectBankFeedRequestInput'];
export type LinkSessionBody = components['schemas']['CreateBankFeedLinkSessionRequestInput'];
export type BankAccount = components['schemas']['BankAccount'];

const ROOT = 'bank-feeds';

/**
 * A write disturbs the connection list and nothing else here. The bank-account picker
 * (`bankAccounts`) is a directory loaded once and left alone — connecting a feed does not
 * change which accounts exist, only which one now has a live source.
 */
export const bankFeedKeys = {
  everything: [ROOT] as const,
  list: (isActive: boolean | null) => [ROOT, 'list', isActive] as const,
  bankAccounts: [ROOT, 'bank-accounts'] as const,
};

async function invalidateList(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: bankFeedKeys.everything });
}

/**
 * One page of connections, oldest first by creation, the server's order kept verbatim
 * (`bank-accounts/queries.ts`'s same shape). `getNextPageParam` returns `nextCursor` and
 * nothing else: presence is the only signal another page exists — a full page does not
 * imply one.
 *
 * `isActive: null` is "active and inactive alike": a disconnected feed is exactly what a
 * reader comes here to see was disconnected, and there is no reactivate — reconnecting is a
 * fresh connect.
 */
const PAGE_LIMIT = 100;

export function useBankFeedList(
  isActive: boolean | null,
): UseInfiniteQueryResult<InfiniteData<BankFeedConnectionPage, string | undefined>, Error> {
  return useInfiniteQuery({
    queryKey: bankFeedKeys.list(isActive),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      unwrap(
        await api.GET('/v1/bank-feeds', {
          params: {
            query: {
              limit: PAGE_LIMIT,
              // The route coerces this with `z.stringbool()`, so the generated parameter is a
              // string and `String(false)` is `'false'`, not an omission.
              ...(isActive === null ? {} : { isActive: String(isActive) }),
              ...(pageParam === undefined ? {} : { cursor: pageParam }),
            },
          },
        }),
      ),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

/**
 * Opens the provider's link session and returns the accounts the restricted key can already
 * pull — the connect dialog's picker (D-131). A POST, so it carries an `Idempotency-Key`
 * like every write on this surface, but it persists nothing: the credential is used to ask
 * "what can this see" and is not stored until a subsequent `connectBankFeed`.
 */
export function useBankFeedLinkSession(): UseMutationResult<
  BankFeedLinkSession,
  Error,
  IdempotentVariables<LinkSessionBody>
> {
  return useMutation({
    mutationFn: async ({ idempotencyKey, ...body }: IdempotentVariables<LinkSessionBody>) =>
      unwrap(
        await api.POST('/v1/bank-feeds/link-sessions', {
          body,
          params: { header: idempotencyHeader(idempotencyKey) },
        }),
      ),
  });
}

export function useConnectBankFeed(): UseMutationResult<
  BankFeedConnection,
  Error,
  IdempotentVariables<ConnectBankFeedBody>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ idempotencyKey, ...body }: IdempotentVariables<ConnectBankFeedBody>) =>
      unwrap(
        await api.POST('/v1/bank-feeds', {
          body,
          params: { header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateList(queryClient);
    },
  });
}

export interface BankFeedActionVariables {
  readonly bankFeedId: string;
  readonly idempotencyKey: string;
}

/**
 * A manual sync run (D-127). The daily job pulls on its own; this is the "pull now" the
 * screen offers, and its `BankFeedSyncResult` reports what one run imported and what the
 * fingerprint dedup collapsed as an already-seen overlap — never a double-post.
 */
export function useSyncBankFeed(): UseMutationResult<
  BankFeedSyncResult,
  Error,
  BankFeedActionVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ bankFeedId, idempotencyKey }) =>
      unwrap(
        await api.POST('/v1/bank-feeds/{bankFeedId}/sync', {
          params: { path: { bankFeedId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateList(queryClient);
    },
  });
}

/**
 * Disconnecting is deactivation, never deletion (D-16, D-126): the daily sync stops pulling,
 * every line already imported stays exactly as posted, and the bank account reverts to
 * `file`. There is no reactivate route — reconnecting is a fresh connect — so, unlike a
 * processor connection, this is a one-way action and the screen confirms it.
 */
export function useDeactivateBankFeed(): UseMutationResult<
  BankFeedConnection,
  Error,
  BankFeedActionVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ bankFeedId, idempotencyKey }) =>
      unwrap(
        await api.POST('/v1/bank-feeds/{bankFeedId}/deactivate', {
          params: { path: { bankFeedId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateList(queryClient);
    },
  });
}

/**
 * The bank accounts a feed can be connected over, loaded to the end. A picker, not a view,
 * so the fetcher follows `nextCursor` to the last page rather than offering the first and
 * quietly omitting the rest — the reasoning `bank-accounts/queries.ts`'s ledger-account
 * picker gives. Filtered to active accounts: an inactive account accepts nothing new.
 */
const PICKER_PAGE_LIMIT = 100;

export function useBankAccountOptions(): UseQueryResult<readonly BankAccount[], Error> {
  return useQuery({
    queryKey: bankFeedKeys.bankAccounts,
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
}

/**
 * One `Idempotency-Key` per user intent, minted afresh exactly when the intent changes — the
 * rule `bank-accounts/queries.ts` sets out. A *retry* carries the **same** key, which is how
 * the server tells "the user asked twice" from "the network dropped the response"; a
 * corrected field mints a fresh key rather than colliding on `idempotency_key_conflict`.
 */
export function useIntentKey(): (fingerprint: string) => string {
  const held = useRef<{ fingerprint: string; key: string } | null>(null);

  return useCallback((fingerprint: string): string => {
    const current = held.current;
    if (current !== null && current.fingerprint === fingerprint) return current.key;

    const key = newIdempotencyKey();
    held.current = { fingerprint, key };
    return key;
  }, []);
}
