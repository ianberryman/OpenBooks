/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Where the dev proxy sends `/v1` and `/health`.
 *
 * Read from the environment with the same default `docker-compose.yml` publishes for
 * `API_HOST_PORT`, so the two cannot drift: the compose stack and `yarn dev` are the
 * two ways this API gets served, and a proxy pointing at a port neither uses fails as
 * an HTML `index.html` reaching the client's JSON parse — an error that names neither
 * the port nor the cause.
 *
 * 3100 rather than 3000 because 3000 is the most contended port on a machine running
 * more than one Node project; see the comment in `docker-compose.yml`.
 */
const API_TARGET = process.env['OPENBOOKS_API_TARGET'] ?? 'http://localhost:3100';

export default defineConfig({
  // Tailwind as a Vite plugin rather than through PostCSS: the token layer is scanned and
  // compiled in the same pass that resolves `@import './tokens.css'`, so there is no
  // second config file describing where the theme lives (D-24).
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    port: 5173,
    // The app consumes the public REST API only (spec §12). In dev that means
    // proxying to the same /v1 surface an external integrator would call, so
    // there is no privileged path that only the first-party app can use.
    //
    // Same-origin is also what makes the session work without CORS: the cookie is
    // HttpOnly with SameSite=Lax (packages/server/src/modules/auth/cookie.ts) and the
    // API ships no CORS layer, so a browser calling :3000 directly from :5173 would be
    // refused the credentialed request outright. See src/env.ts.
    proxy: {
      '/v1': {
        target: API_TARGET,
        changeOrigin: true,
      },
      // `/health` as well as `/v1`, because the shell calls it (src/App.tsx) and an
      // unproxied path is not a 404 in dev — Vite's SPA fallback answers it with
      // index.html and a 200, so what fails is the client's JSON parse, and that error
      // names neither the path nor the missing rule.
      '/health': {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
  },
  /**
   * Vitest reads this file when run with `packages/web` as its root, so the package's test
   * configuration lives here rather than in a second config file. The root
   * `vitest.config.ts` has a `web` project that `extends` it, which is what puts these
   * tests inside `yarn test`.
   */
  test: {
    /**
     * `jsdom` for the whole package rather than a second project for the components
     * (OB-058). The alternative — a `node` project for `src/money` and a `jsdom` one for
     * `src/components` — buys about a second of startup and costs a rule about which
     * directory a new test file belongs in, which is the kind of rule that is discovered
     * by a test failing for the wrong reason.
     *
     * jsdom is not a browser and the components are not verified here in the sense B1
     * means; OB-055's Playwright run is. What this environment is good for is the
     * keyboard and ARIA contract of the hand-built combobox, which is a pure function of
     * events and attributes and does not need a compositor to be wrong.
     */
    environment: 'jsdom',
    // `.tsx` as well as `.ts`. The glob was `*.test.ts` alone through OB-046, so a
    // component test could not have been *discovered*, let alone run — the failure would
    // have been a green suite, which is the one that does not get investigated.
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
  },
});
