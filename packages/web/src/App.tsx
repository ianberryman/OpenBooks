import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';

import { api, unwrap } from './api';

/**
 * The shell. **There are no screens here and there must not be** — login, the chart of
 * accounts, and the journal-entry form are all M2 (ROADMAP, "Explicitly out of M1").
 *
 * What this does instead is exercise the pipeline the ticket exists to prove: a call
 * through the client generated from `openapi.json`, run by TanStack Query, rendered. If
 * `openapi.json`, `schema.d.ts`, `openapi-fetch`, the query client, and the dev proxy are
 * not all wired correctly, this one line of output says so — which is a considerably
 * cheaper place to discover it than the first screen.
 */

/**
 * `<BrowserRouter>` with one catch-all route, and no data router.
 *
 * `createBrowserRouter` would bring route `loader`s, and a loader is a second place data
 * fetching can live. Spec §5's org switch requires that the query cache be cleared
 * wholesale on switch (see `src/query/client.ts`); data fetched by a loader is not in that
 * cache, so it would survive the clear — the exact cross-tenant leak the clear prevents.
 * One fetching mechanism, and it is TanStack Query. Revisit only if a router feature is
 * needed that the data router alone provides, and then decide what clears the loader data.
 */
export function App(): ReactElement {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="*" element={<Shell />} />
      </Routes>
    </BrowserRouter>
  );
}

function Shell(): ReactElement {
  return (
    <main>
      <h1>OpenBooks</h1>
      <p>API-only in M1. Application screens land in M2.</p>
      <ApiStatus />
    </main>
  );
}

/**
 * `GET /health` through the generated client.
 *
 * `/health` and not a `/v1` route on purpose: it is the only operation that needs neither
 * a session nor an org, so this proves the transport without implying an authenticated
 * screen. `health.data.status` is typed `'ok'` — the literal from the route's response
 * schema — so this is a type-level assertion about the server's contract as much as a
 * runtime one.
 */
function ApiStatus(): ReactElement {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: async () => unwrap(await api.GET('/health')),
  });

  if (health.isPending) return <p>Checking the API…</p>;
  if (health.isError) return <p>API unreachable: {health.error.message}</p>;

  return <p>API: {health.data.status}</p>;
}
