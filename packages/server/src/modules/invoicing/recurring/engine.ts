import type { QueueProvider } from '@openbooks/plugin-api';
import type { CreateInvoiceRequest, RecurringFrequency, TaxMode } from '@openbooks/shared-types';

import type { RequestContext } from '../../../context';
import { bufferToUuid, systemDb } from '../../../db';
import type { Logger } from '../../../logging';
import { approveInvoice, createInvoice } from '../../invoices';
import { registerDailyTask, runAsAutomation } from '../../scheduling';

import type { RecurringSweepPayload } from './job';
import { RECURRING_SWEEP_QUEUE } from './job';
import type { DueRecurringTemplateRow } from './recurring.repository';
import {
  advanceRecurringTemplateCycle,
  orgScope,
  selectDueTemplates,
  selectRecurringTemplateByIdForUpdate,
  selectRecurringTemplateLines,
  toRecurringInvoiceLine,
} from './recurring.repository';

/**
 * The recurring-invoice materialisation engine (OB-128; ROADMAP D-75, D-76).
 *
 * Two halves, and the seam between them is the org:
 *
 *  - `runRecurringSweep` runs once per tick with no org yet — that is the question
 *    it is answering. It reads across every org through `systemDb()`
 *    (`selectDueTemplates`'s own commentary argues why that read, and only that
 *    read, is sanctioned to bypass `tenantDb`) and hands each due template to
 *    `runAsAutomation`, which is what actually opens the org's scope.
 *  - `materializeCycle` runs once per template, inside the org `runAsAutomation`
 *    opened, under a system/automation actor so the invoice it may auto-approve
 *    still carries real provenance (D-76, spec §6). Everything it does — the read
 *    under lock, `createInvoice`, `approveInvoice`, and advancing the schedule —
 *    is one `tenantDb(orgId).transaction`, so a crash mid-cycle leaves the
 *    template exactly as due as it was and the next tick retries it whole.
 *
 * `transaction-scope.ts` is explicit that a job sweeping many orgs must not open
 * one outer transaction across the sweep — it would accumulate every org's work
 * into a single unit. `runRecurringSweep` does not: each template's transaction is
 * opened inside `materializeCycle`, after `runAsAutomation` has re-scoped to that
 * template's own org, and one template's failure (caught and logged) does not
 * unwind another's.
 */

export interface RecurringEngineDeps {
  readonly logger: Logger;
}

/**
 * Registers the sweep on the daily tick and on the queue it rides — the worker's
 * one line of wiring, `registerStatementImportJob`'s shape. `registerDailyTask`
 * is what makes `RECURRING_SWEEP_QUEUE` fire once a day with today's date as its
 * payload; `queue.subscribe` is what makes that payload reach this handler.
 */
export async function registerRecurringJob(
  queue: QueueProvider,
  deps: RecurringEngineDeps,
): Promise<void> {
  await registerDailyTask(RECURRING_SWEEP_QUEUE);
  await queue.subscribe(RECURRING_SWEEP_QUEUE, createRecurringSweepHandler(deps));
}

/** The sweep handler, over any deps — the worker's registration, a test's own. */
export function createRecurringSweepHandler(
  deps: RecurringEngineDeps,
): (payload: RecurringSweepPayload) => Promise<void> {
  return (payload) => runRecurringSweep(payload, deps);
}

/**
 * Every active template due by `runDate`, across every org, each materialised
 * under its own org's automation scope.
 *
 * One template's failure is logged and does not stop the sweep: a bad template —
 * a contact deleted out from under it, an account deactivated — must not hold
 * every other org's invoicing hostage for a day. It stays due (nothing here
 * advances its schedule on the failing path) and is retried on the next tick.
 */
export async function runRecurringSweep(
  payload: RecurringSweepPayload,
  deps: RecurringEngineDeps,
): Promise<void> {
  const due = await selectDueTemplates(systemDb(), payload.runDate);

  for (const template of due) {
    const orgId = bufferToUuid(template.org_id);
    const templateId = bufferToUuid(template.id);

    try {
      await runAsAutomation(orgId, templateId, (ctx) => materializeCycle(template, ctx));
    } catch (error) {
      deps.logger.error(
        { orgId, templateId, err: error },
        'Recurring invoice cycle failed; the template stays due and is retried on the next tick.',
      );
    }
  }
}

/**
 * Raises one cycle's invoice from a due template, and advances its schedule.
 *
 * Idempotency comes first, under the row lock, and is checked against the
 * template's own state rather than against anything the sweep passed in: `runDate`
 * never appears below the `selectDueTemplates` read, on purpose. A template found
 * due for a payload built two ticks ago (a crashed worker, a slow restart) is
 * still resolved against what the row says *now* — D-76's once-per-cycle guard is
 * `last_run_date === next_run_date`, and the cycle it fires posts as of the
 * template's own `next_run_date`, not the wall-clock day the sweep happened to
 * run. A template overdue by more than one cycle catches up one cycle per tick
 * rather than raising every missed invoice at once.
 */
