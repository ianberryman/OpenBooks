import type { RequestContext } from '../../../context';
import { bufferToUuid, isDuplicateEntryError, newUuidBuffer } from '../../../db';
import type { TenantDatabase } from '../../../db';
import type { Logger } from '../../../logging';
import { outboundEmail } from '../../../providers';
import { selectContactById } from '../../contacts/contacts.repository';
import type { AgingDocumentRow } from '../../reports/aging.repository';
import { selectArDocuments } from '../../reports/aging.repository';

import type { ActivePolicyWithStages, DunningStageRow } from './dunning.repository';
import {
  hasSend,
  insertSend,
  orgScope,
  selectActivePoliciesWithStages,
} from './dunning.repository';

/**
 * The dunning sweep (OB-129, Phase 4; ROADMAP D-77).
 *
 * One tick, one calendar date: for every org holding an active policy, for
 * every overdue invoice, for every active policy, send at most one reminder —
 * the highest stage that has come due and has not already sent
 * (`selectDueStage`). `dunning_sends`'s unique key
 * (`uq_dunning_sends_invoice_stage`) is the actual once-per-stage guarantee;
 * everything here exists to make the common case need no retry to discover it.
 *
 * ## Paid and void invoices are excluded for free
 *
 * `selectOverdueInvoices` reuses `aging.repository.ts`'s `selectArDocuments` —
 * the same as-at aggregation the aging report ties to the ledger (C8) — rather
 * than a second query over `ar_documents`. A paid invoice never appears because
 * its outstanding (`total − allocated`) is zero; a voided one is excluded by the
 * same `void_journal.id IS NULL` join `selectArDocuments` already applies. So
 * neither state needs its own branch here — they are absent from the input
 * rather than filtered out of it.
 *
 * ## Nothing in this file imports `modules/scheduling`
 *
 * That is deliberate, not an oversight. `registerDunningJob` — the piece that
 * actually needs the scheduler's `registerDailyTask`/`runAsAutomation`
 * (OB-127) — lives in `worker.ts` beside this file, precisely so that
 * `selectDueStage` and `runDunning` stay reachable, and testable
 * (`test/invoicing/dunning-select.test.ts`, `test/invoicing/dunning.test.ts`),
 * from a codebase where `packages/server/src/modules/scheduling/` does not yet
 * exist — a *value* import of a missing module fails module resolution at
 * runtime for every caller, unlike a type-only import, which a bundler erases.
 * See `worker.ts`'s header for the OB-127 contract assumed there.
 */

// ---------------------------------------------------------------------------
// selectDueStage — pure, no DB (test/invoicing/dunning-select.test.ts)
// ---------------------------------------------------------------------------

/** The two fields `selectDueStage` needs; the real caller passes a fuller row. */
export interface DueStageCandidate {
  readonly stageNumber: number;
  readonly offsetDays: number;
}

/**
 * Which stage of a ladder is due for one invoice, on one date.
 *
 * "Due" is `dueDate + offsetDays <= runDate` (`0008_recurring_dunning`'s
 * convention: negative `offsetDays` is before the due date, positive is after).
 * Among the stages that are due and have not already sent, the *highest*
 * `stageNumber` wins — a sweep that missed a run (the process was down for a
 * week) sends the one reminder that reflects how overdue the invoice now is,
 * not a burst of every rung it walked past. A stage already in
 * `alreadySentStageNumbers` is never a candidate, which is what makes a stage
 * fire at most once regardless of how many sweeps run after it is due.
 *
 * `null` when nothing is due, or every due stage has already sent.
 */
export function selectDueStage<T extends DueStageCandidate>(
  stages: readonly T[],
  dueDate: string,
  runDate: string,
  alreadySentStageNumbers: ReadonlySet<number>,
): T | null {
  let candidate: T | null = null;

  for (const stage of stages) {
    if (alreadySentStageNumbers.has(stage.stageNumber)) continue;

    const triggerDate = addCalendarDays(dueDate, stage.offsetDays);
    if (triggerDate > runDate) continue;

    if (candidate === null || stage.stageNumber > candidate.stageNumber) candidate = stage;
  }

  return candidate;
}

/**
 * Calendar-date arithmetic in UTC. Restated from `banking/matching/dates.ts`
 * rather than imported — that file's own header gives the reason: a sibling
 * module's internals are not a shared library, and this is six lines. Its
 * behaviour is asserted directly by `dunning-select.test.ts`.
 */
const MILLISECONDS_PER_DAY = 86_400_000;

function toUtcMillis(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined || Number.isNaN(day)) {
    throw new Error(`A calendar date was not in YYYY-MM-DD form: ${date}`);
  }
  return Date.UTC(year, month - 1, day);
}

