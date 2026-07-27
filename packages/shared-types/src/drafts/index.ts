/**
 * The journal-draft wire contract (OB-038; ROADMAP D-16, D-19).
 *
 * Read `drafts.ts` for why every field is nullable, for why `lines` is replaced
 * rather than patched, and for why nothing here carries a `.meta({ id })` until
 * OB-045 puts a route in front of it.
 */

export type {
  CreateDraftRequest,
  DraftLineInput,
  JournalDraft,
  JournalDraftLine,
  JournalDraftPage,
  JournalDraftSummary,
  ListDraftsQuery,
  UpdateDraftRequest,
} from './drafts';
export {
  createDraftRequestSchema,
  DRAFT_LINE_MEMO_MAX_LENGTH,
  DRAFT_MAX_LINES,
  DRAFT_MEMO_MAX_LENGTH,
  DRAFT_REFERENCE_MAX_LENGTH,
  draftLineInputSchema,
  journalDraftLineSchema,
  journalDraftSchema,
  journalDraftSummarySchema,
  listDraftsQuerySchema,
  updateDraftRequestSchema,
} from './drafts';
