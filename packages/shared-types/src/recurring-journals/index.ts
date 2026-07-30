/**
 * Recurring journal templates (initiative L, OB-162; ROADMAP D-90, D-113…D-117; `/v1`
 * routes OB-167).
 *
 * `recurring-journals.ts` holds the whole wire surface: the fixed-line GL template, its
 * balanced lines, create/update, the list query, and the keyset page schema — every
 * schema on this surface carries a `.meta({ id })` now that OB-167's routes have landed.
 */

export {
  RECURRING_JOURNAL_FREQUENCIES,
  RECURRING_JOURNAL_MATERIALIZATION_MODES,
  createRecurringJournalTemplateRequestSchema,
  listRecurringJournalTemplatesQuerySchema,
  recurringJournalFrequencySchema,
  recurringJournalLineSchema,
  recurringJournalMaterializationModeSchema,
  recurringJournalTemplatePageSchema,
  recurringJournalTemplateSchema,
  updateRecurringJournalTemplateRequestSchema,
} from './recurring-journals';
export type {
  CreateRecurringJournalTemplateRequest,
  ListRecurringJournalTemplatesQuery,
  RecurringJournalFrequency,
  RecurringJournalLine,
  RecurringJournalMaterializationMode,
  RecurringJournalTemplate,
  RecurringJournalTemplatePage,
  UpdateRecurringJournalTemplateRequest,
} from './recurring-journals';
