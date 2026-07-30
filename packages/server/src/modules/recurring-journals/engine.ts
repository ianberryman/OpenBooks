import type { JournalLineInput, QueueProvider } from '@openbooks/plugin-api';
import type { DraftLineInput, RecurringJournalFrequency } from '@openbooks/shared-types';

import type { RequestContext } from '../../context';
import { bufferToUuid, systemDb } from '../../db';
import type { Logger } from '../../logging';
import { createDraft } from '../drafts';
import { postJournal } from '../ledger';
import { registerDailyTask, runAsAutomation } from '../scheduling';

import type { RecurringJournalSweepPayload } from './job';
import { RECURRING_JOURNAL_SWEEP_QUEUE } from './job';
import type {
  DueRecurringJournalTemplateRow,
  RecurringJournalTemplateLineRow,
} from './recurring-journals.repository';
import {
  advanceRecurringJournalTemplateCycle,
  orgScope,
  selectDueRecurringJournalTemplates,
  selectRecurringJournalTemplateByIdForUpdate,
  selectRecurringJournalTemplateLines,
} from './recurring-journals.repository';

/**
 * The recurring-journal materialisation engine (OB-162; ROADMAP D-90, D-113…D-117).
 *
 * `invoicing/recurring/engine.ts` is this file's sibling and its header is worth
 * reading in full; the shape restated here is:
 *
 *  - `runRecurringJournalSweep` runs once per tick with no org yet — that is the
 *    question it is answering. It reads across every org through `systemDb()`
 *    (`selectDueRecurringJournalTemplates`'s own commentary argues why that read is
 *    sanctioned to bypass `tenantDb`) and hands each due template to
 *    `runAsAutomation`, which is what actually opens the org's scope.
 *  - `materializeCycle` runs once per template, inside the org `runAsAutomation`
 *    opened, under a system/automation actor so the journal it raises still carries
 *    real provenance (D-76, spec §6). Everything it does — the read under lock,
 *    raising the entry, and advancing the schedule — is one `tenantDb(orgId).transaction`,
 *    so a crash mid-cycle leaves the template exactly as due as it was and the next
 *    tick retries it whole.
 *
 * ## The one branch the invoice engine does not have
 *
 * `materialization_mode` decides *how* a cycle's entry reaches the books. `posted`
 * calls `postJournal` directly, under the automation's own actor — provenance lands
 * on the journal the moment it exists, the same as a recurring invoice's auto-approve
 * path. `draft` instead calls `createDraft`, landing an editable `journal_drafts` row
 * (M2) for a human to review and post — no journal exists yet, and none of the
 * append-only guarantees apply until one does. Both branches still advance the
 * schedule identically afterwards: what a cycle produced is a side effect of
 * `materializeCycle`, not a fact its scheduling math depends on.
 *
 * `transaction-scope.ts` is explicit that a job sweeping many orgs must not open one
 * outer transaction across the sweep — it would accumulate every org's work into a
 * single unit. `runRecurringJournalSweep` does not: each template's transaction is
 * opened inside `materializeCycle`, after `runAsAutomation` has re-scoped to that
 * template's own org, and one template's failure (caught and logged) does not unwind
 * another's.
 */

export interface RecurringJournalEngineDeps {
  readonly logger: Logger;
}

/**
 * Registers the sweep on the daily tick and on the queue it rides — the worker's one
 * line of wiring, `registerRecurringJob`'s shape. `registerDailyTask` is what makes
 * `RECURRING_JOURNAL_SWEEP_QUEUE` fire once a day with today's date as its payload;
 * `queue.subscribe` is what makes that payload reach this handler.
 */
export async function registerRecurringJournalJob(
  queue: QueueProvider,
  deps: RecurringJournalEngineDeps,
): Promise<void> {
  registerDailyTask(RECURRING_JOURNAL_SWEEP_QUEUE);
  await queue.subscribe(RECURRING_JOURNAL_SWEEP_QUEUE, createRecurringJournalSweepHandler(deps));
}

/** The sweep handler, over any deps — the worker's registration, a test's own. */
export function createRecurringJournalSweepHandler(
  deps: RecurringJournalEngineDeps,
): (payload: RecurringJournalSweepPayload) => Promise<void> {
  return (payload) => runRecurringJournalSweep(payload, deps);
}

/**
 * Every active template due by `runDate`, across every org, each materialised under
 * its own org's automation scope.
 *
 * One template's failure is logged and does not stop the sweep: a bad template — an
 * account deactivated out from under it — must not hold every other org's postings
 * hostage for a day. It stays due (nothing here advances its schedule on the failing
 * path) and is retried on the next tick.
 */
export async function runRecurringJournalSweep(
  payload: RecurringJournalSweepPayload,
  deps: RecurringJournalEngineDeps,
): Promise<void> {
  const due = await selectDueRecurringJournalTemplates(systemDb(), payload.runDate);

  for (const template of due) {
    const orgId = bufferToUuid(template.org_id);
    const templateId = bufferToUuid(template.id);

    try {
      await runAsAutomation(orgId, templateId, (ctx) => materializeCycle(template, ctx));
    } catch (error) {
      deps.logger.error(
        { orgId, templateId, err: error },
        'Recurring journal cycle failed; the template stays due and is retried on the next tick.',
      );
    }
  }
}

