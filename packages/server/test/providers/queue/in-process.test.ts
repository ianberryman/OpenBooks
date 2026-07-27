import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '../../../src/logging';
import { InProcessQueue } from '../../../src/providers';

/**
 * The self-host queue adapter (OB-078; ROADMAP D-49).
 *
 * The behaviour the statement import depends on: a subscribed handler runs a job
 * enqueued in the same process, `settled()` awaits it, a missing handler is loud
 * rather than silent, and one job's failure does not wedge the rest.
 */

function captureLogger(): { logger: Logger; errors: unknown[][]; warns: unknown[][] } {
  const errors: unknown[][] = [];
  const warns: unknown[][] = [];
  const logger = {
    info: () => undefined,
    debug: () => undefined,
    warn: (...args: unknown[]) => warns.push(args),
    error: (...args: unknown[]) => errors.push(args),
  } as unknown as Logger;
  return { logger, errors, warns };
}

describe('InProcessQueue', () => {
  it('runs a subscribed handler for an enqueued job, observable through settled()', async () => {
    const { logger } = captureLogger();
    const queue = new InProcessQueue(logger);

    const seen: string[] = [];
    await queue.subscribe<{ value: string }>('q', async (payload) => {
      seen.push(payload.value);
      await Promise.resolve();
    });

    // Detached: the handler has not run at the point enqueue resolves.
    await queue.enqueue('q', { value: 'first' });
    expect(seen).toEqual([]);

    await queue.settled();
    expect(seen).toEqual(['first']);
  });

  it('runs jobs a handler enqueues while it runs, before settled() resolves', async () => {
    const { logger } = captureLogger();
    const queue = new InProcessQueue(logger);

    const seen: number[] = [];
    await queue.subscribe<{ n: number }>('q', async (payload) => {
      seen.push(payload.n);
      if (payload.n < 3) await queue.enqueue('q', { n: payload.n + 1 });
    });

    await queue.enqueue('q', { n: 1 });
    await queue.settled();
    expect(seen).toEqual([1, 2, 3]);
  });

  it('refuses a second handler on one queue', async () => {
    const { logger } = captureLogger();
    const queue = new InProcessQueue(logger);
    await queue.subscribe('q', () => Promise.resolve());
    // A guard against a wiring mistake, thrown synchronously like `assertUsableKey`.
    expect(() => queue.subscribe('q', () => Promise.resolve())).toThrow(/already has a handler/);
  });

  it('logs and drops a job for a queue with no handler, rather than throwing', async () => {
    const { logger, errors } = captureLogger();
    const queue = new InProcessQueue(logger);

    await expect(queue.enqueue('nobody-home', { x: 1 })).resolves.toBeUndefined();
    await queue.settled();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.[0]).toMatchObject({ queue: 'nobody-home' });
  });

  it('catches a handler failure, logs it, and still settles', async () => {
    const { logger, errors } = captureLogger();
    const queue = new InProcessQueue(logger);

    const ran = vi.fn();
    await queue.subscribe('q', () => Promise.reject(new Error('handler blew up')));
    await queue.subscribe('other', () => {
      ran();
      return Promise.resolve();
    });

    await queue.enqueue('q', {});
    await queue.enqueue('other', {});
    await expect(queue.settled()).resolves.toBeUndefined();

    expect(ran).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.[0]).toMatchObject({ queue: 'q' });
  });
});
