/**
 * Migrate role (spec §12: a discrete pre-deploy job, never on container boot).
 *
 * Exits non-zero on failure, which is what the Compose `service_completed_
 * successfully` gate and the hosted pre-deploy task both depend on: the API must
 * not start against a schema that failed to migrate.
 */
import { getConfig } from '../config';
import { migrate, type MigrateDirection } from '../db/migrator';

export type { MigrateDirection };

export async function runMigrations(direction: MigrateDirection): Promise<void> {
  const config = getConfig();
  const { migrator } = config.database;

  if (!migrator) {
    // Unreachable via loadConfig, which requires these for the migrate role.
    // Reachable if runMigrations is called from a process running as another
    // role, which would silently attempt DDL as the application user.
    throw new Error(
      'Migrations require DATABASE_MIGRATOR_USER and DATABASE_MIGRATOR_PASSWORD. ' +
        'The application user holds no DDL rights by design (spec §12).',
    );
  }

  const report = await migrate(
    {
      host: config.database.host,
      port: config.database.port,
      database: config.database.database,
      user: migrator.user,
      password: migrator.password,
    },
    direction,
  );

  for (const name of report.applied) {
    process.stdout.write(`applied  ${name}\n`);
  }
  for (const name of report.pending) {
    process.stdout.write(`pending  ${name}\n`);
  }

  if (report.failed) {
    const { name, error } = report.failed;
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`\nmigration failed: ${name}\n${detail}\n`);
    throw new Error(`Migration ${name} failed: ${detail}`);
  }

  if (direction !== 'status' && report.applied.length === 0) {
    process.stdout.write('schema already up to date\n');
  }
}

/**
 * This module has no side effects on import, deliberately.
 *
 * A self-invocation guard here would be actively dangerous: esbuild inlines this
 * file into `dist/server/main.js`, so an `import.meta.url === argv[1]` check
 * becomes *true* in the bundle — and the migrate role would then run migrations
 * twice, once through main.ts's dispatch and once through the guard. The CLI
 * lives in `migrate-cli.ts`, which nothing else imports.
 */
