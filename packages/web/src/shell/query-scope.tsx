import type { ReactElement, ReactNode } from 'react';
import { createContext, Fragment, useContext, useMemo, useState } from 'react';

/**
 * The remount that completes an org switch.
 *
 * `clearForOrgSwitch` (see `src/query/client.ts`) is the security control: it cancels the
 * in-flight requests issued under the old scope and empties the cache, so no entry from the
 * previous org survives. What it does not do — measured, not assumed, and asserted in
 * `src/shell/org-switcher.test.tsx` — is tell anything that is already rendering. TanStack's
 * `QueryCache.clear()` destroys and removes each query but sends no update to the observers
 * attached to it, so a screen mounted before the switch goes on displaying the data it last
 * rendered until something unrelated re-renders it. That is the cross-tenant render the
 * clear exists to prevent, arriving one layer above the cache.
 *
 * Refetching the identity after the clear does not fix it either: the mounted observer holds
 * the *destroyed* query object, while `fetchQuery` builds a new one that nothing is watching.
 *
 * So the clear is paired with a remount. Bumping the epoch changes the key on the subtree
 * below, every screen unmounts, and each one's queries mount against an empty cache and ask
 * again under the new org's scope. One mechanism, at the root, that no future screen has to
 * remember — the same argument `src/query/client.ts` makes for clearing wholesale instead of
 * putting the org id into every query key.
 */
interface QueryScopeValue {
  readonly resetQueryScope: () => void;
}

const QueryScopeContext = createContext<QueryScopeValue | null>(null);

export function QueryScopeBoundary({ children }: { readonly children: ReactNode }): ReactElement {
  const [epoch, setEpoch] = useState(0);

  const value = useMemo<QueryScopeValue>(
    () => ({
      resetQueryScope: () => {
        setEpoch((previous) => previous + 1);
      },
    }),
    [],
  );

  return (
    <QueryScopeContext.Provider value={value}>
      {/* The key is the whole mechanism: React unmounts and remounts everything below it.
          A keyed `Fragment` rather than a wrapper element, so the boundary adds no node to
          the DOM and cannot participate in the shell's layout. */}
      <Fragment key={epoch}>{children}</Fragment>
    </QueryScopeContext.Provider>
  );
}

export function useResetQueryScope(): () => void {
  const value = useContext(QueryScopeContext);
  if (value === null)
    throw new Error('useResetQueryScope requires a <QueryScopeBoundary> above it.');
  return value.resetQueryScope;
}
