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
import {
  resolveApiKeyIdentity,
  resolveOAuthIdentity,
  resolveSessionIdentity,
} from '../modules/auth';
import { parseStatement, registerStatementImportJob } from '../modules/banking';
import { registerDocumentExtractionJob } from '../modules/bills';
import { registerDunningJob, registerRecurringJob } from '../modules/invoicing';
import { registerFixedAssetDepreciationJob } from '../modules/fixed-assets';
import { registerProcessorPollJob } from '../modules/payments-processing';
import { registerRecurringJournalJob } from '../modules/recurring-journals';
import { startDailyTick } from '../modules/scheduling';
import { queueProvider } from '../providers';
import { buildApp } from '../transport';
import type { IdentityResolver } from '../transport';

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
   *
   * The three resolvers compose here (M5), in the one layer allowed to see both sides
   * of the seam. A bearer credential is an explicit act and takes precedence over an
   * ambient session cookie; each resolver returns `null` for a request that is not its
   * kind — no `Authorization` header, or a token whose prefix is not its own — and
   * throws only for a credential of its kind that it rejects. That null-versus-throw
   * contract is what makes this a total order rather than a best-effort race:
   * OB-098 (OAuth bearer, `oba_`) → OB-099 (API key, `obk_`) → OB-015 (session cookie).
   */
  const resolveIdentity: IdentityResolver = async (request) => {
    const oauth = await resolveOAuthIdentity(request);
    if (oauth) return oauth;
    const apiKey = await resolveApiKeyIdentity(request);
    if (apiKey) return apiKey;
    return resolveSessionIdentity(request);
  };

  const app = await buildApp({ config, logger, resolveIdentity });

  /**
   * With the in-process queue, the API consumes the jobs it enqueues.
   *
   * D-49's in-process adapter does not cross a process boundary — a job `startImport`
   * enqueues runs in the process that enqueued it. In a single-container self-host that
   * process is this one, so the API must register the import handler or the job is
   * enqueued to a queue nobody consumes and the import sticks in `queued` forever (there
   * is no separate worker process sharing the same in-memory queue — that is what the
   * `sqs` adapter is for, and under it the `worker` role consumes and the API registers
   * nothing). `worker.ts` registers the same handler; exactly one process does, chosen by
   * the queue provider.
   */
  let stopDailyTick: (() => void) | undefined;
  if (config.providers.queue.provider === 'in-process') {
    await registerStatementImportJob(queueProvider(), { parse: parseStatement, logger });
    await registerRecurringJob(queueProvider(), { logger });
    await registerDunningJob(queueProvider(), { logger });
    // The recurring GL journal sweep (initiative L, OB-162), beside recurring invoices.
    await registerRecurringJournalJob(queueProvider(), { logger });
    // The fixed-asset depreciation sweep (initiative L, OB-165), same daily-tick shape.
    await registerFixedAssetDepreciationJob(queueProvider(), { logger });
    // Event-driven (initiative O, OB-186), registered here for the same reason as the
    // other three: under the in-process adapter, this is the process that consumes what
    // it enqueues — `createCaptureFromUpload` and the inbound webhook both run here.
    await registerDocumentExtractionJob(queueProvider(), { logger });
    // The D-85 polling backstop (OB-148), same reason as the jobs above: under the
    // in-process adapter this is the process that consumes what it enqueues.
    await registerProcessorPollJob(queueProvider(), { logger });
    // The daily tick (OB-127) runs here under the in-process adapter, because this is the
    // process that consumes what it enqueues (the comment above). A stop handle is captured so
    // the shutdown drain clears it before closing the pool.
    stopDailyTick = startDailyTick({ logger });
    logger.info(
      { role: 'api', queue: 'in-process' },
      'statement, recurring, dunning, extraction and processor-poll jobs registered in-process; ' +
        'daily tick started',
    );
  }

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
    // Stop the daily tick first, so it cannot enqueue against a closing pool.
    stopDailyTick?.();
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
