import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  InfiniteData,
  UseInfiniteQueryResult,
  UseMutationResult,
} from '@tanstack/react-query';
import { useRef } from 'react';

import { api, idempotencyHeader, newIdempotencyKey, unwrap } from '../../api';
import type { IdempotentVariables, components } from '../../api';

/**
 * Everything OB-105 asks of `/v1/oauth-clients` (OB-053, OB-098, OB-104; ROADMAP D-53,
 * D-54, D-61).
 *
 * `RegisterOAuthClientRequest`'s own words: "admin-registered and never self-service" —
 * there is no consent-time client registration anywhere in this product, so this screen is
 * the only place a third-party client's `redirectUris` are ever named, and the request
 * against an unregistered target is exactly the open-redirect this closes.
 */
export type OAuthClient = components['schemas']['OAuthClient'];
export type OAuthClientPage = components['schemas']['OAuthClientPage'];
export type OAuthClientWithSecret = components['schemas']['OAuthClientWithSecret'];
export type RegisterOAuthClientRequest = components['schemas']['RegisterOAuthClientRequestInput'];

const OAUTH_CLIENTS_SCOPE = ['oauth-clients'] as const;

export function oauthClientListQueryKey(): readonly unknown[] {
  return [...OAUTH_CLIENTS_SCOPE, 'list'];
}

/** `PAGE_SIZE_MAX` on the server; over it is refused rather than clamped. */
const PAGE_LIMIT = 200;

export function useOAuthClientList(): UseInfiniteQueryResult<
  InfiniteData<OAuthClientPage, string | null>,
  Error
> {
  return useInfiniteQuery({
    queryKey: oauthClientListQueryKey(),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      unwrap(
        await api.GET('/v1/oauth-clients', {
          params: {
            query: {
              limit: PAGE_LIMIT,
              ...(pageParam === null ? {} : { cursor: pageParam }),
            },
          },
        }),
      ),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
}

/**
 * One idempotency key per user intent — `recurring-invoices/queries.ts`'s `useIntentKey`,
 * copied for the self-containment reason that module gives.
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

function invalidateOAuthClients(queryClient: ReturnType<typeof useQueryClient>): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: OAUTH_CLIENTS_SCOPE });
}

/**
 * Registers a client. The response is an `OAuthClientWithSecret` — the one and only time
 * `clientSecret` is ever returned (D-61) — the caller renders it and nothing here keeps a
 * copy past that.
 */
export function useRegisterOAuthClient(): UseMutationResult<
  OAuthClientWithSecret,
  Error,
  IdempotentVariables<RegisterOAuthClientRequest>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      idempotencyKey,
      ...body
    }: IdempotentVariables<RegisterOAuthClientRequest>) =>
      unwrap(
        await api.POST('/v1/oauth-clients', {
          body,
          params: { header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateOAuthClients(queryClient);
    },
  });
}

/**
 * `deactivatedAt` is set once and never cleared (`OAuthClient`'s own words: "a deactivated
 * client cannot obtain a new token") — this is the one-way door, unlike an API key's revoke
 * only in that there is no reversible pause step preceding it for an OAuth client at all.
 */
export function useDeactivateOAuthClient(): UseMutationResult<
  OAuthClient,
  Error,
  IdempotentVariables<{ readonly oauthClientId: string }>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ oauthClientId, idempotencyKey }) =>
      unwrap(
        await api.POST('/v1/oauth-clients/{oauthClientId}/deactivate', {
          params: { path: { oauthClientId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateOAuthClients(queryClient);
    },
  });
}
