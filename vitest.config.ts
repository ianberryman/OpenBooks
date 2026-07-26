import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const pkg = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Internal packages are consumed from source everywhere — tests, dev, and the
 * esbuild production bundle. These aliases are the test-time half of that.
 * Keep in sync with `paths` in tsconfig.base.json.
 *
 * Subpaths are mapped as well as bare specifiers, and that pairing is the point:
 * `tsconfig.base.json` declares `@openbooks/shared-types/*`, so a subpath import
 * *typechecks*. With only the bare specifier aliased here it then failed to
 * resolve at run time — a module that compiles and does not exist, which is the
 * worst available failure mode. The array form is required because the object
 * form matches exact strings only.
 */
const alias = [
  { find: /^@openbooks\/plugin-api$/, replacement: pkg('./packages/plugin-api/src/index.ts') },
  { find: /^@openbooks\/plugin-api\/(.*)$/, replacement: pkg('./packages/plugin-api/src/$1') },
  { find: /^@openbooks\/shared-types$/, replacement: pkg('./packages/shared-types/src/index.ts') },
  {
    find: /^@openbooks\/shared-types\/(.*)$/,
    replacement: pkg('./packages/shared-types/src/$1'),
  },
];

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
