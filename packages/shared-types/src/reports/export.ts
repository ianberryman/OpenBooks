import { z } from 'zod';

import { agingLedgerSchema } from '../subledger/aging';
import { calendarDateSchema } from '../wire';

import { reportBasisSchema } from './profit-and-loss';

/**
 * Report export (OB-220, ROADMAP part 2) — the wire contract for downloading a
 * report as CSV or Excel.
 *
 * Every report service in `modules/reports` already computes structured rows; export
 * flattens whichever report the caller names into a canonical tabular form
 * (`modules/reports/export/tabular.ts`) and serialises it. It runs the *same* report
 * service the JSON route runs, so an export can never disagree with the on-screen
 * figures — the only new thing is the serialisation.
 *
 * ## Why one route, not one per report
 *
 * The nine report routes each have their own response schema; an export has none — it
 * returns a file, not JSON (the `getPublicInvoiceArtifact` shape). So a single
 * `GET /v1/reports/export` carries `report` + `format` and the union of the report
 * filters, dispatches to the named service, and streams the bytes with a
 * `Content-Disposition`. It stays a `GET` (a read), so the route-table's
 * "non-GET ⇒ write" invariant holds.
 *
 * ## The v1 report set, and what it omits
 *
 * The tabular-friendly reports: trial balance, P&L, balance sheet, general ledger,
 * aging, cash flow, and budget-vs-actual. `cash-flow-projection` (a bucket grid) and
 * `audit` (keyset-paged and gated on `audit.read`, not `reports.read`) are deferred.
 * Dimension-filtered and grouped export are deferred too — an export carries the base
 * filters (dates, basis, contact, account, ledger, period), not the dimension slice
 * or `groupBy`, so it exports the report's flat rows.
 */

export const REPORT_EXPORT_KINDS = [
  'trial-balance',
  'profit-and-loss',
  'balance-sheet',
  'general-ledger',
  'aging',
  'cash-flow',
  'budget-vs-actual',
] as const;

export const reportExportKindSchema = z.enum(REPORT_EXPORT_KINDS).meta({
  description:
    'Which report to export. The tabular-friendly set; projection and audit are deferred.',
});

export type ReportExportKind = (typeof REPORT_EXPORT_KINDS)[number];

export const EXPORT_FORMATS = ['csv', 'xlsx'] as const;

export const exportFormatSchema = z.enum(EXPORT_FORMATS).meta({
  description: '`csv` (RFC-4180) or `xlsx` (a real Excel workbook).',
});

export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/**
 * The export request. `report` and `format` are required; every other field is a
 * base filter one or more of the reports read (each ignores the ones it does not
 * take, the same way the JSON routes' schemas overlap). `general-ledger` requires
 * `accountId`, `aging` requires `ledger` + `asOf`, and `budget-vs-actual` requires
 * `periodId` — the service defers that validation to the underlying report service,
 * which parses its own query and returns the one indistinguishable 400/404.
 */
export const exportReportQuerySchema = z
  .strictObject({
    report: reportExportKindSchema,
    format: exportFormatSchema,
    asOf: calendarDateSchema.optional(),
    from: calendarDateSchema.optional(),
    to: calendarDateSchema.optional(),
    basis: reportBasisSchema.optional(),
    contactId: z.uuid().optional(),
    accountId: z.uuid().optional(),
    ledger: agingLedgerSchema.optional(),
    periodId: z.uuid().optional(),
  })
  .meta({
    description: 'Names a report and a format; the remaining fields are the report’s base filters.',
  });

export type ExportReportQueryParams = z.infer<typeof exportReportQuerySchema>;
