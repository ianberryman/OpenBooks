import { GenericContainer, type StartedTestContainer } from 'testcontainers';

import type { DatabaseConnectionConfig } from '../../src/db/connection';
import { createDatabasePool } from '../../src/db/connection';
import { APP_DB_USER, DATABASE_NAME, MIGRATOR_DB_USER, readComposeBootstrapSql } from './bootstrap';

/**
 * A real MySQL 8 container. Spec §11: never SQLite, never mocks.
 *
 * Matches `docker-compose.yml`'s default (`mysql:${MYSQL_VERSION:-8.4}`). Tests
 * that pass against a different server than the product ships on are a weaker
 * claim than they look, and this schema leans on MySQL 8 specifics — `CHECK`
 * constraints, functional indexes, `UUID_TO_BIN`.
 */
const MYSQL_IMAGE = 'mysql:8.4';

const MYSQL_PORT = 3306;

/**
 * Under the 180s `hookTimeout` in `vitest.config.ts`, with room left for the
 * migrations that follow. A container that is not up by now is broken, not slow,
 * and waiting the full hook budget only delays the log tail that explains why.
 */
const STARTUP_TIMEOUT_MS = 90_000;

/** How long the two provisioned users are given to become usable after boot. */
const READY_TIMEOUT_MS = 60_000;

const READY_POLL_INTERVAL_MS = 250;

/** Retained only to be attached to a startup failure, which is when it is useful. */
const LOG_TAIL_LINES = 60;

export interface MySqlHarnessContainer {
  readonly container: StartedTestContainer;
  readonly appConfig: DatabaseConnectionConfig;
  readonly migratorConfig: DatabaseConnectionConfig;
}

export async function startMySqlContainer(): Promise<MySqlHarnessContainer> {
  const bootstrap = readComposeBootstrapSql();
  const logTail: string[] = [];

  const container = new GenericContainer(MYSQL_IMAGE)
    .withExposedPorts(MYSQL_PORT)
    // Same environment keys Compose sets, and deliberately no MYSQL_USER.
    //
    // This is why the harness uses GenericContainer rather than
    // @testcontainers/mysql's MySqlContainer: that class always sets MYSQL_USER,
    // and the official image's entrypoint answers MYSQL_USER with
    // `GRANT ALL ON <MYSQL_DATABASE>.* TO <MYSQL_USER>`. A third identity holding
    // UPDATE and DELETE on `journals` is exactly what spec §12 exists to prevent,
    // and `getConnectionUri()` would hand it to any test that reached for the
    // obvious helper. Compose sets no MYSQL_USER either, so this is also the
    // closer match.
    .withEnvironment({
      MYSQL_ROOT_PASSWORD: 'openbooks_root_local',
      MYSQL_DATABASE: DATABASE_NAME,
    })
    // The Compose provisioning verbatim, run by the image's own init mechanism.
    .withCopyContentToContainer(
      bootstrap.scripts.map((script) => ({
        content: script.contents,
        target: `/docker-entrypoint-initdb.d/${script.name}`,
        // World-readable: the entrypoint sources these as the `mysql` user.
        mode: 0o644,
      })),
    )
    // The schema is recreated from migrations on every run and discarded with the
    // container, so durability buys nothing and costs most of the startup time.
    .withTmpFs({ '/var/lib/mysql': 'rw,size=1g' })
    .withLogConsumer((stream) => {
      stream.on('data', (chunk: Buffer | string) => {
        logTail.push(String(chunk).trimEnd());
        if (logTail.length > LOG_TAIL_LINES) logTail.shift();
      });
    })
    .withStartupTimeout(STARTUP_TIMEOUT_MS);

  let started: StartedTestContainer;
  try {
    started = await container.start();
  } catch (cause) {
    throw new Error(`MySQL container failed to start.\n${formatLogTail(logTail)}`, { cause });
  }

  const host = started.getHost();
  const port = started.getMappedPort(MYSQL_PORT);

  const migratorConfig: DatabaseConnectionConfig = {
    host,
    port,
    user: MIGRATOR_DB_USER,
    password: bootstrap.migratorPassword,
    database: DATABASE_NAME,
  };

  const appConfig: DatabaseConnectionConfig = {
    host,
    port,
    user: APP_DB_USER,
    password: bootstrap.appPassword,
    database: DATABASE_NAME,
  };

  try {
    // Both users, not just one. The init scripts run in order and MySQL restarts
    // between initialization and serving, so "the port answers" is not "the grant
    // split is in place" — and a suite that discovered the app user was missing
    // three files later would report it as an unrelated failure.
    await Promise.all([waitForUser(migratorConfig), waitForUser(appConfig)]);
  } catch (cause) {
    await started.stop().catch(() => undefined);
    throw new Error(
      'MySQL started but its provisioned users never became usable. The Compose init ' +
        `scripts (${bootstrap.scripts.map((s) => s.name).join(', ')}) are the harness's ` +
        `source for both identities.\n${formatLogTail(logTail)}`,
      { cause },
    );
  }

  return { container: started, appConfig, migratorConfig };
}

async function waitForUser(config: DatabaseConnectionConfig): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError: unknown;

  for (;;) {
    const pool = createDatabasePool({ ...config, connectionLimit: 1 });
    try {
      await new Promise<void>((resolve, reject) => {
        pool.query('SELECT 1', (error) => (error ? reject(error) : resolve()));
      });
      return;
    } catch (error) {
      lastError = error;
    } finally {
      await new Promise<void>((resolve) => pool.end(() => resolve()));
    }

    if (Date.now() >= deadline) {
      throw new Error(`'${config.user}' could not connect within ${READY_TIMEOUT_MS}ms`, {
        cause: lastError,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
  }
}

function formatLogTail(lines: readonly string[]): string {
  if (lines.length === 0) return 'The container produced no output.';
  return `Last ${lines.length} line(s) of container output:\n${lines.join('\n')}`;
}
