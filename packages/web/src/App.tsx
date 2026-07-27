import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';

import { api, unwrap } from './api';
import { ErrorBanner } from './components';
import { AppShell } from './shell/app-shell';

/**
 * The application root. **There are still no screens here** — auth, the chart of accounts,
 * contacts, settings, the journal editor, and the reports are OB-047 through OB-052, and
 * OB-046 delivers only what they mount into.
 *
 * What this does instead is exercise the pipeline the M1 ticket proved and this one
 * re-frames: a call through the client generated from `openapi.json`, run by TanStack
 * Query, rendered inside the shell with the token-styled error surface. If `openapi.json`,
 * `schema.d.ts`, `openapi-fetch`, the query client, the dev proxy, the token layer, or the
 * theme hook are not all wired correctly, this one line of output says so.
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

/**
 * `orgIndicator` is a placeholder string rather than an empty slot, so the shell's layout
 * is exercised in the shape OB-047 will fill: the switcher goes here, and it is the
 * control that must call `clearForOrgSwitch` (spec §5).
 */
function Shell(): ReactElement {
  return (
    <AppShell orgIndicator={<span className="text-sm text-text-muted">No organization</span>}>
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold">Manual bookkeeping</h1>
        <p className="text-text-muted">
          The design system and app shell are in place. Screens land in OB-047 through OB-052.
        </p>
        <ApiStatus />
      </div>
    </AppShell>
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

  if (health.isPending) return <p className="text-text-subtle">Checking the API…</p>;

  /**
   * Through `ErrorBanner` rather than `health.error.message`. It is the first consumer of
   * the code-to-presentation table, so the mapping is exercised by the shell itself
   * instead of waiting for the first screen to be the thing that discovers it is wrong.
   */
  if (health.isError) {
    return (
      <ErrorBanner
        error={health.error}
        onRetry={() => {
          void health.refetch();
        }}
      />
    );
  }

  return <p className="text-text-muted">API: {health.data.status}</p>;
}
