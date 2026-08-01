import type {
  BudgetVsActualQueryParams,
  ExportFormat,
  ExportReportQueryParams,
  GeneralLedger,
  GeneralLedgerEntry,
  ReportExportKind,
} from '@openbooks/shared-types';
import { exportReportQuerySchema } from '@openbooks/shared-types';

import { getContext } from '../../../context';
import type { RequestContext } from '../../../context';
import { InternalError, parseInput } from '../../../errors';
import { requirePermission } from '../../permissions';
import { getTrialBalance } from '../../ledger';
import type { TrialBalanceQuery } from '../../ledger';
import type { AgingQuery } from '../aging.service';
import { getAging } from '../aging.service';
import type { BalanceSheetQuery } from '../balance-sheet.service';
import { getBalanceSheet } from '../balance-sheet.service';
import { getBudgetVsActual } from '../budget-vs-actual.service';
import type { StatementOfCashFlowsQuery } from '../cash-flow.service';
import { getStatementOfCashFlows } from '../cash-flow.service';
import type { GeneralLedgerQuery } from '../general-ledger.service';
import { getGeneralLedger } from '../general-ledger.service';
import type { ProfitAndLossQuery } from '../profit-and-loss.service';
import { getProfitAndLoss } from '../profit-and-loss.service';

import {
  agingToTabular,
  balanceSheetToTabular,
  budgetVsActualToTabular,
  cashFlowToTabular,
  generalLedgerToTabular,
  profitAndLossToTabular,
  trialBalanceToTabular,
} from './adapters';
import { toCsv } from './csv';
import type { TabularReport } from './tabular';
import { toXlsx } from './xlsx';

/**
 * Report CSV/Excel export (OB-220 part 2; `shared-types/reports/export.ts`).
 *
 * One service for all seven exportable reports: run the same report service the
 * JSON route runs, flatten its result with the matching adapter in
 * `adapters.ts`, and serialise the flat table with `csv.ts` or `xlsx.ts`. It
 * can never disagree with the on-screen figures, because there is no second
 * aggregation anywhere in this file — every number here was computed by the
 * report service that already owns it.
 *
 * `requirePermission(ctx, 'reports.read')` is called here as well as inside
 * whichever report service runs, matching the reason `reports.ts`'s file header
 * gives for the JSON routes: each service states its own authority rather than
 * inheriting one from a function it happens to call, and a caller that only
 * imported `exportReport` should not be trusted on the strength of *that*
 * function forwarding to something else that checks.
 */

/** What a caller gets back: bytes plus what to tell the HTTP layer about them. */
export interface ExportedReport {
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

const CONTENT_TYPES: Record<ExportFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/**
 * Each report's own query schema is the validation authority, not this one.
 * `exportReportQuerySchema` is deliberately loose — every filter optional beyond
 * `report`/`format` — because the union of seven reports' requirements is not one
 * schema's business to restate; a request missing what a given report needs (GL's
 * `accountId`, aging's `ledger`/`asOf`, budget vs actual's `periodId`) reaches
 * that report's own `parseInput` below and gets that report's own 400. The `as`
 * casts in each branch exist for exactly that gap: the object literal is built
 * from optional fields, and the target type states a filter as required because
 * that report requires it — the cast defers the check to the call it wraps
 * rather than re-encoding seven reports' required-field rules here.
 */
async function buildTabular(
  filters: ExportReportQueryParams,
  ctx: RequestContext,
): Promise<TabularReport> {
  switch (filters.report) {
    case 'trial-balance': {
      const query: TrialBalanceQuery = {
        ...(filters.asOf === undefined ? {} : { asOf: filters.asOf }),
      };
      return trialBalanceToTabular(await getTrialBalance(query, ctx));
    }

    case 'profit-and-loss': {
      const query: ProfitAndLossQuery = {
        ...(filters.from === undefined ? {} : { from: filters.from }),
        ...(filters.to === undefined ? {} : { to: filters.to }),
        ...(filters.basis === undefined ? {} : { basis: filters.basis }),
        ...(filters.contactId === undefined ? {} : { contactId: filters.contactId }),
      };
      return profitAndLossToTabular(await getProfitAndLoss(query, ctx));
    }

    case 'balance-sheet': {
      const query = {
        asOf: filters.asOf,
        ...(filters.contactId === undefined ? {} : { contactId: filters.contactId }),
      } as BalanceSheetQuery;
      return balanceSheetToTabular(await getBalanceSheet(query, ctx));
    }

    case 'general-ledger': {
      const entries: GeneralLedgerEntry[] = [];
      let cursor: string | undefined;
      let page: GeneralLedger | undefined;
      // Keyset-paged (D-21) — one call returns one page, so this loops on
      // `nextCursor` and accumulates every page's `entries` before handing the
      // adapter the whole ledger. The header (opening/movement/closing) rides on
      // the *last* page fetched, matching `general-ledger.ts`'s own note that the
      // header is a true statement about the ledger at the moment that page was
      // read — an export runs to completion, so the last page's header is the
      // one that describes the file as a whole.
      do {
        const query = {
          accountId: filters.accountId,
          ...(filters.from === undefined ? {} : { from: filters.from }),
          ...(filters.to === undefined ? {} : { to: filters.to }),
          ...(filters.contactId === undefined ? {} : { contactId: filters.contactId }),
          ...(cursor === undefined ? {} : { cursor }),
        } as GeneralLedgerQuery;
        // Sequential on purpose: the next page's cursor is this page's response, so the
        // whole ledger is walked one page at a time before it is flattened for export.
        page = await getGeneralLedger(query, ctx);
        entries.push(...page.entries);
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);

      if (page === undefined) throw new InternalError('General ledger export produced no page.');
      return generalLedgerToTabular({ ...page, entries });
    }

    case 'aging': {
      const query = {
        asOf: filters.asOf,
        ledger: filters.ledger,
        ...(filters.contactId === undefined ? {} : { contactId: filters.contactId }),
      } as AgingQuery;
      return agingToTabular(await getAging(query, ctx));
    }

    case 'cash-flow': {
      const query: StatementOfCashFlowsQuery = {
        ...(filters.from === undefined ? {} : { from: filters.from }),
        ...(filters.to === undefined ? {} : { to: filters.to }),
        ...(filters.basis === undefined ? {} : { basis: filters.basis }),
      };
      return cashFlowToTabular(await getStatementOfCashFlows(query, ctx));
    }

    case 'budget-vs-actual': {
      const query = {
        periodId: filters.periodId,
        ...(filters.basis === undefined ? {} : { basis: filters.basis }),
      } as BudgetVsActualQueryParams;
      return budgetVsActualToTabular(await getBudgetVsActual(query, ctx));
    }
  }
}

function filenameFor(
  report: ReportExportKind,
  filters: ExportReportQueryParams,
  format: ExportFormat,
): string {
  const datePart = filters.asOf ?? filters.to ?? 'all';
  return `${report}-${datePart}.${format}`;
}

export async function exportReport(
  query: ExportReportQueryParams,
  ctx: RequestContext = getContext('exportReport()'),
): Promise<ExportedReport> {
  await requirePermission(ctx, 'reports.read');
  const filters = parseInput(exportReportQuerySchema, query);

  const tabular = await buildTabular(filters, ctx);
  const bytes =
    filters.format === 'csv' ? new TextEncoder().encode(toCsv(tabular)) : toXlsx(tabular);

  return {
    filename: filenameFor(filters.report, filters, filters.format),
    contentType: CONTENT_TYPES[filters.format],
    bytes,
  };
}
