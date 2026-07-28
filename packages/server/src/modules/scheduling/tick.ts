import type { Logger } from '../../logging';
import { queueProvider } from '../../providers';

/**
 * The daily tick (OB-127; ROADMAP H6): a single-worker, in-process clock that, once a day,
 * enqueues the standing background work — recurring-invoice cycles and dunning runs — onto the
 * existing `QueueProvider`. It is the whole of the scheduler v1 is scoped to: **non-durable
 * across a restart**, because durable, multi-instance scheduling waits on the `sqs` adapter
 * (D-49), and a missed tick self-heals — the work it would have enqueued is idempotent (a
 * recurring cycle guards on `last_run_date`, a dunning stage on `dunning_sends`), so the next
 * tick catches up rather than double-raising.
 *
 * ## Why the tick only enqueues, and the sweep is a registry
 *
 * The tick does no work itself; it enqueues, and a queue handler does the sweep off the request
 * path (the statement-import shape, D-47). Each subsystem that wants a daily run
 * `registerDailyTask(queue)` at wiring time and registers its own handler; the tick is blind to
 * what they do and only fans a `{ runDate }` out to each. That keeps this module a leaf — it
 * imports neither the recurring engine nor the dunning one — so both can name their queue
 * without a cycle, exactly as `STATEMENT_IMPORT_QUEUE` sits below its service.
 *
 * `enqueueDailyTasks` is separated from the timer so the same fan-out a midnight tick performs
 * can be triggered on demand — a "run due work now" action and a test both call it rather than
 * waiting a day for the clock.
 */

/** The payload every daily task receives: the calendar date the run is *for*. */
export interface DailyTaskPayload {
  readonly runDate: string;
}

const dailyTasks = new Set<string>();

/**
 * Registers a queue to receive a `{ runDate }` job on each daily tick. Idempotent — a queue
 * named twice is fanned out to once — so a module may register beside where it subscribes its
 * handler without coordinating order.
 */
export function registerDailyTask(queue: string): void {
  dailyTasks.add(queue);
}

/** Test seam: the queues that would be fanned out to, in insertion order. */
export function registeredDailyTasks(): readonly string[] {
  return [...dailyTasks];
}

/**
 * Enqueues every registered daily task for `runDate`. The tick's unit of work, exposed so a
 * manual run and a test drive the identical fan-out the clock does.
 */
export async function enqueueDailyTasks(runDate: string): Promise<void> {
  const queue = queueProvider();
  for (const name of dailyTasks) {
    await queue.enqueue<DailyTaskPayload>(name, { runDate });
  }
}

/** `YYYY-MM-DD` in the process's own timezone — a calendar date, not an instant (D-13's kin). */
function todayCalendarDate(now: Date): string {
  const year = String(now.getFullYear()).padStart(4, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Starts the daily clock: fans the registered tasks out once now — so a fresh worker catches up
 * the day it boots rather than waiting until the next midnight — and then every 24 hours. Returns
 * a stop function that clears the timer, which the worker's shutdown drains before the pool.
 *
 * A plain 24-hour interval rather than an align-to-midnight computation on purpose: v1's clock is
 * "about once a day" (the work is date-grained and idempotent), and a drifting interval that
 * fires is worth more than a precise one that a restart resets. `clock` is injectable so a test
 * can assert the fan-out without a real day passing.
 */
export function startDailyTick(deps: {
  readonly logger: Logger;
  readonly clock?: () => Date;
}): () => void {
  const clock = deps.clock ?? ((): Date => new Date());

  const fire = (): void => {
    const runDate = todayCalendarDate(clock());
    void enqueueDailyTasks(runDate).catch((error: unknown) => {
      deps.logger.error({ err: error, runDate }, 'daily tick: failed to enqueue due work');
    });
    deps.logger.info({ runDate, tasks: registeredDailyTasks() }, 'daily tick: enqueued due work');
  };

  fire();
  const timer = setInterval(fire, ONE_DAY_MS);
  // Do not hold the event loop open on the timer alone — the worker blocks on the shutdown
  // signal, not on this.
  timer.unref();

  return (): void => {
    clearInterval(timer);
  };
}
