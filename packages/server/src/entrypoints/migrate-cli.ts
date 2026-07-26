/**
 * CLI wrapper for migrations, used by `yarn migrate` in development and CI.
 *
 * Separate from `migrate.ts` because that module is inlined into the production
 * bundle and must stay side-effect-free on import. Nothing imports this file; it
 * is only ever a process entrypoint.
 */
import { runMigrations, type MigrateDirection } from './migrate';

const DIRECTIONS: readonly MigrateDirection[] = ['up', 'down', 'status'];

function parseDirection(argument: string | undefined): MigrateDirection {
  if (argument === undefined) return 'up';
  const match = DIRECTIONS.find((candidate) => candidate === argument);
  if (!match) {
    throw new Error(`Unknown migrate direction '${argument}'. Expected: ${DIRECTIONS.join(', ')}.`);
  }
  return match;
}

try {
  await runMigrations(parseDirection(process.argv[2]));
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
