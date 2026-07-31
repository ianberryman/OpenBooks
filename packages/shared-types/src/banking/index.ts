/**
 * Banking's wire contracts (OB-075; ROADMAP D-41 through D-47, acceptance E1–E10).
 *
 * Read `banking.ts` first: it holds the vocabulary the eight resources share, and it
 * is where the two absences that shape all of M4 are argued — no balance on a bank
 * account (D-46) and no write anywhere on the matching path (D-43). `refusals.ts` is
 * the second thing to read if you are writing a service: every refusal banking is
 * allowed to speak is declared there, in AP's register, so that M4's six waves do
 * not reproduce OB-092 three more times.
 *
 * `statement-lines.ts` explains why there is no update shape for a line and what the
 * dedupe fingerprint is over; `clearing.ts` states E4 as an equation; and
 * `reconciliation.ts` explains why the session lock is not the fiscal period's.
 *
 * The component ids arrived with OB-084's routes, in the same diff. A schema carries
 * an `id` exactly when a route reaches it (see `banking.ts`); `contracts.test.ts`
 * asserts the published set.
 */

export {
  BANK_LINE_DIRECTIONS,
  bankDateRangeShape,
  bankLineAmountSchema,
  bankLineDirectionSchema,
} from './banking';
export type { BankLineDirection } from './banking';

export { BANKING_PRECONDITIONS, BANKING_RESOURCES } from './refusals';
export type { BankingPrecondition, BankingResource } from './refusals';

export {
  BANK_ACCOUNT_NAME_MAX_LENGTH,
  BANK_EXTERNAL_ACCOUNT_ID_MAX_LENGTH,
  BANK_FEED_SOURCES,
  BANK_INSTITUTION_NAME_MAX_LENGTH,
  bankAccountPageSchema,
  bankAccountSchema,
  bankFeedSourceSchema,
  createBankAccountRequestSchema,
  listBankAccountsQuerySchema,
  updateBankAccountRequestSchema,
} from './bank-accounts';
export type {
  BankAccount,
  BankAccountPage,
  BankFeedSource,
  CreateBankAccountRequest,
  ListBankAccountsQuery,
  UpdateBankAccountRequest,
} from './bank-accounts';

export {
  BANK_AMOUNT_CONVENTIONS,
  BANK_DATE_ORDERS,
  BANK_IMPORT_FILENAME_MAX_LENGTH,
  BANK_IMPORT_MAPPING_NAME_MAX_LENGTH,
  BANK_IMPORT_PREVIEW_ROWS,
  BANK_STATEMENT_CONTENT_MAX_LENGTH,
  BANK_STATEMENT_FORMATS,
  BANK_STATEMENT_IMPORT_STATUSES,
  bankAmountConventionSchema,
  bankDateOrderSchema,
  bankImportColumnsSchema,
  bankImportMappingDefinitionSchema,
  bankImportMappingPageSchema,
  bankImportMappingSchema,
  bankStatementFormatSchema,
  bankStatementImportPageSchema,
  bankStatementImportPreviewSchema,
  bankStatementImportQueuedSchema,
  bankStatementImportResultSchema,
  bankStatementImportSchema,
  bankStatementImportStatusSchema,
  createBankImportMappingRequestSchema,
  createBankStatementImportRequestSchema,
  listBankImportMappingsQuerySchema,
  listBankStatementImportsQuerySchema,
  previewBankStatementImportRequestSchema,
  updateBankImportMappingRequestSchema,
} from './imports';
export type {
  BankAmountConvention,
  BankDateOrder,
  BankImportColumns,
  BankImportMapping,
  BankImportMappingDefinition,
  BankImportMappingPage,
  BankStatementFormat,
  BankStatementImport,
  BankStatementImportPage,
  BankStatementImportPreview,
  BankStatementImportQueued,
  BankStatementImportResult,
  BankStatementImportStatus,
  CreateBankImportMappingRequest,
  CreateBankStatementImportRequest,
  ListBankImportMappingsQuery,
  ListBankStatementImportsQuery,
  PreviewBankStatementImportRequest,
  UpdateBankImportMappingRequest,
} from './imports';

