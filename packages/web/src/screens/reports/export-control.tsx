import type { ReactElement } from 'react';

import { Button } from '../../components';
import { API_BASE_URL } from '../../env';
import type { ReportFilterState } from './filters';
import type { ReportView } from './views';

/**
 * The "Export" action on the reports toolbar (OB-220).
 *
 * The export endpoint (`GET /v1/reports/export`) is a plain authenticated `GET` that
 * answers with `Content-Disposition: attachment` — the same origin and the same cookie
 * as every other request this app makes (`api/client.ts`), so there is no fetch/blob
 * dance here: navigating the browser to the URL *is* the download.
 *
 * Only five of the eight tabs can be exported. `cash-flow-projection` and `audit` have no
 * `report` value on the wire at all, and `budget-vs-actual`/`aging` own their own toolbars
 * (`reports.tsx`'s `CAPABILITIES` note explains why) — their export affordance, if any,
 * belongs there rather than here.
 */

export type ExportFormat = 'csv' | 'xlsx';

const EXPORTABLE_VIEWS: ReadonlySet<ReportView> = new Set<ReportView>([
  'trial-balance',
  'profit-and-loss',
  'balance-sheet',
  'general-ledger',
  'cash-flow',
]);

export function isExportableView(view: ReportView): boolean {
  return EXPORTABLE_VIEWS.has(view);
}

/**
 * The query params each report's export shares with its live view — `filters.ts` argues
 * the same split (`rangeQuery`, `basisQuery`) for the on-screen fetch, and this mirrors it
 * rather than reusing it directly: the export params are a strict subset (no `dimensions`,
 * no `groupBy` — the server-side export is unsliced) and folding them into one function
 * would let a param meant for the viewer leak onto the download by accident.
 *
 * Returns `null` when the view cannot be exported yet: no `report` kind at all
 * (`cash-flow-projection`, `budget-vs-actual`, `audit`), a point-in-time report with no
 * date chosen, or a general ledger with no account selected — none of those have a
 * `report=` value the server would accept.
 */
export function buildExportUrl(
  view: ReportView,
  format: ExportFormat,
  filters: ReportFilterState,
  ledgerAccountId: string | null,
): string | null {
  const params = new URLSearchParams();

  switch (view) {
    case 'trial-balance': {
      if (filters.to === '') return null;
      params.set('report', 'trial-balance');
      params.set('asOf', filters.to);
      break;
    }
    case 'profit-and-loss': {
      params.set('report', 'profit-and-loss');
      if (filters.from !== '') params.set('from', filters.from);
      if (filters.to !== '') params.set('to', filters.to);
      params.set('basis', filters.basis);
      break;
    }
    case 'balance-sheet': {
      // No `basis`: the balance-sheet endpoint does not take one (`CAPABILITIES` in
      // `reports.tsx` — it is not among K1's basis-aware reports).
      if (filters.to === '') return null;
      params.set('report', 'balance-sheet');
      params.set('asOf', filters.to);
      break;
    }
    case 'general-ledger': {
      if (ledgerAccountId === null) return null;
      params.set('report', 'general-ledger');
      if (filters.from !== '') params.set('from', filters.from);
      if (filters.to !== '') params.set('to', filters.to);
      params.set('accountId', ledgerAccountId);
      break;
    }
    case 'cash-flow': {
      params.set('report', 'cash-flow');
      if (filters.from !== '') params.set('from', filters.from);
      if (filters.to !== '') params.set('to', filters.to);
      break;
    }
    // Not offered from this control (OB-220): `cash-flow-projection` and `audit` are
    // deferred from export entirely, and `budget-vs-actual` (like aging) takes filters
    // this shared toolbar does not hold — its own screen is where its export would live.
    case 'cash-flow-projection':
    case 'budget-vs-actual':
    case 'audit':
      return null;
  }

  params.set('format', format);
  return `${API_BASE_URL}/v1/reports/export?${params.toString()}`;
}

/**
 * A same-origin `GET` with no body and no response this code needs to read, so a
 * momentary anchor is the whole implementation — the browser does the download, using the
 * filename the server's `Content-Disposition` names, exactly as `statement-packages.tsx`'s
 * `downloadUrl` link does for the PDF case.
 */
function triggerDownload(url: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = '';
  anchor.rel = 'noreferrer';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export interface ExportControlProps {
  readonly view: ReportView;
  readonly filters: ReportFilterState;
  /** `null` until an account is chosen on the general ledger — see `buildExportUrl`. */
  readonly ledgerAccountId: string | null;
}

export function ExportControl({
  view,
  filters,
  ledgerAccountId,
}: ExportControlProps): ReactElement | null {
  if (!isExportableView(view)) return null;

  const awaitingAccount = view === 'general-ledger' && ledgerAccountId === null;

  function download(format: ExportFormat): void {
    const url = buildExportUrl(view, format, filters, ledgerAccountId);
    if (url === null) return;
    triggerDownload(url);
  }

  return (
    <div className="flex items-center gap-2">
      {awaitingAccount && (
        <span className="text-xs text-text-subtle">Choose an account to export</span>
      )}
      <Button
        size="sm"
        disabled={awaitingAccount}
        onClick={() => {
          download('csv');
        }}
      >
        Export CSV
      </Button>
      <Button
        size="sm"
        disabled={awaitingAccount}
        onClick={() => {
          download('xlsx');
        }}
      >
        Export Excel
      </Button>
    </div>
  );
}