function addCalendarDays(date: string, days: number): string {
  const shifted = new Date(toUtcMillis(date) + days * MILLISECONDS_PER_DAY);
  return shifted.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// runDunning — one org, one date (test/invoicing/dunning.test.ts, real MySQL)
// ---------------------------------------------------------------------------

/**
 * Every overdue invoice in the org, as at `runDate`.
 *
 * "Overdue" is `selectArDocuments`'s own filter (documents whose journal has
 * posted and whose void, if any, has not — both as at `runDate`) narrowed by
 * two predicates that are this ticket's and not the aging report's: a due date
 * strictly before `runDate`, and something still outstanding. `dueDate` is
 * non-null on every row here because `selectArDocuments` inner-joins the
 * posting journal — a row with no due date is either a credit note (excluded
 * by `documentType: 'invoice'`) or a draft (excluded because a draft has no
 * `journal_id` to join on) — so the filter below is a type narrowing as much as
 * a business rule.
 */
async function selectOverdueInvoices(
  db: TenantDatabase,
  runDate: string,
): Promise<readonly (AgingDocumentRow & { readonly dueDate: string })[]> {
  const documents = await selectArDocuments(db, {
    asOf: runDate,
    documentType: 'invoice',
    allocationLink: 'invoice_id',
    contactId: null,
  });

  return documents.filter(
    (doc): doc is AgingDocumentRow & { readonly dueDate: string } =>
      doc.dueDate !== null && doc.dueDate < runDate && doc.total - doc.allocated > 0n,
  );
}

/**
 * Sends the reminder and records the attempt.
 *
 * The order matters, and it is the opposite of `sendInvoice`'s: there the
 * artifact and the token are minted before the mail is attempted because a
 * delivery attests that something was produced; here there is no artifact,
 * only the attempt itself, so the email is sent first and `status` records
 * what happened to it — `'sent'` on a clean send, `'failed'` on a rejection,
 * mirroring `sendInvoice`'s own `deliver`.
 *
 * A duplicate-key refusal on the insert — `uq_dunning_sends_invoice_stage`,
 * reached if a concurrent sweep (or a retried tick) sent this exact stage in
 * the gap between `selectDueStage` and this insert — is treated as the stage
 * having already sent, not as a fault: the row that matters already exists.
 */
async function sendStage(
  db: TenantDatabase,
  logger: Logger,
  invoice: AgingDocumentRow,
  stage: DunningStageRow,
  recipientEmail: string,
): Promise<void> {
  const { provider, logger: emailLogger } = outboundEmail();

  let status: 'sent' | 'failed';
  try {
    await provider.send({ to: recipientEmail, subject: stage.subject, text: stage.body });
    status = 'sent';
  } catch (error) {
    emailLogger.error(
      { err: error, invoiceId: bufferToUuid(invoice.documentId), stageNumber: stage.stage_number },
      'Dunning reminder was rejected by the provider.',
    );
    status = 'failed';
  }

  try {
    await insertSend(db, {
      id: newUuidBuffer(),
      invoiceId: invoice.documentId,
      stageId: stage.id,
      recipientEmail,
      providerMessageId: null,
      status,
    });
  } catch (error) {
    if (isDuplicateEntryError(error)) {
      logger.info(
        { invoiceId: bufferToUuid(invoice.documentId), stageNumber: stage.stage_number },
        'Dunning stage already sent by a concurrent sweep; not sending again.',
      );
      return;
    }
    throw error;
  }
}

/**
 * One org, one date: walk every overdue invoice against every active policy
 * and send the one reminder each is due for, at most.
 *
 * Runs under an already-open `RequestContext` — it does not open one itself,
 * so a test can call it directly with a hand-built context (`invoices.write`
 * pattern in `test/invoices/support.ts`) with no queue and no scheduler
 * involved, and the worker's handler (`worker.ts`'s `registerDunningJob`)
 * reaches it the same way through `runAsAutomation`.
 */
export async function runDunning(runDate: string, ctx: RequestContext): Promise<void> {
  const db = orgScope(ctx);
  const logger = outboundEmail().logger;

  const policies = await selectActivePoliciesWithStages(db);
  if (policies.length === 0) return;

  const overdue = await selectOverdueInvoices(db, runDate);
  if (overdue.length === 0) return;

  for (const invoice of overdue) {
    for (const policy of policies) {
      await sendDueStageIfAny(db, logger, invoice, policy, runDate);
    }
  }
}

async function sendDueStageIfAny(
  db: TenantDatabase,
  logger: Logger,
  invoice: AgingDocumentRow & { readonly dueDate: string },
  policy: ActivePolicyWithStages,
  runDate: string,
): Promise<void> {
  if (policy.stages.length === 0) return;

  const alreadySent = new Set<number>();
  for (const stage of policy.stages) {
    if (await hasSend(db, invoice.documentId, stage.id)) alreadySent.add(stage.stage_number);
  }

  const candidates = policy.stages.map((stage) => ({
    stageNumber: stage.stage_number,
    offsetDays: stage.offset_days,
    row: stage,
  }));
  const due = selectDueStage(candidates, invoice.dueDate, runDate, alreadySent);
  if (due === null) return;

  // A customer with no email on file is skipped, not fatal — `sendInvoice`'s
  // `invoice.no_recipient` guard is a *request-time* refusal; nothing here is a
  // request, and an unattended sweep that faulted an entire org's tick because
  // one customer has no address would be worse than the reminder not going out.
  const contact = await selectContactById(db, invoice.contactId);
  const recipientEmail = contact?.email;
  if (recipientEmail === null || recipientEmail === undefined) return;

  // OB-129 follow-up: late fee posting. `due.row.late_fee_minor` names a fee
  // this stage would post; v1 sends the reminder only. Posting it belongs beside
  // `approveInvoice`'s journal-posting path, not this sweep, once it lands.

  await sendStage(db, logger, invoice, due.row, recipientEmail);
}
