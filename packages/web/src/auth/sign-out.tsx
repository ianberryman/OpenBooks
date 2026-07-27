import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';
import type { ReactElement } from 'react';

import { ApiError, api, idempotencyHeader, newIdempotencyKey } from '../api';
import { Button } from '../components';
import { clearForOrgSwitch } from '../query/client';
import { useResetQueryScope } from '../shell/query-scope';

/**
 * The key and nothing else — logout carries no body. Spelled out rather than reached
 * through `IdempotentVariables<…>`, whose type parameter has no empty case that is not a
 * contradiction with the key it adds.
 */
export interface SignOutVariables {
  readonly idempotencyKey: string;
}

/**
 * `POST /v1/auth/logout` returns 204, and `unwrap` refuses a body-less response by design —
 * it exists to stop a screen rendering an empty state that came from nothing. The sibling
 * helper for 204 routes belongs in `src/api/`, which this ticket may not edit, so the three
 * lines live here and the gap is reported rather than papered over with a cast.
 */
function expectNoContent(result: { readonly error?: unknown; readonly response: Response }): void {
  if (!result.response.ok || result.error !== undefined) {
    throw ApiError.from(result.response, result.error);
  }
}

/**
 * Ends the session and empties the cache.
 *
 * The clear is `clearForOrgSwitch`, and the name is narrower than the argument: what makes
 * it necessary here is the same thing it makes necessary on a switch — the cache holds rows
 * fetched under a scope that no longer applies, and the next person to sign in on this
 * machine must not be shown them. Naming a second export for it would mean editing
 * `src/query/client.ts`, which this ticket may not.
 *
 * The server clears the cookie whether or not the token names a live session, so there is no
 * failure branch that should leave the user signed in. A failed logout is still surfaced —
 * the session may genuinely still be live — but the identity refetch that follows the scope
 * reset is what decides which screen they land on, not this call's return.
 */
export function useSignOut(): UseMutationResult<void, Error, SignOutVariables> {
  const queryClient = useQueryClient();
  const resetQueryScope = useResetQueryScope();

  return useMutation({
    mutationFn: async ({ idempotencyKey }: SignOutVariables) => {
      expectNoContent(
        await api.POST('/v1/auth/logout', {
          params: { header: idempotencyHeader(idempotencyKey) },
        }),
      );
    },
    onSuccess: async () => {
      await clearForOrgSwitch(queryClient);
      resetQueryScope();
    },
  });
}

export function SignOutButton(): ReactElement {
  const signOut = useSignOut();

  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={signOut.isPending}
      onClick={() => {
        // Minted here, where the intent is formed, so a second click on a slow response
        // replays the first request instead of starting another (`src/api/idempotency.ts`).
        signOut.mutate({ idempotencyKey: newIdempotencyKey() });
      }}
    >
      Sign out
    </Button>
  );
}
