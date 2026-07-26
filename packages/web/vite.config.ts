/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      // `/health` as well as `/v1`, because the shell calls it (src/App.tsx) and an
      // unproxied path is not a 404 in dev — Vite's SPA fallback answers it with
      // index.html and a 200, so what fails is the client's JSON parse, and that error
      // names neither the path nor the missing rule.
      '/health': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  /**
   * Vitest reads this file when run with `packages/web` as its root, so the package's test
   * configuration lives here rather than in a second config file.
   *
   * The root `vitest.config.ts` enumerates its projects and has no entry for this package;
   * that file is outside this ticket's scope. Adding `'./packages/web'` to its `projects`
   * array is all that is needed, plus `vitest` declared in this package's devDependencies
   * (this ticket may not edit any `package.json`). Until then:
   * `yarn vitest run --root packages/web`.
   */
  test: {
    // `node`, not `jsdom`: the tests here are pure functions, and jsdom is neither a
    // declared dependency nor a substitute for a real browser if component tests arrive.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
