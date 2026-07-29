import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  InfiniteData,
  UseInfiniteQueryResult,
  UseMutationResult,
} from '@tanstack/react-query';
import { useRef } from 'react';

import { api, expectNoContent, idempotencyHeader, newIdempotencyKey, unwrap } from '../../api';
import type { IdempotentVariables, components } from '../../api';

/**
 * Everything OB-105 asks of `/v1/connected-apps` (OB-098, OB-104; ROADMAP D-54, D-61).
 *
 * `ConnectedApp`'s own words: "the apps the caller has authorized" — the user's own view
 * of every third-party client they have personally granted a consent to, never every
 * client registered in the org (`oauth-clients.tsx` is that, developer-facing, screen).
 * `scope` is "the permission keys this consent granted... not the user's full role"
 * (D-54): a narrower set than whatever the user could themselves do.
 */
export type ConnectedApp = components['schemas']['ConnectedApp'];
export type ConnectedAppPage = components['schemas']['ConnectedAppPage'];

const CONNECTED_APPS_SCOPE = ['connected-apps'] as const;

export function connectedAppListQueryKey(): readonly unknown[] {
  return [...CONNECTED_APPS_SCOPE, 'list'];
}

/** `PAGE_SIZE_MAX` on the server; over it is refused rather than clamped. */
const PAGE_LIMIT = 200;

export function useConnectedAppList(): UseInfiniteQueryResult<
  InfiniteData<ConnectedAppPage, string | null>,
  Error
> {
  return useInfiniteQuery({
    queryKey: connectedAppListQueryKey(),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      unwrap(
        await api.GET('/v1/connected-apps', {
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

/**
 * Revokes this consent and every token it produced. `revokeConnectedApp`'s own
 * description: a client never consented to, or already revoked, is a no-op rather than a
 * `not_found` — reporting the existence of someone else's consent is exactly what A7
 * avoids — so a 204 is the only outcome this ever needs to react to.
 */
export function useRevokeConnectedApp(): UseMutationResult<
  void,
  Error,
  IdempotentVariables<{ readonly clientId: string }>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ clientId, idempotencyKey }) => {
      expectNoContent(
        await api.POST('/v1/connected-apps/{clientId}/revoke', {
          params: { path: { clientId }, header: idempotencyHeader(idempotencyKey) },
        }),
      );
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: CONNECTED_APPS_SCOPE });
    },
  });
}
