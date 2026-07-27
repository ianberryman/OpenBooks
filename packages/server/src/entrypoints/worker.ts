/**
 * Worker role (spec §2.5: one image, three roles).
 *
 * From M1 to M3 this idled with no registered jobs. M4 gives it its first: the
 * statement import (OB-078). Parsing a 5,000-line file does not belong in a request
 * (D-47), so `startImport` enqueues and the worker parses, dedupes, inserts the new
 * lines, and completes the import (E1, E10).
 *
 * ## The worker now blocks, and that changes its restart policy
 *
 * Once it registers a handler it stays up waiting for work rather than returning, so
 * a clean exit is an outage — `docker-compose.yml`'s `worker` service is
 * `unless-stopped` for exactly this reason (D-47/D-49). It blocks until a shutdown
 * signal, drains, and exits.
 *
 * ## In-process vs. hosted (D-49)
 *
 * With `QUEUE_PROVIDER=in-process` the queue does not cross a process boundary, so a
 * job enqueued by a separate `api` container is consumed in that container, not here;
 * this process consumes only what is enqueued within it. A deployment that runs a
 * distinct worker for imports needs the `sqs` adapter, whose `subscribe` long-polls
 * the broker — the multi-instance path D-49 leaves for its own consumer. The wiring
 * below is identical either way: register the handler, then block.
 *
 * The barrel import below (`parseStatement`) reaches the concrete CSV/OFX parsers,
 * which are OB-076/OB-077 and may not have landed yet — the one place this entrypoint
 * depends on the wave-1 siblings.
 */
import { sql } from 'kysely';

import { getConfig } from '../config';
import { destroyDatabase, initializeDatabase, systemDb } from '../db';
import { getLogger } from '../logging';
import type { Logger } from '../logging';
import { parseStatement, registerStatementImportJob } from '../modules/banking';
import { queueProvider } from '../providers';

/** SIGTERM is what Fargate and `docker stop` send; SIGINT is Ctrl-C in development. */
const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

export async function startWorker(): Promise<void> {
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
  // Prove the pool reaches MySQL before registering a handler, for `startApi`'s
  // reason: a bad host or password should fail the process at boot, not on the first
  // job the queue delivers.
  await sql`select 1`.execute(systemDb());

  await registerStatementImportJob(queueProvider(), { parse: parseStatement, logger });

  logger.info({ role: 'worker' }, 'worker: statement import job registered; blocking on the queue');

  await blockUntilShutdown(logger);
}

/**
 * Holds the process open until a shutdown signal, then drains the pool.
 *
 * A never-resolving promise is what makes the worker *block on the queue* (D-47):
 * without it `startWorker` would return and the process would exit cleanly, which the
 * `unless-stopped` policy would read as a crash and restart in a loop.
 */
async function blockUntilShutdown(logger: Logger): Promise<void> {
  await new Promise<void>((resolve) => {
    let shuttingDown = false;
    const shutdown = (signal: string): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info({ signal }, 'worker shutting down');
      resolve();
    };
    for (const signal of SHUTDOWN_SIGNALS) {
      process.on(signal, () => {
        shutdown(signal);
      });
    }
  });

  await destroyDatabase();
}
