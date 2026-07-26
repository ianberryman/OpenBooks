import type { Kysely } from 'kysely';
import type { Pool } from 'mysql2';

import type { DB } from './generated';
import { createDatabasePool, createKyselyOverPool } from './connection';
import type { DatabaseConnectionConfig } from './connection';

/**
 * The raw, unscoped Kysely instance.
 *
 * Spec §4: "The raw Kysely instance is never exposed to service code. All
 * tenant-table access goes through a wrapper injecting `where org_id = ctx.orgId`.
 * **The unsafe path must not exist.**"
 *
 * This module is that unsafe path, and it is fenced off two ways:
 *
 *  1. `src/db/index.ts` re-exports only `tenantDb`, `systemDb`, and types. This
 *     file is not re-exported, so there is no public name for the raw handle.
 *  2. `.dependency-cruiser.cjs` has a `no-raw-db-outside-db-module` rule making it
 *     a build failure for anything outside `src/db/` to import this file.
 *
 * Neither alone is sufficient. The first is a convention a determined caller can
 * work around with a deep import; the second turns that workaround into a failing
 * build. Together they are the closest thing to "must not exist" that a language
 * without real module privacy allows — see ROADMAP D-01 for the precise claim and
 * its limits.
 */
let instance: Kysely<DB> | undefined;
let pool: Pool | undefined;

export function initializeDatabase(config: DatabaseConnectionConfig): void {
  if (instance) {
    throw new Error('Database already initialized. initializeDatabase is a once-per-process call.');
  }
  pool = createDatabasePool(config);
  instance = createKyselyOverPool<DB>(pool);
}

/**
 * Internal accessor. Callers inside `src/db/` only — see the fencing above.
 *
 * Fails loudly rather than lazily self-initializing: a lazy connect would read
 * config at first query, which moves a configuration error from startup (where
 * spec §3 requires it to surface) to whenever the first request happens to arrive.
 */
export function rawDb(): Kysely<DB> {
  if (!instance) {
    throw new Error(
      'Database not initialized. Call initializeDatabase() during startup before serving.',
    );
  }
  return instance;
}

export function isDatabaseInitialized(): boolean {
  return instance !== undefined;
}

export async function destroyDatabase(): Promise<void> {
  const current = instance;
  instance = undefined;
  pool = undefined;
  await current?.destroy();
}
