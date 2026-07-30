import type { PeriodCloseCheck, PeriodCloseChecklist } from '@openbooks/shared-types';

import type { RequestContext } from '../../context';
import { getContext } from '../../context';
import type { TenantDatabase } from '../../db';
import { bufferToUuid, orgScope, tenantDb, uuidToBuffer } from '../../db';
import { assertFound } from '../../errors';
import { requirePermission } from '../permissions';

import type { PeriodRecord } from './periods.repository';
import { selectPeriodById, selectPriorPeriod } from './periods.repository';
import type { PeriodRef } from './periods.schemas';
import { parseServiceInput, periodRefSchema } from './periods.schemas';

/**
 * The advisory close checklist (initiative P, OB-193; ROADMAP D-97).
 *
 * Three checks, and `PeriodCloseCheck.status` has no `'fail'` — only `'pass'` and
 * `'warn'` — because nothing here is a second lock. The hard invariants already
 * exist and already block: the ledger kernel refuses an unbalanced journal, and
 * `periods.service.ts`'s `assertPostable` refuses a posting into a closed period.
 * What this adds is visibility ahead of the close an accountant is about to make
 * permanent-feeling: which drafts never got posted, which statement lines never
 * got matched, and whether the period before this one is still open. A warning
 * never blocks `closePeriod` (below, in `periods.service.ts`) — it signs over
 * whatever was outstanding, and the signed-over snapshot is what
 * `period_close_events.checklist` preserves.
 */

const RESOURCE = 'fiscal_period';

/**
 * `GET /v1/fiscal-periods/:id/close-checklist` — read-only, side-effect-free.
 *
 * `closePeriod` does not call this. It calls `computeChecklistChecks` directly,
 * inside its own transaction, so the recorded snapshot is taken under the same
 * row lock as the status flip rather than trusted from a value a client read a
 * moment (or a warning) earlier.
 */
export async function computeCloseChecklist(
  input: PeriodRef,
  ctx: RequestContext = getContext('computeCloseChecklist()'),
): Promise<PeriodCloseChecklist> {
  await requirePermission(ctx, 'periods.read');

  const { periodId } = parseServiceInput(periodRefSchema, input, 'period reference');
  const db = tenantDb(orgScope(ctx.orgId));

  const period = assertFound(await selectPeriodById(db, uuidToBuffer(periodId)), RESOURCE);
  const checks = await computeChecklistChecks(db, period);

  // Echoes the canonical stored form, not the raw request string — the same
  // choice every other read in this module makes (`getPeriod`'s own `toFiscalPeriod`),
  // so a client that sent mixed-case UUID text sees it normalised rather than
  // reflected verbatim.
  return { periodId: bufferToUuid(period.id), checks: [...checks] };
}

/**
 * The three checks, against an already-resolved period and an already-scoped
 * handle.
 *
 * Exported (rather than folded into `computeCloseChecklist`) so `closePeriod` can
 * call it a second way: inside `transitionPeriod`'s transaction, passing the
 * `TenantDatabase` wrapping that transaction's connection and the `PeriodRecord`
 * already read there under `FOR UPDATE`. That reuses the row lock instead of
 * taking a second read, and needs no second `periods.read` check — the caller was
 * already authorized by `periods.close`/`periods.reopen` for an operation this is
 * one step inside of, the same reasoning `assertPostable` gives for calling no
 * `requirePermission` of its own.
 */
export async function computeChecklistChecks(
  db: TenantDatabase,
  period: PeriodRecord,
): Promise<readonly PeriodCloseCheck[]> {
  const [unpostedDrafts, unreconciledLines, priorPeriod] = await Promise.all([
    countUnpostedDraftsInRange(db, period.startDate, period.endDate),
    countUnreconciledBankLinesInRange(db, period.startDate, period.endDate),
    selectPriorPeriod(db, period.startDate),
  ]);

  return [
    unpostedDraftsCheck(unpostedDrafts),
    unreconciledBankLinesCheck(unreconciledLines),
    priorPeriodOpenCheck(priorPeriod),
  ];
}

