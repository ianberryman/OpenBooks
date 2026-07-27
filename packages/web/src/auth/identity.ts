import { useQuery } from '@tanstack/react-query';
import type { QueryClient, UseQueryResult } from '@tanstack/react-query';

import { api, unwrap } from '../api';
import type { components } from '../api';

/**
 * `GET /v1/auth/me` — the caller, their organizations, the active one, and what they may
 * do in it. Everything the guard and the shell decide is decided from this one answer.
 */
export type CallerIdentity = components['schemas']['CallerIdentity'];
export type OrgMembership = components['schemas']['OrgMembership'];

/**
 * Declared here rather than in a shared key module: OB-047 owns routing while five other
 * screens are being written in parallel, and a common key file is the one thing all six
 * would edit at once.
 */
export const IDENTITY_QUERY_KEY = ['auth', 'me'] as const;

/**
 * `null` for "no session", and that is a *value* rather than a thrown error on purpose.
 *
 * The guard has to tell three states apart: signed out, signed in, and unable to ask. If a
 * 401 threw, the first and third would arrive on the same branch — `isError` — and the
 * guard would have to re-inspect the error to decide whether to render a login form or a
 * retry banner. Worse, `retry` in `src/query/client.ts` is deliberately generous to
 * transport faults, so a signed-out visitor would sit through backoff before seeing the
 * form they were always going to be shown.
 *
 * The session itself is never read here. It is an `HttpOnly` cookie (D-03), so this call
 * carries it only because `credentials: 'include'` is set on the client; there is no token
 * for this module to hold, store, or attach.
 */
export async function fetchIdentity(): Promise<CallerIdentity | null> {
  const result = await api.GET('/v1/auth/me');
  if (result.response.status === 401) return null;
  return unwrap(result);
}

export function useIdentity(): UseQueryResult<CallerIdentity | null> {
  return useQuery({ queryKey: IDENTITY_QUERY_KEY, queryFn: fetchIdentity });
}

/**
 * Re-reads the identity after a call that changed the session, and publishes it.
 *
 * The identity is re-fetched rather than taken from the login or register response because
 * the two are different documents: those return `Identity`, `GET /v1/auth/me` returns
 * `CallerIdentity`, and the difference is `permissions` — precisely what the navigation is
 * filtered by. Seeding the cache from the write's own body would leave the shell with no
 * permission set until something else happened to refetch.
 *
 * `setQueryData` and not `invalidateQueries`: the caller has the answer in hand, and an
 * invalidation would issue a second identical request before the guard could re-render.
 */
export async function adoptSession(queryClient: QueryClient): Promise<CallerIdentity | null> {
  const identity = await fetchIdentity();
  queryClient.setQueryData(IDENTITY_QUERY_KEY, identity);
  return identity;
}

/**
 * The caller's permissions as a set, for the navigation filter.
 *
 * **Advisory only (D-25).** This exists so the shell does not offer actions that always
 * fail; it is not a gate and nothing in this package treats it as one — no route consults
 * it, so every screen stays reachable by URL and answers with whatever the service says.
 * `requirePermission` is service-layer and lint-enforced, and OB-054's matrix asserts every
 * operation against every seeded role *there*, where hiding a button proves nothing.
 */
export function permissionSet(identity: CallerIdentity | null): ReadonlySet<string> {
  return new Set(identity?.permissions ?? []);
}