/**
 * Raises one cycle's entry from a due template, and advances its schedule.
 *
 * Idempotency comes first, under the row lock: D-76's once-per-cycle guard, restated
 * from `materializeCycle` in `invoicing/recurring/engine.ts` — read that file's
 * commentary for the full argument. In short: the cycle this invocation is *for* is
 * the one the sweep selected — `template.next_run_date` — and a cycle already fired
 * records that date in `last_run_date`. So a second invocation for the same
 * dispatched cycle reloads the row under the lock and does nothing. `runDate` never
 * appears below: the cycle posts as of the template's own schedule date, and a
 * template overdue by more than one cycle catches up one cycle per tick.
 */
export async function materializeCycle(
  template: DueRecurringJournalTemplateRow,
  ctx: RequestContext,
): Promise<void> {
  await orgScope(ctx).transaction(async (trx) => {
    const current = await selectRecurringJournalTemplateByIdForUpdate(trx, template.id);
    // Gone, or deactivated, since the sweep's snapshot — nothing to do.
    if (current === undefined || current.is_active !== 1) return;
    if (current.last_run_date === template.next_run_date) return;

    const issueDate = current.next_run_date;
    const lines = await selectRecurringJournalTemplateLines(trx, template.id);

    if (current.materialization_mode === 'posted') {
      await postJournal(
        {
          date: issueDate,
          ...(current.memo === null ? {} : { memo: current.memo }),
          source: 'recurring',
          actorType: ctx.actorType,
          actorId: ctx.actorId,
          ...(ctx.invocationMode === undefined ? {} : { invocationMode: ctx.invocationMode }),
          lines: lines.map(toJournalLine),
        },
        ctx,
      );
    } else {
      // `createDraft` opens its own `orgScope(ctx).transaction`, which joins the one
      // already open here rather than starting a second (`TenantDatabase.transaction`,
      // `transaction-scope.ts`) — the draft and the schedule advance below commit or
      // roll back together, the same guarantee `postJournal`'s branch gets for free.
      await createDraft(
        {
          entryDate: issueDate,
          ...(current.memo === null ? {} : { memo: current.memo }),
          lines: lines.map(toDraftLine),
        },
        ctx,
      );
    }

    const nextRunDate = advance(issueDate, current.frequency, current.interval_count);
    const isActive = current.end_date === null || nextRunDate <= current.end_date;

    await advanceRecurringJournalTemplateCycle(trx, template.id, {
      lastRunDate: issueDate,
      nextRunDate,
      isActive,
    });
  });
}

/**
 * A template line as `postJournal` takes it. Stored and posted verbatim (D-90) — no
 * repricing, unlike a recurring invoice line — so this is a column rename, not a
 * computation. `description` becomes `memo` because that is the posted line's own
 * field for the same fact.
 */
function toJournalLine(line: RecurringJournalTemplateLineRow): JournalLineInput {
  return {
    accountId: bufferToUuid(line.account_id),
    side: line.side,
    amount: line.amount_minor,
    ...(line.contact_id === null ? {} : { contactId: bufferToUuid(line.contact_id) }),
    ...(line.description === null ? {} : { memo: line.description }),
  };
}

/**
 * The same line, shaped for `createDraft` instead. The one difference from
 * `toJournalLine` is `amount`: `JournalLineInput.amount` is the kernel's internal
 * `bigint` (`plugin-api`'s `MinorUnits`), while `DraftLineInput.amount` is the wire's
 * cents-only string (D-13) — a draft is composed through the same schema a human's
 * request would be, so it takes the wire shape even when nothing human composed it.
 */
function toDraftLine(line: RecurringJournalTemplateLineRow): DraftLineInput {
  return {
    accountId: bufferToUuid(line.account_id),
    side: line.side,
    amount: line.amount_minor.toString(),
    ...(line.contact_id === null ? {} : { contactId: bufferToUuid(line.contact_id) }),
    ...(line.description === null ? {} : { memo: line.description }),
  };
}

// ---------------------------------------------------------------------------
// Pure date math — copied from `invoicing/recurring/engine.ts` rather than
// imported: it is private there, and duplicating roughly forty lines of
// calendar arithmetic is cheaper than making it a public export of a module
// this one otherwise has no reason to depend on. Unit-tested on its own here,
// the same way the original is tested on its own in `invoicing/recurring`.
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
 * `Date.setUTCMonth` does not clamp — the native overflow turns 31 Jan + 1 month into
 * 3 Mar, not 28/29 Feb — which is wrong for a billing cycle: an entry dated the 31st
 * must land on the last day of a shorter month, not skip into the next one. Computed
 * on the calendar parts directly rather than through `Date` arithmetic for that
 * reason.
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
 * `frequency` × `intervalCount` forward from `date` (D-75). `weekly` is exact — seven
 * days is seven days — and the other three are month arithmetic, because a calendar
 * month is not a fixed number of days and an entry dated the 31st has to mean *the
 * end of the month*, not *thirty days later*.
 */
export function advance(
  date: string,
  frequency: RecurringJournalFrequency,
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
