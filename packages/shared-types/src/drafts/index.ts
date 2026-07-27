/**
 * The journal-draft wire contract (OB-038; ROADMAP D-16, D-19).
 *
 * Read `drafts.ts` for why every field is nullable, for why `lines` is replaced
 * rather than patched, and for the rule that decides which schemas carry a
 * `.meta({ id })` — bodies and responses do, the list query does not.
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
  journalDraftPageSchema,
  journalDraftSchema,
  journalDraftSummarySchema,
  listDraftsQuerySchema,
  updateDraftRequestSchema,
} from './drafts';
