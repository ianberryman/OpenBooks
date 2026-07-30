/**
 * Accountant access & period close (initiative P, OB-192…199; ROADMAP D-96…D-98).
 *
 * Three wire surfaces: the period-close workflow (the advisory checklist and the
 * sign-off/reopen bodies over the M1 lock), the statement package (a branded
 * P&L/BS/cash-flow PDF), and the audit trail (the who-changed-what timeline that
 * surfaces existing provenance). The `accountant` role and the adjusting-entry flag
 * reuse contracts that already exist — the seeded role bundle, and `entryType` on
 * `postJournalRequestSchema` (`journals/journals.ts`) — so they are not here.
 */

export type {
  ClosePeriodRequest,
  PeriodCloseCheck,
  PeriodCloseCheckStatus,
  PeriodCloseChecklist,
  ReopenPeriodRequest,
} from './period-close';
export {
  closePeriodRequestSchema,
  PERIOD_CLOSE_CHECK_STATUSES,
  periodCloseCheckSchema,
  periodCloseChecklistSchema,
  reopenPeriodRequestSchema,
} from './period-close';

export type {
  CreateStatementPackageRequest,
  StatementPackage,
  StatementPackageList,
} from './statement-package';
export {
  createStatementPackageRequestSchema,
  statementPackageListSchema,
  statementPackageSchema,
} from './statement-package';

export type {
  AuditActor,
  AuditEntry,
  AuditEntryKind,
  AuditReport,
  AuditReportQueryInput,
  AuditReportQueryParams,
} from './audit';
export {
  AUDIT_ENTRY_KINDS,
  auditActorSchema,
  auditEntrySchema,
  auditReportQuerySchema,
  auditReportSchema,
} from './audit';
