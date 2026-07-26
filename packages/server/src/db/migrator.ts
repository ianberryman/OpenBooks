// Kysely 0.29 moved the migration API out of the package root into this subpath.
import { Migrator, type MigrationResultSet } from 'kysely/migration';
import type { Pool } from 'mysql2';

import {
  createDatabasePool,
  createKyselyOverPool,
  type DatabaseConnectionConfig,
} from './connection';
import { StaticMigrationProvider } from './migrations';
import type { MigrationDb } from './migrations/types';

export type MigrateDirection = 'up' | 'down' | 'status';

export interface MigrationReport {
  readonly direction: MigrateDirection;
  readonly applied: readonly string[];
  readonly pending: readonly string[];
  readonly failed?: { readonly name: string; readonly error: unknown };
}

/**
 * Runs schema migrations.
 *
 * Spec §12: migrations run as a discrete pre-deploy job, never on container boot.
 * This is invoked by `OPENBOOKS_ROLE=migrate`, which exits when it finishes, and
 * the API service is gated on that exit being zero — see `docker-compose.yml` for
 * the self-host expression of that ordering and `infra/terraform/` for the hosted
 * one.
 *
 * Connects as the migrator user, which is the only user in the system with DDL
 * rights. `0004_app_grants` additionally needs GRANT OPTION on the schema so it
 * can narrow the application user's privileges.
 */
export async function migrate(
  config: DatabaseConnectionConfig,
  direction: MigrateDirection,
): Promise<MigrationReport> {
  const pool: Pool = createDatabasePool({ ...config, connectionLimit: 1 });
  const db: MigrationDb = createKyselyOverPool(pool);

  try {
    const migrator = new Migrator({
      db,
      provider: new StaticMigrationProvider(),
      // Refuse to run if a migration appears that predates one already applied.
      // Out-of-order application on a schema this central is not something to
      // recover from cleverly.
      allowUnorderedMigrations: false,
    });

    if (direction === 'status') {
      const all = await migrator.getMigrations();
      return {
        direction,
        applied: all.filter((m) => m.executedAt !== undefined).map((m) => m.name),
        pending: all.filter((m) => m.executedAt === undefined).map((m) => m.name),
      };
    }

    const resultSet: MigrationResultSet =
      direction === 'up' ? await migrator.migrateToLatest() : await migrator.migrateDown();

    return toReport(direction, resultSet);
  } finally {
    await db.destroy();
  }
}

function toReport(direction: MigrateDirection, resultSet: MigrationResultSet): MigrationReport {
  const results = resultSet.results ?? [];
  const applied = results.filter((r) => r.status === 'Success').map((r) => r.migrationName);
  const pending = results.filter((r) => r.status === 'NotExecuted').map((r) => r.migrationName);
  const errored = results.find((r) => r.status === 'Error');

  if (resultSet.error !== undefined) {
    return {
      direction,
      applied,
      pending,
      failed: {
        name: errored?.migrationName ?? '<unknown>',
        error: resultSet.error,
      },
    };
  }

  return { direction, applied, pending };
}
