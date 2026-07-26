/**
 * API role (spec §2.5: one image, three roles).
 *
 * Startup order is the substance of this file, and it is chosen so that a
 * container which is listening has already proved every dependency it needs. See
 * `src/transport/health.ts` for why that ordering is what lets `/health` be a
 * dependency-free liveness probe rather than a restart trigger wired to the
 * database.
 */
import { sql } from 'kysely';

import { getConfig } from '../config';
import { destroyDatabase, initializeDatabase, systemDb } from '../db';
import { getLogger } from '../logging';
import { resolveSessionIdentity } from '../modules/auth';
import { buildApp } from '../transport';

/** SIGTERM is what Fargate and `docker stop` send; SIGINT is Ctrl-C in development. */
const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

/**
 * Proves the pool actually reaches MySQL before the listener opens.
 *
 * `initializeDatabase` only constructs a pool — mysql2 connects lazily — so without
 * this the first evidence of a bad host or password would be a 500 on a real
 * request. Spec §3 requires configuration failures to surface at startup; this is
 * the same principle applied to reachability.
 *
 * It runs exactly once, and it is the reason `/health` does not need to: a failure
 * here exits non-zero and the container never becomes healthy, whereas the same
 * check on a repeating probe would turn a transient blip into a simultaneous
 * restart of every task.
 */
async function assertDatabaseReachable(): Promise<void> {
  await sql`select 1`.execute(systemDb());
}

export async function startApi(): Promise<void> {
  const config = getConfig();
  const logger = getLogger();

  initializeDatabase({
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    database: config.database.database,
    connectionLimit: config.database.poolSize,
  });
  await assertDatabaseReachable();

  /**
   * This entrypoint is the one layer allowed to see both sides of the authentication
   * seam, which is why the wiring happens here and not in either module.
   * `.dependency-cruiser.cjs` forbids `src/modules/` → `src/transport/`, so
   * `resolveSessionIdentity` cannot name transport's `IdentityResolver` type; it
   * declares a structurally identical `ResolvedIdentity` instead and the assignment
   * below is where the two meet (see the boundary note in
   * `src/modules/auth/identity.ts`).
   *
   * Passing it is what authenticates the running app at all. Without it every request
   * stays in the pre-auth scope, so `isAuthenticatedContext` is false and
   * `requirePermission` answers `401` for every tenant route — the API would be
   * reachable and useless. The transport tests build instances with and without a
   * resolver deliberately; production always has one.
   */
  const app = await buildApp({ config, logger, resolveIdentity: resolveSessionIdentity });

  /**
   * Registered before `listen`, not after.
   *
   * A SIGTERM arriving during startup is not hypothetical — a deploy that gets
   * rolled back, or a task the scheduler decides to move, sends one whenever it
   * likes. With no handler in place the default disposition kills the process with
   * the pool open, and the container's grace period is spent on nothing.
   */
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    // A second signal during a drain must not start a second drain: `app.close()`
    // is not reentrant and `destroyDatabase` would race itself.
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'shutting down');
    // `app.close()` stops accepting connections and lets in-flight requests
    // finish; the pool is destroyed only afterwards, or a request still writing
    // would lose its connection mid-statement.
    void app
      .close()
      .then(() => destroyDatabase())
      .then(
        () => {
          logger.info({ signal }, 'shutdown complete');
        },
        (error: unknown) => {
          logger.error({ err: error, signal }, 'shutdown failed');
          process.exitCode = 1;
        },
      );
  };

  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, () => {
      shutdown(signal);
    });
  }

  await app.listen({ host: config.http.host, port: config.http.port });

  // The plain logger, not `app.log`: there is no request context at boot, so the
  // provenance mixin contributes nothing and `base: { role }` already names the
  // process (spec §2.5).
  logger.info(
    { host: config.http.host, port: config.http.port, nodeEnv: config.nodeEnv },
    'api listening',
  );
}
