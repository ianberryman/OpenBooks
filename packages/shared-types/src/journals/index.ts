/**
 * The journal wire contract (OB-023). Read `journals.ts` for why no request carries
 * actor provenance, and why line arity and the balance rule are both left to the
 * ledger kernel rather than half-answered by the schema.
 */
export type {
  JournalEntryType,
  JournalPage,
  JournalSideWire,
  JournalSummary,
  ListJournalsQuery,
  PostedJournalResponse,
  PostJournalRequest,
  ReverseJournalRequest,
} from './journals';
export {
  JOURNAL_ENTRY_TYPES,
  journalEntryTypeSchema,
  JOURNAL_SIDES,
  journalLineRequestSchema,
  journalPageSchema,
  journalSummarySchema,
  listJournalsQuerySchema,
  postedJournalLineSchema,
  postedJournalSchema,
  postJournalRequestSchema,
  reverseJournalRequestSchema,
} from './journals';
