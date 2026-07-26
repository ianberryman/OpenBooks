/**
 * Web shell entrypoint. Screens arrive in M2 — see ROADMAP "Explicitly out of M1".
 *
 * This exists in M1 so the generated-client pipeline (`openapi.json` →
 * `openapi-typescript` → `openapi-fetch` → TanStack Query) is proven end to end before
 * any screen depends on it.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { createQueryClient } from './query/client';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');

/**
 * One client for the application's lifetime, created here rather than inside a component
 * so a re-render cannot replace the cache. When the org switcher lands (M2) it needs a
 * handle on this instance to call `clearForOrgSwitch`, and it gets one from
 * `useQueryClient` — the provider below is the only path to it, so there is no second
 * export of the instance for something to hold across a switch.
 */
const queryClient = createQueryClient();

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