export async function materializeCycle(
  template: DueRecurringTemplateRow,
  ctx: RequestContext,
): Promise<void> {
  await orgScope(ctx).transaction(async (trx) => {
    const current = await selectRecurringTemplateByIdForUpdate(trx, template.id);
    // Gone, or deactivated, since the sweep's snapshot — nothing to do.
    if (current === undefined || current.is_active !== 1) return;
    if (current.last_run_date === current.next_run_date) return;

    const issueDate = current.next_run_date;
    const lines = await selectRecurringTemplateLines(trx, template.id);

    const request: CreateInvoiceRequest = {
      contactId: bufferToUuid(current.contact_id),
      issueDate,
      dueDate: addDays(issueDate, current.due_days),
      taxMode: current.tax_mode as TaxMode,
      ...(current.memo === null ? {} : { memo: current.memo }),
      lines: lines.map((line) => {
        const input = toRecurringInvoiceLine(line);
        return {
          // `documentLineInputSchema` requires a non-empty description; a
          // template line's is nullable (a template is not yet a document —
          // `recurringInvoiceLineSchema`'s own commentary). The template's own
          // name is the fallback a cycle has on hand.
          description: input.description ?? current.name,
          quantity: input.quantity,
          unitAmount: input.unitAmount,
          accountId: input.accountId,
          ...(input.taxRateId === null ? {} : { taxRateId: input.taxRateId }),
        };
      }),
    };

    const invoice = await createInvoice(request, ctx);
    if (current.materialization_mode === 'approved') {
      await approveInvoice(invoice.id, ctx);
    }

    const nextRunDate = advance(
      issueDate,
      current.frequency as RecurringFrequency,
      current.interval_count,
    );
    const isActive = current.end_date === null || nextRunDate <= current.end_date;

    await advanceRecurringTemplateCycle(trx, template.id, {
      lastRunDate: issueDate,
      nextRunDate,
      isActive,
    });
  });
}

// ---------------------------------------------------------------------------
// Pure date math — no DB, no context, unit-tested on its own
// (`test/invoicing/recurring-advance.test.ts`).
// ---------------------------------------------------------------------------

interface CalendarParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function parseCalendarDate(date: string): CalendarParts {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return { year, month, day };
}

function formatCalendarDate(parts: CalendarParts): string {
  const year = String(parts.year).padStart(4, '0');
  const month = String(parts.month).padStart(2, '0');
  const day = String(parts.day).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** The last day of `month` (1–12) in `year`, for clamping a month-end rollover. */
function daysInMonth(year: number, month: number): number {
  // Day 0 of the following month is the last day of this one — `Date`'s own
  // overflow, used deliberately here rather than avoided.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addDays(date: string, days: number): string {
  const { year, month, day } = parseCalendarDate(date);
  const asDate = new Date(Date.UTC(year, month - 1, day));
  asDate.setUTCDate(asDate.getUTCDate() + days);

  return formatCalendarDate({
    year: asDate.getUTCFullYear(),
    month: asDate.getUTCMonth() + 1,
    day: asDate.getUTCDate(),
  });
}

/**
 * Adds whole months, clamping the day to the target month's last one.
 *
 * `Date.setUTCMonth` does not clamp — the native overflow turns 31 Jan + 1 month
 * into 3 Mar, not 28/29 Feb — which is wrong for a billing cycle: a subscription
 * dated the 31st must land on the last day of a shorter month, not skip into the
 * next one. Computed on the calendar parts directly rather than through `Date`
 * arithmetic for that reason.
 */
function addMonths(date: string, months: number): string {
  const { year, month, day } = parseCalendarDate(date);
  const totalMonths = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = (totalMonths % 12) + 1;

  return formatCalendarDate({
    year: targetYear,
    month: targetMonth,
    day: Math.min(day, daysInMonth(targetYear, targetMonth)),
  });
}

/**
 * `frequency` × `intervalCount` forward from `date` (D-75). `weekly` is exact —
 * seven days is seven days — and the other three are month arithmetic, because a
 * calendar month is not a fixed number of days and a billing cycle dated the 31st
 * has to mean *the end of the month*, not *thirty days later*.
 */
export function advance(
  date: string,
  frequency: RecurringFrequency,
  intervalCount: number,
): string {
  switch (frequency) {
    case 'weekly':
      return addDays(date, 7 * intervalCount);
    case 'monthly':
      return addMonths(date, intervalCount);
    case 'quarterly':
      return addMonths(date, 3 * intervalCount);
    case 'yearly':
      return addMonths(date, 12 * intervalCount);
  }
}
