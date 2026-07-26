/**
 * The journal wire contract (OB-023). Read `journals.ts` for why no request carries
 * actor provenance, and why line arity and the balance rule are both left to the
 * ledger kernel rather than half-answered by the schema.
 */
export type {
  JournalSideWire,
  PostedJournalResponse,
  PostJournalRequest,
  ReverseJournalRequest,
} from './journals';
export {
  JOURNAL_SIDES,
  journalLineRequestSchema,
  postedJournalLineSchema,
  postedJournalSchema,
  postJournalRequestSchema,
  reverseJournalRequestSchema,
} from './journals';
