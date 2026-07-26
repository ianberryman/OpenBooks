import { performance } from 'node:perf_hooks';

import type { StartedTestContainer } from 'testcontainers';
// Type-only: Vitest runs globalSetup in a context where importing the `vitest`
// runtime is an error.
import type { TestProject } from 'vitest/node';

import { migrate, type MigrationReport } from '../../src/db/migrator';
import { startMySqlContainer } from '../db/container';
import type { TestDatabaseInfo } from '../db/harness';

/**
 * One MySQL 8 container for the whole server suite (spec §11, ROADMAP OB-027:
 * "reuse a single container across the suite rather than per-file").
 *
 * This runs once in Vitest's main process, which is the only place a container can
 * outlive a test file — Vitest gives each file its own worker process, so a
 * container started from a test would be started again for the next file. What
 * crosses back is only connection parameters, via `provide`.
 *
 * The trade-off, stated because it is not free: `globalSetup` runs for every
 * invocation of this project, so the config suite pays the container's startup
 * even though it never opens a connection. See `test/README.md`.
 */

let container: StartedTestContainer | undefined;

export async function setup(project: TestProject): Promise<void> {
  const containerStart = performance.now();
  const { container: started, appConfig, migratorConfig } = await startMySqlContainer();
  container = started;
  const containerMs = performance.now() - containerStart;

  const migrateStart = performance.now();
  const report = await migrate(migratorConfig, 'up');
  const migrateMs = performance.now() - migrateStart;

  assertMigrationsApplied(report);

  const info: TestDatabaseInfo = {
    host: appConfig.host,
    port: appConfig.port,
    database: appConfig.database,
    appUser: appConfig.user,
    appPassword: appConfig.password,
    migratorUser: migratorConfig.user,
    migratorPassword: migratorConfig.password,
  };
  project.provide('openbooksTestDatabase', info);

  console.info(
    `[test-db] mysql ready in ${Math.round(containerMs)}ms; ` +
      `${report.applied.length} migration(s) applied in ${Math.round(migrateMs)}ms ` +
      `(${appConfig.host}:${String(appConfig.port)})`,
  );
}

export async function teardown(): Promise<void> {
  await container?.stop();
  container = undefined;
}

/**
 * Turns a failed migration into a readable failure instead of a puzzle.
 *
 * MySQL has no transactional DDL, so a migration that fails partway leaves the
 * statements before the failure applied while Kysely still records the migration as
 * unexecuted (see `src/db/migrations/README.md`). Re-running then fails on "table
 * already exists" rather than resuming, and nothing in the runner can fix that. So
 * the useful thing to do here is say so plainly and name the migration, because the
 * fix is to discard the container — which, for a throwaway container, means simply
 * running the suite again.
 */
function assertMigrationsApplied(report: MigrationReport): void {
  if (report.failed === undefined) {
    if (report.applied.length === 0) {
      throw new Error(
        'Migrations reported no work on a fresh container. Expected the full set from ' +
          'src/db/migrations/index.ts; something is applying schema outside the migrator.',
      );
    }
    return;
  }

  throw new Error(
    `Migration '${report.failed.name}' failed. MySQL has no transactional DDL, so the schema ` +
      'is now half-applied and re-running will fail on already-existing objects rather than ' +
      `resuming. Applied before the failure: ${report.applied.join(', ') || '(none)'}.`,
    { cause: report.failed.error },
  );
}
