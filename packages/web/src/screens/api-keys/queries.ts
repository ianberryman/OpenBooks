import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  InfiniteData,
  UseInfiniteQueryResult,
  UseMutationResult,
} from '@tanstack/react-query';
import { useRef } from 'react';

import { api, idempotencyHeader, newIdempotencyKey, unwrap } from '../../api';
import type { IdempotentVariables, components } from '../../api';

/**
 * Everything OB-105 asks of `/v1/api-keys` and the roles a new key may be bound to
 * (OB-055, OB-061; ROADMAP D-55, D-61).
 *
 * Types come from `components['schemas'][…]` and are never restated by hand —
 * `recurring-invoices/queries.ts`'s reason: there is no hand-written mirror of a wire shape
 * anywhere in this package, and one would be a second contract the day either drifts.
 *
 * ## Why a key's role is chosen from the same list `members.tsx` uses
 *
 * `CreateApiKeyRequest.roleId` "is not the issuer's own role" (the schema's own words) —
 * narrowing the role narrows every key issued against it, the same guarantee D-54 gives an
 * OAuth token. That is exactly what `GET /v1/roles` already exists to offer a picker:
 * `members.tsx`'s invite form binds a person to one of these same roles, and a key is bound
 * the same way. There is no second, key-specific role list to fetch.
 */
export type ApiKey = components['schemas']['ApiKey'];
export type ApiKeyPage = components['schemas']['ApiKeyPage'];
export type ApiKeyWithSecret = components['schemas']['ApiKeyWithSecret'];
export type CreateApiKeyRequest = components['schemas']['CreateApiKeyRequestInput'];
export type AssignableRole = components['schemas']['AssignableRole'];

const API_KEYS_SCOPE = ['api-keys'] as const;
const ROLES_QUERY_KEY = ['api-keys', 'roles'] as const;

export function apiKeyListQueryKey(): readonly unknown[] {
  return [...API_KEYS_SCOPE, 'list'];
}

/** `PAGE_SIZE_MAX` on the server; over it is refused rather than clamped. */
const PAGE_LIMIT = 200;

/**
 * The roles this org may grant, for the create form's picker — `members.tsx`'s
 * `ROLES_QUERY_KEY` query, mirrored rather than imported for the self-containment reason
 * `recurring-invoices/queries.ts`'s `useTemplateReferenceData` gives: no screen folder
 * imports another's `queries.ts`.
 */
export function useAssignableRoles(): {
  readonly roles: readonly AssignableRole[];
  readonly isPending: boolean;
  readonly error: unknown;
} {
  const query = useQuery({
    queryKey: ROLES_QUERY_KEY,
    queryFn: async () => unwrap(await api.GET('/v1/roles')),
  });

  return { roles: query.data?.roles ?? [], isPending: query.isPending, error: query.error };
}

/**
 * The list, keyset-paged — revoked keys included, per `ApiKeyPage`'s own description: this
 * is a management view of everything ever issued, not a live-credential list.
 */
export function useApiKeyList(): UseInfiniteQueryResult<
  InfiniteData<ApiKeyPage, string | null>,
  Error
> {
  return useInfiniteQuery({
    queryKey: apiKeyListQueryKey(),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      unwrap(
        await api.GET('/v1/api-keys', {
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
 * copied for the same self-containment reason.
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

function invalidateApiKeys(queryClient: ReturnType<typeof useQueryClient>): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: API_KEYS_SCOPE });
}

/**
 * Issues a key. The response is an `ApiKeyWithSecret` — the one and only time the full
 * opaque value is ever returned (D-61) — and the caller must render it before this
 * mutation's result is discarded; nothing here holds onto it a second longer than that.
 */
export function useCreateApiKey(): UseMutationResult<
  ApiKeyWithSecret,
  Error,
  IdempotentVariables<CreateApiKeyRequest>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ idempotencyKey, ...body }: IdempotentVariables<CreateApiKeyRequest>) =>
      unwrap(
        await api.POST('/v1/api-keys', {
          body,
          params: { header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateApiKeys(queryClient);
    },
  });
}

/**
 * Idempotent on the server — an already-revoked key comes back unchanged rather than
 * refused — so this is safe to send again after a dropped response with the same key.
 */
export function useRevokeApiKey(): UseMutationResult<
  ApiKey,
  Error,
  IdempotentVariables<{ readonly apiKeyId: string }>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ apiKeyId, idempotencyKey }) =>
      unwrap(
        await api.POST('/v1/api-keys/{apiKeyId}/revoke', {
          params: { path: { apiKeyId }, header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await invalidateApiKeys(queryClient);
    },
  });
}
