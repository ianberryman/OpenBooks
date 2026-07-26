import { type Kysely, sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, inject } from 'vitest';

import {
  createDatabasePool,
  createKyselyOverPool,
  type DatabaseConnectionConfig,
} from '../../src/db/connection';
import type { DB } from '../../src/db/generated';
import { createFactories, type Factories } from './factories';

/**
 * The per-file half of the test database harness.
 *
 * `test/setup/global-setup.ts` owns the container and the migrations; this owns
 * the connections, which cannot be shared across files because Vitest runs each
 * test file in its own process. What crosses that boundary is only connection
 * parameters, injected through Vitest's provided context.
 */

/**
 * Connection parameters for the one container the suite shares. Structured
 * clone-able, because that is what `provide`/`inject` transports.
 */
export interface TestDatabaseInfo {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly appUser: string;
  readonly appPassword: string;
  readonly migratorUser: string;
  readonly migratorPassword: string;
}

declare module 'vitest' {
  interface ProvidedContext {
    openbooksTestDatabase: TestDatabaseInfo;
  }
}

/** A connection handle that is genuinely separate from the shared pools. */
export interface AppConnection {
  readonly db: Kysely<DB>;
  close(): Promise<void>;
}

export interface TestDatabase {
  /**
   * Connected as `openbooks_app` — the identity the application runs as, so
   * anything a test proves here is a claim about production (spec §11, §12).
   */
  readonly app: Kysely<DB>;

  /**
   * Connected as `openbooks_migrator`. For setting up state the app user is not
   * permitted to create, and for the between-test reset — which has to be the
   * migrator, since the app user holds no DELETE on the journal tables by design.
   * Not for exercising application behaviour.
   */
  readonly migrator: Kysely<DB>;

  readonly factories: Factories;

  readonly info: TestDatabaseInfo;

  readonly appConnectionConfig: DatabaseConnectionConfig;

  /**
   * Opens an additional single-connection handle as `openbooks_app`.
   *
   * OB-026 needs this twice over: to assert that `UPDATE`/`DELETE` on the journal
   * tables is refused for this identity, and to run genuinely concurrent writes.
   * A pooled handle cannot do the latter — two statements may land on the same
   * physical connection and serialize instead of racing — so each of these is one
   * connection, and closed by the harness if the test forgets.
   */
  openAppConnection(): Promise<AppConnection>;

  /** Deletes every non-seed row. Called before each test; exposed for mid-test use. */
  reset(): Promise<void>;
}

/**
 * Tables the migrations seed and no test may clear.
 *
 * `permissions` is the fixed catalog (48 rows) and `roles`/`role_permissions` hold
 * the six system roles. Clearing them would not merely reset state, it would undo
 * part of `0001_tenancy` — and the app user has no way to put them back. Custom
 * roles (`org_id IS NOT NULL`) are test data and are cleared.
 */
const SEEDED_TABLES: ReadonlySet<string> = new Set(['permissions', 'roles', 'role_permissions']);

/** Kysely's own bookkeeping. Clearing it would make the migrations look unapplied. */
const MIGRATION_TABLES: ReadonlySet<string> = new Set([
  'kysely_migration',
  'kysely_migration_lock',
]);

/**
 * Registers the harness for the current test file and returns a handle.
 *
 * ```ts
 * const db = useTestDatabase();
 * it('...', async () => { const org = await db.factories.org(); });
 * ```
 *
 * The handle is live from the first `beforeAll`; reaching into it at module scope
 * throws rather than yielding a half-built object.
 */
export function useTestDatabase(): TestDatabase {
  const handle = new TestDatabaseHandle();

  beforeAll(async () => {
    await handle.open(inject('openbooksTestDatabase'));
  });
  // Reset *before* each test rather than after: a failed test then leaves its rows
  // in place to be inspected, and a test cannot inherit dirt from a file that
  // crashed in teardown.
  beforeEach(async () => {
    await handle.reset();
  });
  afterAll(async () => {
    await handle.close();
  });

  return handle;
}

interface OpenState {
  readonly info: TestDatabaseInfo;
  readonly app: Kysely<DB>;
  readonly migrator: Kysely<DB>;
  readonly factories: Factories;
  readonly extraConnections: Set<AppConnection>;
  resettableTables?: readonly string[];
}

class TestDatabaseHandle implements TestDatabase {
  #state: OpenState | undefined;

  get app(): Kysely<DB> {
    return this.#open().app;
  }

  get migrator(): Kysely<DB> {
    return this.#open().migrator;
  }

  get factories(): Factories {
    return this.#open().factories;
  }

  get info(): TestDatabaseInfo {
    return this.#open().info;
  }

