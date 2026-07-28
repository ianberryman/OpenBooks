import { getContext } from '../../context';
import type { RequestContext } from '../../context';
import { requirePermission } from '../permissions';
import { enqueueDailyTasks } from './tick';

/**
 * Runs the day's due background work now, rather than waiting for the tick (OB-127).
 *
 * The same fan-out `startDailyTick` performs at midnight, on demand — a "run now" for an org
 * that just created a recurring template or wants its overdue invoices chased this minute. It
 * enqueues onto the very queues the clock does, so the work runs through the identical handlers
 * under the identical automation authority; nothing here does the work, and nothing is
 * special-cased for a manual run.
 *
 * Gated on `invoices.write`: triggering standing invoicing automation is an invoicing-management
 * act. Re-triggering is harmless — a recurring cycle guards on `last_run_date` and a dunning
 * stage on `dunning_sends`, so a second run in the same day materialises and sends nothing new.
 */
export async function runDueWorkNow(
  ctx: RequestContext = getContext('runDueWorkNow()'),
): Promise<{ runDate: string }> {
  await requirePermission(ctx, 'invoices.write');
  const runDate = todayRunDate();
  await enqueueDailyTasks(runDate);
  return { runDate };
}

/** `YYYY-MM-DD` in the process's own timezone — a calendar date, not an instant (D-13's kin). */
function todayRunDate(now: Date = new Date()): string {
  const year = String(now.getFullYear()).padStart(4, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
