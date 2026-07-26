/**
 * Web shell. Screens arrive in M2 — see ROADMAP "Explicitly out of M1".
 *
 * This exists in M1 so the generated-client pipeline (openapi.json →
 * openapi-typescript → openapi-fetch) is proven end to end before any screen
 * depends on it.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');

createRoot(root).render(
  <StrictMode>
    <main>
      <h1>OpenBooks</h1>
      <p>API-only in M1. Application screens land in M2.</p>
    </main>
  </StrictMode>,
);
