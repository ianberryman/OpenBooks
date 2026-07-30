import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * OB-055 — the B1 narrative, and the stack it runs against (D-26).
 *
 * ## One narrative, not a suite
 *
 * D-26: end-to-end is the slowest and most brittle test available, so it is spent on the
 * one claim nothing else can make — that a person can run a month of books in a browser.
 * The property suite (OB-053), the enforcement matrix (OB-054) and the component tests
 * carry everything else, and they carry it faster and with better failure messages. If
 * this directory ever grows a second spec file, the question to ask first is which of
 * those three it belongs in.
 *
 * ## Ports
 *
 * Deliberately not the defaults `docker-compose.yml` publishes (3100) or `vite.config.ts`
 * binds (5173). A developer running `yarn dev` while this suite runs is the ordinary case,
 * and the failure of sharing a port is not a clean refusal — Vite silently picks the next
 * free port and the run then drives a *different* application than the one it started.
 * The dev proxy's target is passed explicitly below for the same reason.
 *
 * The database is the one thing that *is* shared: the Compose `mysql` service on its
 * published `DATABASE_HOST_PORT`. Nothing here truncates it, and nothing may — the
 * narrative registers a fresh user and a fresh organization on every run, so it is correct
 * against an empty database and against one a hundred runs old, and it cannot disturb data
 * a developer is looking at. That is also what makes the suite re-runnable without a reset
 * step, which a suite that seeded fixed ids would need.
 */
const API_PORT = 3110;
const WEB_PORT = 5183;

const API_ORIGIN = `http://127.0.0.1:${String(API_PORT)}`;
const WEB_ORIGIN = `http://localhost:${String(WEB_PORT)}`;

/** `packages/e2e/` → the repository root, which both servers are launched from. */
const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

/**
 * The self-host defaults, verbatim from `.env.example` and `docker-compose.yml`.
 *
 * Stated here rather than read from the environment because `openbooks/no-process-env`
 * forbids reading it outside `packages/server/src/config/`, and because a suite whose
 * database credentials depend on the developer's shell is a suite that passes on one
 * machine. These are the same literals `docker/mysql-init/01-users.sql` creates, which is
 * why that file's comment warns that changing a password means changing it in two places.
 *
 * `DATABASE_HOST_PORT`, not `DATABASE_PORT`: 13307 is the port on this machine, where
 * `DATABASE_PORT` is what the application uses *inside* the Compose network and is always
 * 3306. `docker-compose.yml` explains at length why conflating them is a trap.
 */
const stackEnv = {
  NODE_ENV: 'development',
  LOG_LEVEL: 'warn',
  DATABASE_HOST: '127.0.0.1',
  DATABASE_PORT: '13307',
  DATABASE_NAME: 'openbooks',
  DATABASE_USER: 'openbooks_app',
  DATABASE_PASSWORD: 'change-me-app',
  DATABASE_MIGRATOR_USER: 'openbooks_migrator',
  DATABASE_MIGRATOR_PASSWORD: 'change-me-migrator',
  SESSION_SECRET: 'e2e-only-secret-0123456789abcdef0123456789abcdef',
  // Required since PAY's `SECRETS_PROVIDER=local` seam (OB-143a): the default self-host
  // secrets provider AES-GCM-encrypts per-org processor keys and refuses to start without
  // a >=32-char key. The literal is `.env.example`'s, so the stack matches the documented
  // self-host defaults the rest of this env block mirrors.
  SECRETS_ENCRYPTION_KEY: 'dev-only-change-me-fedcba9876543210fedcba9876543210',
  // Plain HTTP, so a Secure cookie would never be stored and every request after register
  // would be a 401 with nothing in the browser to say why (spec §5, `auth/cookie.ts`).
  SESSION_COOKIE_SECURE: 'false',
  EMAIL_PROVIDER: 'log',
  EMAIL_FROM_ADDRESS: 'openbooks@localhost',
  // Nothing in the B1 narrative uploads a file, but `STORAGE_PROVIDER=local` requires a
  // path and creates it, so it goes with the other artifacts under `dist/`.
  STORAGE_LOCAL_PATH: path.join(repoRoot, 'packages', 'e2e', 'dist', 'storage'),
  HTTP_HOST: '127.0.0.1',
  HTTP_PORT: String(API_PORT),
  // The app's public origin, where the customer's browser lands. Optional in general, but
  // the pay-link route (`public-pay-link.ts`) builds the processor return URL as
  // `${appBaseUrl}/i/{token}` and the `fake` processor's checkout link is that URL with a
  // session query — and `payLinkResponseSchema` validates it with `z.url()`, which rejects
  // a relative path. So the payment narrative needs an absolute base here; it is the web
  // app's own origin, since `/i/{token}` is a route in the web app, not this API.
  APP_BASE_URL: WEB_ORIGIN,
};

export default defineConfig({
  testDir: './tests',
  // The narrative is one long transaction of user intent — register, then set up, then
  // post, then read. It cannot be sharded and there is nothing to run beside it.
  workers: 1,
  fullyParallel: false,
  /**
   * No retries, and that is the decision rather than the default.
   *
   * A retried e2e that passes on the second attempt reports green and hides exactly the
   * information this test exists to produce. B1 claims a person can run a month of books;
   * "usually" is not that claim.
   */
  retries: 0,
  /**
   * Generous, because this is thirty-odd user actions each of which is a real HTTP round
   * trip through the dev proxy, plus a starter chart of sixty-six accounts and twelve
   * periods. Individual `expect`s carry the tighter bound.
   */
  timeout: 240_000,
  expect: { timeout: 15_000 },
  /**
   * Every artifact under `dist/`, which is the one directory the root already ignores from
   * all four directions: `.gitignore`, `.prettierignore`, ESLint's `ignores`, and
   * dependency-cruiser's `exclude`. Playwright's own defaults — `test-results/` and
   * `playwright-report/` — are ignored by none of them, and this ticket may not edit a
   * root config to add them. The first run proved the point: Prettier reformatted
   * `test-results/.last-run.json` on its way past.
   */
  outputDir: 'dist/test-results',
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'dist/playwright-report' }]],
  use: {
    baseURL: WEB_ORIGIN,
    // A statement is a wide table; at a phone width the report columns wrap and an
    // assertion on a figure becomes an assertion about layout.
    viewport: { width: 1440, height: 960 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: [
    {
      // Compose `mysql`, then migrations to completion, then the API. See the script.
      command: 'node ./packages/e2e/scripts/start-stack.mjs',
      cwd: repoRoot,
      url: `${API_ORIGIN}/health`,
      env: stackEnv,
      // First run pulls nothing but does apply four migrations against a cold container.
      timeout: 180_000,
      reuseExistingServer: true,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      /**
       * `--strictPort` so a busy port is an error rather than a silent move to the next
       * one, and the port is passed on the command line because `vite.config.ts` belongs
       * to another ticket's files.
       */
      command: `yarn workspace @openbooks/web exec vite --port ${String(WEB_PORT)} --strictPort`,
      cwd: repoRoot,
      url: WEB_ORIGIN,
      // The app is same-origin by design: the session cookie is `HttpOnly; SameSite=Lax`
      // and the API ships no CORS layer, so the browser must reach `/v1` through this
      // proxy and not the API directly (`packages/web/src/env.ts`).
      env: { OPENBOOKS_API_TARGET: API_ORIGIN },
      timeout: 120_000,
      reuseExistingServer: true,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