export {
  BANK_LINE_COUNTERPARTY_MAX_LENGTH,
  BANK_LINE_DESCRIPTION_MAX_LENGTH,
  BANK_LINE_FINGERPRINT_FIELDS,
  BANK_LINE_REFERENCE_MAX_LENGTH,
  bankLineFingerprintSchema,
  bankStatementLineDraftSchema,
  bankStatementLinePageSchema,
  bankStatementLineSchema,
  createManualStatementLineRequestSchema,
  listBankStatementLinesQuerySchema,
} from './statement-lines';
export type {
  BankLineFingerprintField,
  BankStatementLine,
  BankStatementLineDraft,
  BankStatementLinePage,
  CreateManualStatementLineRequest,
  ListBankStatementLinesQuery,
} from './statement-lines';

export {
  BANK_RULE_MATCH_MODES,
  BANK_RULE_MATCH_VALUE_MAX_LENGTH,
  BANK_RULE_NAME_MAX_LENGTH,
  bankRuleConditionSchema,
  bankRuleMatchModeSchema,
  bankRuleOutcomeSchema,
  bankRulePageSchema,
  bankRuleSchema,
  createBankRuleRequestSchema,
  listBankRulesQuerySchema,
  updateBankRuleRequestSchema,
} from './rules';
export type {
  BankRule,
  BankRuleCondition,
  BankRuleMatchMode,
  BankRuleOutcome,
  BankRulePage,
  CreateBankRuleRequest,
  ListBankRulesQuery,
  UpdateBankRuleRequest,
} from './rules';

export {
  BANK_MATCH_KINDS,
  BANK_MATCH_PROPOSALS_PER_LINE,
  BANK_MATCH_REASON_CODES,
  bankLineProposalsSchema,
  bankMatchProposalListSchema,
  bankMatchProposalSchema,
  bankMatchProposalsRequestSchema,
  bankMatchReasonCodeSchema,
  bankMatchReasonSchema,
} from './matching';
export type {
  BankLineProposals,
  BankMatchKind,
  BankMatchProposal,
  BankMatchProposalList,
  BankMatchProposalsRequest,
  BankMatchReason,
  BankMatchReasonCode,
} from './matching';

export {
  BANK_CLEARING_ENTRY_TYPES,
  BANK_CLEARING_METHODS,
  bankClearingEntryTypeSchema,
  bankClearingMethodSchema,
  bankLineClearingEntrySchema,
  bankLineClearingSchema,
  clearBankStatementLineRequestSchema,
  removeBankLineClearingRequestSchema,
} from './clearing';
export type {
  BankClearingEntryType,
  BankClearingMethod,
  BankLineClearing,
  BankLineClearingEntry,
  ClearBankStatementLineRequest,
  ClearingEntry,
  RemoveBankLineClearingRequest,
} from './clearing';

export {
  RECONCILIATION_EVENT_TYPES,
  RECONCILIATION_REASON_MAX_LENGTH,
  RECONCILIATION_SESSION_STATES,
  createReconciliationSessionRequestSchema,
  listReconciliationSessionsQuerySchema,
  reconciliationBalancesSchema,
  reconciliationEventTypeSchema,
  reconciliationSessionEventSchema,
  reconciliationSessionPageSchema,
  reconciliationSessionSchema,
  reconciliationSessionStateSchema,
  reconciliationSessionSummarySchema,
  reopenReconciliationSessionRequestSchema,
  updateReconciliationSessionRequestSchema,
} from './reconciliation';
export type {
  CreateReconciliationSessionRequest,
  ListReconciliationSessionsQuery,
  ReconciliationBalances,
  ReconciliationEventType,
  ReconciliationSession,
  ReconciliationSessionEvent,
  ReconciliationSessionPage,
  ReconciliationSessionState,
  ReconciliationSessionSummary,
  ReopenReconciliationSessionRequest,
  UpdateReconciliationSessionRequest,
} from './reconciliation';

export {
  reconcilingItemSchema,
  reconciliationReportSchema,
  unclearedStatementLineSchema,
} from './reconciliation-report';
export type {
  ReconcilingItem,
  ReconciliationReport,
  UnclearedStatementLine,
} from './reconciliation-report';
