/**
 * Recurring GL journal templates (initiative L, OB-162; ROADMAP D-90, D-113…D-117).
 *
 * A recurring journal template is `invoicing/recurring`'s sibling with the pricing
 * removed: a fixed-line GL journal the scheduler raises each period — prepaid
 * amortisation, an accrual, deferred-revenue recognition. `recurring-journals.repository.ts`
 * is the data access, `recurring-journals.service.ts` is create/get/list/update/deactivate
 * for a human or an MCP caller, `engine.ts` is the sweep the daily tick (OB-127) drives,
 * and `job.ts` is the queue name and payload both sides share with no cycle between them.
 *
 * There are no routes here: `/v1` for recurring journals is OB-167 (Wave 2).
 */

export {
  createRecurringJournalTemplate,
  deactivateRecurringJournalTemplate,
  getRecurringJournalTemplate,
  listRecurringJournalTemplates,
  updateRecurringJournalTemplate,
} from './recurring-journals.service';
export type { RecurringJournalTemplatePage } from './recurring-journals.service';

export { advance, registerRecurringJournalJob } from './engine';
export type { RecurringJournalEngineDeps } from './engine';

export { RECURRING_JOURNAL_SWEEP_QUEUE } from './job';
export type { RecurringJournalSweepPayload } from './job';
