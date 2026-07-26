import { QueryClient } from '@tanstack/react-query';

import { ApiError } from '../api';

/**
 * TanStack Query configuration. No screens use it yet (M2 — see ROADMAP "Explicitly out
 * of M1"); this fixes the defaults before there are call sites to change.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        /**
         * Accounting data is not a live feed. A trial balance is derived from an
         * append-only ledger, so it changes only when this user posts — which invalidates
         * explicitly — or when another user in the org does, which no amount of polling
         * makes timely enough to rely on.
         */
        staleTime: 30_000,
        refetchOnWindowFocus: false,

        retry: (failureCount: number, error: Error) => failureCount < 2 && isRetryable(error),
      },
      mutations: {
        /**
         * Zero, and not because retrying a write is unsafe — every write on this API is
         * idempotent (OB-017) and a retry that reuses its key is exactly what the design
         * supports. It is because the safety is a property of the *caller*: TanStack
         * re-invokes `mutationFn` with the same variables, so the retry replays the
         * original request only if the key lives in those variables
         * (`IdempotentVariables` in `src/api/idempotency.ts`). A default that is safe only
         * under a convention nobody has adopted yet is not a default. A mutation that
         * carries its key can raise this locally.
         */
        retry: 0,
      },
    },
  });
}

/**
 * Retry transport faults and server faults; never retry a client fault.
 *
 * A 4xx does not become a different answer by being asked again, and two of them are
 * actively worse for being retried: a 409 `idempotency_key_conflict` means this key was
 * already used for a *different* request, and a 401 means the session is gone, so
 * retrying delays the redirect to login by however long the backoff takes.
 *
 * A non-`ApiError` reached here from `fetch` rejecting — DNS, TLS, an offline browser —
 * and those are the failures a retry exists for.
 */
function isRetryable(error: Error): boolean {
  if (!(error instanceof ApiError)) return true;
  return error.status >= 500;
}

/**
 * Empties the cache for an org switch. **The switcher must call this** (spec §5: "Org
 * switcher clears the query cache wholesale on switch").
 *
 * ## Why wholesale, and why this is a security control rather than a freshness one
 *
 * `POST /v1/orgs/active` re-derives the *server's* notion of the active org for this
 * session; the request context, and therefore every `where org_id = ?` the wrapper
 * injects, changes for all subsequent requests. Nothing in a cache key mentions the org,
 * because the org was never a parameter — it was ambient. So after a switch every entry
 * in this cache is another tenant's rows sitting under a key the new org's screens will
 * read.
 *
 * That is the same failure A7 and OB-013 exist to prevent, one layer up: the database
 * refuses to serve cross-org data and the UI then renders it from memory anyway. Which is
 * why `invalidateQueries` is wrong here — it marks entries stale but keeps them resident,
 * and TanStack's whole point is to *render stale data immediately* while refetching. That
 * is a cross-tenant render, for however many milliseconds the refetch takes, on every
 * screen that was mounted before the switch.
 *
 * ## Cancel before clear
 *
 * `clear()` alone leaves in-flight requests running. Those were issued under the previous
 * org's scope, and their responses resolve *after* the clear and repopulate the cache with
 * the data the clear was for. Cancelling first closes that window. It has to be awaited,
 * so the switcher must not navigate until this resolves.
 *
 * The alternative — putting the org id into every query key — was rejected because it
 * makes correctness depend on every future `queryKey` remembering to include it, and a
 * screen that forgets gets a silent leak instead of a compile error. Clearing is one call
 * in one place, and it cannot be forgotten per-screen.
 */
export async function clearForOrgSwitch(queryClient: QueryClient): Promise<void> {
  await queryClient.cancelQueries();
  queryClient.clear();
}
