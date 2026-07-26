// Kysely 0.29 moved the migration API out of the package root into this subpath.
import type { Migration, MigrationProvider } from 'kysely/migration';

import * as m0001 from './0001_tenancy';
import * as m0002 from './0002_ledger';
import * as m0003 from './0003_idempotency';
import * as m0004 from './0004_app_grants';

/**
 * The migration set, registered statically.
 *
 * Kysely ships `FileMigrationProvider`, which reads migration modules off disk at
 * runtime. That cannot work here: the server is bundled into a single file by
 * esbuild (ROADMAP D-12), so there is no migrations directory in the production
 * image to read. A static registry also means a migration that fails to compile
 * fails the build rather than the deploy.
 *
 * Keys are the migration names Kysely records in `kysely_migration`. They are
 * applied in lexicographic order, so the numeric prefix is load-bearing —
 * renaming an already-applied migration makes Kysely think it is new.
 */
export const MIGRATIONS: Record<string, Migration> = {
  '0001_tenancy': m0001,
  '0002_ledger': m0002,
  '0003_idempotency': m0003,
  '0004_app_grants': m0004,
};

export class StaticMigrationProvider implements MigrationProvider {
  getMigrations(): Promise<Record<string, Migration>> {
    return Promise.resolve(MIGRATIONS);
  }
}