/**
 * Drafts dated inside the period and never posted.
 *
 * `journal_drafts.entry_date` is nullable — `0002_ledger`'s point that a draft is
 * ordinarily half-entered — and an undated draft cannot be "inside" a date range,
 * so the range comparison excludes it on its own: MySQL's three-valued logic
 * makes `NULL >= x` unknown rather than true, with no separate `IS NOT NULL`
 * needed.
 */
async function countUnpostedDraftsInRange(
  db: TenantDatabase,
  startDate: string,
  endDate: string,
): Promise<number> {
  const row = await db
    .selectFrom('journal_drafts')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('entry_date', '>=', startDate)
    .where('entry_date', '<=', endDate)
    .executeTakeFirstOrThrow();

  return Number(row.count);
}

/**
 * Statement lines dated inside the period with no `bank_line_clearings` row.
 *
 * The left-join-and-test-null shape is `banking/statement-lines/repository.ts`'s
 * `selectStatementLinesPage` `cleared` filter, reused rather than re-derived: a
 * line's clearing is a single row keyed by `uq_blc_line` (`org_id,
 * statement_line_id`), so "cleared" is exactly "has one such row". No explicit
 * `org_id` predicate is added to the join — `fk_blc_line` is a composite key on
 * `(org_id, statement_line_id)`, so a `bank_line_clearings` row reached by
 * matching `statement_line_id` is already confined to the same org as the
 * statement line, which `db.selectFrom` has already scoped.
 *
 * This is the simpler of the two predicates the spec allows: it does not
 * distinguish a line cleared mid-reconciliation-session from one cleared
 * standalone (`bank_line_clearings.reconciliation_session_id`), because for this
 * checklist the only question is "does the ledger have a match for this line at
 * all" — session membership is `reconciliation.service.ts`'s concern, not this
 * one's.
 */
async function countUnreconciledBankLinesInRange(
  db: TenantDatabase,
  startDate: string,
  endDate: string,
): Promise<number> {
  const row = await db
    .selectFrom('bank_statement_lines')
    .leftJoin('bank_line_clearings', (join) =>
      join.onRef('bank_line_clearings.statement_line_id', '=', 'bank_statement_lines.id'),
    )
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('bank_statement_lines.posted_date', '>=', startDate)
    .where('bank_statement_lines.posted_date', '<=', endDate)
    .where('bank_line_clearings.id', 'is', null)
    .executeTakeFirstOrThrow();

  return Number(row.count);
}

function unpostedDraftsCheck(count: number): PeriodCloseCheck {
  return {
    key: 'unposted_drafts',
    label: 'Unposted journal drafts dated in this period',
    status: count > 0 ? 'warn' : 'pass',
    detail:
      count > 0
        ? `${String(count)} draft ${count === 1 ? 'entry is' : 'entries are'} dated inside this ` +
          'period and have not been posted.'
        : 'No unposted drafts are dated inside this period.',
    count,
  };
}

function unreconciledBankLinesCheck(count: number): PeriodCloseCheck {
  return {
    key: 'unreconciled_bank_lines',
    label: 'Unreconciled bank statement lines in this period',
    status: count > 0 ? 'warn' : 'pass',
    detail:
      count > 0
        ? `${String(count)} statement ${count === 1 ? 'line is' : 'lines are'} dated inside ` +
          'this period and have not been matched to a journal.'
        : 'No unreconciled statement lines are dated inside this period.',
    count,
  };
}

function priorPeriodOpenCheck(prior: PeriodRecord | undefined): PeriodCloseCheck {
  const warn = prior !== undefined && prior.status === 'open';
  return {
    key: 'prior_period_open',
    label: 'Prior fiscal period is closed',
    status: warn ? 'warn' : 'pass',
    detail:
      prior === undefined
        ? 'There is no prior fiscal period.'
        : warn
          ? `The prior period, ${prior.name}, is still open.`
          : `The prior period, ${prior.name}, is closed.`,
    // No `count` — this is a yes/no check, not one about outstanding items.
  };
}