  get appConnectionConfig(): DatabaseConnectionConfig {
    return appConfig(this.#open().info);
  }

  async open(info: TestDatabaseInfo): Promise<void> {
    if (this.#state !== undefined) return;

    const appPool = createDatabasePool({ ...appConfig(info), connectionLimit: 5 });
    // One connection: the reset sets FOREIGN_KEY_CHECKS, which is session state.
    const migratorPool = createDatabasePool({ ...migratorConfig(info), connectionLimit: 1 });
    const app = createKyselyOverPool<DB>(appPool);
    const migrator = createKyselyOverPool<DB>(migratorPool);

    this.#state = {
      info,
      app,
      migrator,
      factories: createFactories(app),
      extraConnections: new Set(),
    };

    // Prove both identities before the first test rather than in the middle of one.
    await Promise.all([sql`SELECT 1`.execute(app), sql`SELECT 1`.execute(migrator)]);
  }

  async openAppConnection(): Promise<AppConnection> {
    const state = this.#open();
    const pool = createDatabasePool({ ...appConfig(state.info), connectionLimit: 1 });
    const db = createKyselyOverPool<DB>(pool);

    const connection: AppConnection = {
      db,
      close: async () => {
        state.extraConnections.delete(connection);
        await db.destroy();
      },
    };
    state.extraConnections.add(connection);

    // Fail here, where the test can see why, rather than on the first query.
    await sql`SELECT 1`.execute(db);
    return connection;
  }

  /**
   * Truncation between tests, not transaction-per-test rollback.
   *
   * Rollback isolation is cheaper, and it is the wrong tool for this suite. The
   * posting repository (OB-020) opens its own transaction; nesting that inside a
   * test transaction demotes its `COMMIT` to a savepoint release, so the
   * idempotency guarantees of OB-017 — which are statements about real commit and
   * rollback — would be asserted against semantics the production path never has.
   * And OB-026's concurrency cases need two connections that can see each other's
   * committed rows and contend for the same locks, which uncommitted rows in a
   * shared transaction make impossible: the race either cannot be set up or
   * appears to pass because the second connection saw nothing.
   *
   * The accepted cost is a per-test round trip per table (a few ms on empty
   * tables) and the requirement that test files not run in parallel against one
   * schema — already the case via `fileParallelism: false`.
   *
   * `DELETE`, not `TRUNCATE`: truncate is DDL, drops and recreates the tablespace,
   * and is refused outright on a table another table's foreign key references.
   * Foreign key checks are disabled for the duration because `journals` and
   * `accounts` reference themselves (`reverses_journal_id`, `parent_account_id`)
   * and InnoDB evaluates `RESTRICT` row by row, so a single statement deleting
   * both a row and its referent can fail on physical row order alone.
   */
  async reset(): Promise<void> {
    const state = this.#open();
    const tables = (state.resettableTables ??= await discoverResettableTables(
      state.migrator,
      state.info.database,
    ));

    await state.migrator.transaction().execute(async (trx) => {
      await sql`SET FOREIGN_KEY_CHECKS = 0`.execute(trx);
      try {
        for (const table of tables) {
          await sql`DELETE FROM ${sql.table(table)}`.execute(trx);
        }
        // Cascades do not fire while checks are off, so the child goes first.
        await sql`
          DELETE FROM role_permissions
          WHERE role_id IN (SELECT id FROM roles WHERE org_id IS NOT NULL)
        `.execute(trx);
        await sql`DELETE FROM roles WHERE org_id IS NOT NULL`.execute(trx);
      } finally {
        // The pool is size 1, so leaving this off would leak into every later query.
        await sql`SET FOREIGN_KEY_CHECKS = 1`.execute(trx);
      }
    });
  }

  async close(): Promise<void> {
    const state = this.#state;
    if (state === undefined) return;
    this.#state = undefined;

    for (const connection of [...state.extraConnections]) {
      await connection.close();
    }
    await state.app.destroy();
    await state.migrator.destroy();
  }

  #open(): OpenState {
    if (this.#state === undefined) {
      throw new Error(
        'The test database is not open yet. useTestDatabase() connects in beforeAll, so the ' +
          'handle can only be used from inside a test or hook.',
      );
    }
    return this.#state;
  }
}

/**
 * Reads the table list out of the live schema rather than restating it.
 *
 * A hardcoded list is a maintenance trap of a specific kind: a migration that adds
 * a table and forgets to add it here does not fail, it leaks rows between tests,
 * and the symptom is an unrelated test failing intermittently once the suite grows.
 */
async function discoverResettableTables(
  migrator: Kysely<DB>,
  database: string,
): Promise<readonly string[]> {
  const result = await sql<{ table_name: string }>`
    SELECT TABLE_NAME AS table_name
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = ${database} AND TABLE_TYPE = 'BASE TABLE'
    ORDER BY TABLE_NAME
  `.execute(migrator);

  return result.rows
    .map((row) => row.table_name)
    .filter((name) => !SEEDED_TABLES.has(name) && !MIGRATION_TABLES.has(name));
}

export function appConfig(info: TestDatabaseInfo): DatabaseConnectionConfig {
  return {
    host: info.host,
    port: info.port,
    user: info.appUser,
    password: info.appPassword,
    database: info.database,
  };
}

export function migratorConfig(info: TestDatabaseInfo): DatabaseConnectionConfig {
  return {
    host: info.host,
    port: info.port,
    user: info.migratorUser,
    password: info.migratorPassword,
    database: info.database,
  };
}
