import type { ReactElement } from 'react';
import { useState } from 'react';

import { cx } from '../lib/cx';
import { BalanceSheetView } from './reports/balance-sheet';
import type { ReportCapabilities } from './reports/controls';
import { ReportControls, UnusedControlNotice, useDimensions } from './reports/controls';
import type { DrillTarget, ReportFilterState } from './reports/filters';
import { initialFilterState, pinGroupFilter } from './reports/filters';
import { GeneralLedgerView, generalLedgerKey } from './reports/general-ledger';
import { ProfitAndLossView } from './reports/profit-and-loss';
import { TrialBalanceView } from './reports/trial-balance';

/**
 * The four report viewers (OB-052).
 *
 * Trial balance, profit and loss, balance sheet, general ledger — with **one** set of
 * controls in front of them and a drill-through from any report line into the entries
 * behind it. The date range, the dimension filters and the slice axis are shared state
 * (`reports/filters.ts`), because a bookkeeper reads a period rather than a report: the
 * P&L for March and the balance sheet at 31 March are one enquiry, and controls that reset
 * between tabs would make checking one against the other a re-entry exercise.
 *
 * Each viewer declares what its endpoint actually accepts, and anything set that this
 * report will ignore is stated rather than dropped — see `UnusedControlNotice`. That
 * matters most on the trial balance, which takes only an upper bound: a reader who filtered
 * by department and switched to it would otherwise be comparing a slice against the whole
 * and seeing no sign of it.
 *
 * ## Drill-through
 *
 * Every account line is a control. Clicking one opens the general ledger for that account
 * with the current range and filters carried over — and, from a sliced statement, with the
 * bucket's own dimension value pinned onto the slice axis, so the entries shown are the
 * lines that produced the figure clicked. The unassigned bucket pins `includeUnassigned`
 * instead, which is the case no list of value ids can express and the reason that field
 * exists on the filter at all (D-18).
 *
 * The view lives in component state and not in the URL. The general ledger is deliberately
 * linkable — the report routes are `GET` partly for that reason — but the route table
 * belongs to the shell, so a deep link is a URL this screen cannot mint yet.
 */

type ReportView = 'trial-balance' | 'profit-and-loss' | 'balance-sheet' | 'general-ledger';

const VIEWS: readonly { readonly id: ReportView; readonly label: string }[] = [
  { id: 'trial-balance', label: 'Trial balance' },
  { id: 'profit-and-loss', label: 'Profit and loss' },
  { id: 'balance-sheet', label: 'Balance sheet' },
  { id: 'general-ledger', label: 'General ledger' },
];

const CAPABILITIES: Readonly<Record<ReportView, ReportCapabilities>> = {
  // M1's endpoint: one inclusive upper bound, and nothing else.
  'trial-balance': { dates: 'asOf', dimensions: false, groupBy: false },
  'profit-and-loss': { dates: 'range', dimensions: true, groupBy: true },
  // A position at a point in time, so no lower bound. `asOf` is required, and the fiscal
  // year the derived earnings lines are scoped to is resolved from it (D-20).
  'balance-sheet': { dates: 'asOf', dimensions: true, groupBy: true },
  // No `groupBy`: dividing a list of individual lines into columns is a cross-tabulation
  // and not a ledger.
  'general-ledger': { dates: 'range', dimensions: true, groupBy: false },
};

export function ReportsScreen(): ReactElement {
  const [view, setView] = useState<ReportView>('trial-balance');
  const [filters, setFilters] = useState<ReportFilterState>(initialFilterState);
  const [ledgerAccountId, setLedgerAccountId] = useState<string | null>(null);

  const dimensions = useDimensions();
  const capabilities = CAPABILITIES[view];

  function drillThrough(target: DrillTarget): void {
    setFilters(target.group === null ? filters : pinGroupFilter(filters, target.group));
    setLedgerAccountId(target.accountId);
    setView('general-ledger');
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold text-text">Reports</h1>

      {/**
       * A group of buttons rather than a tablist. Radix ships no Tabs primitive here, and a
       * hand-rolled `role="tablist"` owes a roving-tabindex keyboard model that native
       * buttons already provide — the same trade `Combobox` documents in the other
       * direction, where no native control exists.
       */}
      <div role="group" aria-label="Report" className="flex flex-wrap gap-1">
        {VIEWS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            aria-pressed={view === entry.id}
            onClick={() => {
              setView(entry.id);
            }}
            className={cx(
              'rounded-md border px-3 py-1 text-base transition-colors',
              view === entry.id
                ? 'border-border bg-surface-selected font-medium text-text'
                : 'border-transparent text-text-muted hover:bg-surface-hover hover:text-text',
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <ReportControls
        state={filters}
        onChange={setFilters}
        capabilities={capabilities}
        dimensions={dimensions}
      />
      <UnusedControlNotice state={filters} capabilities={capabilities} />

      {view === 'trial-balance' && (
        <TrialBalanceView
          state={filters}
          onDrillThrough={(accountId) => {
            drillThrough({ accountId, group: null });
          }}
        />
      )}
      {view === 'profit-and-loss' && (
        <ProfitAndLossView state={filters} onDrillThrough={drillThrough} />
      )}
      {view === 'balance-sheet' && (
        <BalanceSheetView state={filters} onDrillThrough={drillThrough} />
      )}
      {view === 'general-ledger' && (
        <GeneralLedgerView
          /**
           * Remounted when the enquiry changes, which is what resets the cursor stack and
           * the remembered closing balance. A cursor is a position in one list; carrying it
           * into another pages into rows it was never taken from (D-21).
           */
          key={generalLedgerKey(filters, ledgerAccountId)}
          state={filters}
          accountId={ledgerAccountId}
          onAccountChange={setLedgerAccountId}
        />
      )}
    </div>
  );
}
