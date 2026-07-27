import type { QueueProvider } from '@openbooks/plugin-api';

import { runDetached } from '../../db';
import type { Logger } from '../../logging';

/**
 * The self-host `QueueProvider`: jobs run in the process that enqueued them (D-07,
 * D-49).
 *
 * ## Why an in-process queue exists at all
 *
 * [D-49] settles the half of the queue decision that was still open — a broker for
 * self-host — as *no broker*. The `QueueConfig` union already resolved the hosted
 * half to `sqs`, and the terraform topology is AWS end to end, so a Redis dependency
 * would be a second broker nothing else needs. The constraint driving it is [D-47]'s:
 * a self-hosted single-container install should not require a broker to import a CSV.
 * This adapter is that decision's first consumer, exactly as `email/log.ts` was the
 * first consumer of the email interface — an adapter ships with the feature that
 * needs it, never before (D-07).
 *
 * ## The limits are the design, not a shortcoming
 *
 * An in-process queue does not span processes and does not survive a restart. Both
 * are stated by [D-49] as present constraints:
 *
 *  - **Same process.** `enqueue` invokes the handler `subscribe` registered *in this
 *    process*. It does not cross an OS process boundary, so the enqueuing role and the
 *    consuming role must be the same process. For the statement import that means the
 *    import handler is registered wherever the import is started; a deployment that
 *    runs a separate `worker` container for imports needs the `sqs` adapter, which is
 *    the multi-instance path [D-49] leaves for its own consumer.
 *  - **No durability.** A job in flight when the process dies is gone. The statement
 *    import is safe under this because E1 makes re-running an import harmless: the
 *    user re-uploads and the line-level dedupe collapses it. The dedupe property is
 *    therefore also the crash-recovery story ([D-49]).
 *
 * ## Detached, so `enqueue` does not block the caller
 *
 * `enqueue` schedules the handler and resolves immediately — the whole point of
 * [D-47] is that parsing a 5,000-line statement does not happen inside the request.
 * The handler runs on a later turn of the event loop; its promise is tracked so
 * `settled()` can await it, which is how the worker keeps the process alive and how a
 * test drives the async path to completion without polling.
 */
export class InProcessQueue implements QueueProvider {
  readonly #logger: Logger;
  readonly #handlers = new Map<string, (payload: unknown) => Promise<void>>();
  readonly #pending = new Set<Promise<void>>();

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  /**
   * Registers the one handler for a queue.
   *
   * One handler per queue, and a second registration throws rather than replacing or
   * appending: in-process, two handlers on one queue is an ambiguity about which runs
   * a job, and it is always a wiring mistake — the worker registers each queue once.
   */
  subscribe<T>(queue: string, handler: (payload: T) => Promise<void>): Promise<void> {
    if (this.#handlers.has(queue)) {
      throw new Error(
        `In-process queue '${queue}' already has a handler. Each queue is consumed once per ` +
          'process; a second subscribe is a wiring mistake, not a fan-out.',
      );
    }
    this.#handlers.set(queue, handler as (payload: unknown) => Promise<void>);
    return Promise.resolve();
  }

  enqueue<T>(queue: string, payload: T, opts?: { delaySeconds?: number }): Promise<void> {
    const handler = this.#handlers.get(queue);
    if (handler === undefined) {
      // No consumer in this process. For the in-process adapter that is a
      // misconfiguration — the job will never run — so it is logged loudly rather
      // than swallowed. It is not thrown: an enqueue is fire-and-forget by contract,
      // and failing the caller's request for a background concern would be worse than
      // a job that a restart re-runs.
      this.#logger.error(
        { queue },
        'Enqueued a job onto an in-process queue with no handler in this process; it will not run.',
      );
      return Promise.resolve();
    }

    const delayMs = Math.max(0, Math.round((opts?.delaySeconds ?? 0) * 1000));
    const job = this.#schedule(queue, handler, payload, delayMs);
    this.#pending.add(job);
    void job.finally(() => this.#pending.delete(job));

    return Promise.resolve();
  }

  /**
   * Resolves once every job scheduled so far has settled, including jobs a handler
   * enqueues while it runs. The worker awaits this to block on the queue (D-47), and
   * a test awaits it to observe the effect of an enqueue without polling.
   */
  async settled(): Promise<void> {
    while (this.#pending.size > 0) {
      await Promise.allSettled([...this.#pending]);
    }
  }

  #schedule(
    queue: string,
    handler: (payload: unknown) => Promise<void>,
    payload: unknown,
    delayMs: number,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        // `runDetached` clears any ambient transaction the enqueuer held. `enqueue` is
        // called inside the request's transaction (every `startImport` is, via
        // `withIdempotency`), and `AsyncLocalStorage` propagates through this `setTimeout`
        // — so without this the handler would join a transaction that has since committed
        // and every write would throw "Transaction is already committed". A detached job
        // outlives the request that scheduled it and must open its own transactions; the
        // queue guarantees that for every handler rather than trusting each to remember.
        //
        // A handler failure has no request to reject and no client to tell, so it is
        // logged here and the job resolves regardless — one failed job must not wedge
        // `settled()` or take down the worker's event loop.
        runDetached(() => handler(payload))
          .catch((error: unknown) => {
            this.#logger.error({ err: error, queue }, 'A queued job failed.');
          })
          .finally(resolve);
      }, delayMs);
    });
  }
}
