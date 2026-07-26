import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const pkg = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Internal packages are consumed from source everywhere — tests, dev, and the
 * esbuild production bundle. These aliases are the test-time half of that.
 * Keep in sync with `paths` in tsconfig.base.json.
 */
const alias = {
  '@openbooks/plugin-api': pkg('./packages/plugin-api/src/index.ts'),
  '@openbooks/shared-types': pkg('./packages/shared-types/src/index.ts'),
};

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'server',
          root: './packages/server',
          environment: 'node',
          include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
          // Starts the one shared MySQL container and applies migrations, then
          // hands connection parameters to test files via `provide`/`inject`.
          // Nothing else can own it: each test file runs in its own process, so a
          // container started from a test would not survive to the next file.
          globalSetup: ['test/setup/global-setup.ts'],
          // Real MySQL 8 via testcontainers (spec §11 — never SQLite, never
          // mocks). Container startup dominates; the suite reuses one
          // container, so the generous timeouts apply to setup, not cases.
          testTimeout: 30_000,
          hookTimeout: 180_000,
          // The ledger suites share one database. Running files in parallel
          // would interleave writes across property-test runs.
          fileParallelism: false,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'shared-types',
          root: './packages/shared-types',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'eslint-plugin',
          root: './packages/eslint-plugin',
          environment: 'node',
          include: ['test/**/*.test.ts'],
        },
      },
    ],
  },
});
