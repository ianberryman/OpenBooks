import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';

import { api, idempotencyHeader, unwrap } from '../api';
import type { IdempotentVariables } from '../api';
import { clearForOrgSwitch } from '../query/client';
import { useResetQueryScope } from '../shell/query-scope';
import type { OrgMembership } from './identity';

export type SwitchOrgVariables = IdempotentVariables<{ readonly orgId: string }>;

/**
 * `POST /v1/orgs/active`, then the cache clear spec §5 requires.
 *
 * ## The clear is the point of this hook
 *
 * The request re-derives the *server's* active org for this session, so every subsequent
 * `where org_id = ?` the wrapper injects changes. Nothing in a query key mentions the org
 * — it was ambient, never a parameter — so on the far side of this call every entry in the
 * cache is another tenant's rows sitting under a key the new org's screens read.
 * `src/query/client.ts` argues that at length and is the authority; this hook is the one
 * call site it was written for.
 *
 * The clear runs in `onSuccess` and is awaited there, so the mutation does not settle until
 * the cache is empty and the requests issued under the old scope are cancelled. Nothing in
 * this flow navigates: switching org while reading the chart of accounts should leave the
 * user reading the chart of accounts, and the only route that has to move is
 * `/select-org`, which the guard's own catch-all handles once `activeOrgId` is no longer
 * null.
 *
 * ## Why the scope reset follows it
 *
 * Emptying the cache does not tell the screens already rendering — see the header of
 * `src/shell/query-scope.tsx` for the measurement. `resetQueryScope` remounts them so they
 * ask again, identity included.
 *
 * ## One key per intent
 *
 * The key travels in the variables (`IdempotentVariables`), minted where the user commits.
 * A retry — TanStack's, or a second click on a stuck control — then replays the *same*
 * request rather than issuing a new one, which is the whole reason the header exists
 * (`src/api/idempotency.ts`).
 */
export function useSwitchActiveOrg(): UseMutationResult<OrgMembership, Error, SwitchOrgVariables> {
  const queryClient = useQueryClient();
  const resetQueryScope = useResetQueryScope();

  return useMutation({
    mutationFn: async ({ idempotencyKey, orgId }: SwitchOrgVariables) =>
      unwrap(
        await api.POST('/v1/orgs/active', {
          body: { orgId },
          params: { header: idempotencyHeader(idempotencyKey) },
        }),
      ),
    onSuccess: async () => {
      await clearForOrgSwitch(queryClient);
      resetQueryScope();
    },
  });
}
