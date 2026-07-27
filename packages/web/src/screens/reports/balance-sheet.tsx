import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';

import { api, unwrap } from '../../api';
import type { components } from '../../api';
import { ErrorBanner } from '../../components';
import { AmountCell, GroupHeading, isZeroAmount } from './cells';
import type { DrillTarget, ReportFilterState } from './filters';
import { sliceQuery } from './filters';
import { BasisBadge, ReportPending, ReportTitle } from './layout';
import { StatementSection, SubtotalNote } from './statement';

/**
 * The balance sheet (OB-043; B2, B3, B6, B7; D-20).
 *
 * ## Two derived lines, and they are not accounts
 *
 * With no year-end closing journal, revenue and expense balances have nowhere to land, so
 * a sheet built from account balances alone does not balance. M2 derives what a close
 * would have moved, and it is **two** figures rather than one:
 *
 * ```
 * assets = liabilities + equity + priorYearEarnings + currentYearEarnings
 * ```
 *
 * `priorYearEarnings` is everything strictly before the fiscal-year start;
 * `currentYearEarnings` is the movement within it. The one-line version of D-20 — a single
 * current-year line — holds only for an org in its first year; in its second, last year's
 * profit is still sitting in the revenue and expense accounts and the sheet is out by
 * exactly that.
 *
 * So both are printed **outside the equity table**, labelled derived, with the fiscal year
 * they were measured over named beside them. A reader who takes either for an account will
 * go looking for it in the chart and not find it; worse, a reader who assumes it is the
 * org's retained-earnings account will believe the sheet double-counts, because retained
 * earnings is an ordinary equity account and is already inside `equity`, counted once.
 *
 * The fiscal year is printed for a reason of its own: its start month is a per-org setting
 * (D-17), so two orgs reading a sheet at the same date measure current-year earnings over
 * different windows. And a wrong year boundary moves money *between* the two derived lines
 * without changing their sum — the sheet still foots — so the window is the only thing on
 * screen that can show it.
 */

type BalanceSheet = components['schemas']['BalanceSheet'];
type BalanceSheetGroup = components['schemas']['BalanceSheetGroup'];
type BalanceSheetFiscalYear = components['schemas']['BalanceSheetFiscalYear'];

export interface BalanceSheetViewProps {
  readonly state: ReportFilterState;
  readonly onDrillThrough: (target: DrillTarget) => void;
}

export function BalanceSheetView({ state, onDrillThrough }: BalanceSheetViewProps): ReactElement {
  const asOf = state.to;
  const query = { asOf, ...sliceQuery(state) };

  const report = useQuery({
    queryKey: ['reports', 'balance-sheet', query],
    queryFn: async (): Promise<BalanceSheet> =>
      unwrap(await api.GET('/v1/reports/balance-sheet', { params: { query } })),
    /**
     * `asOf` is required here where the trial balance's is optional, and the screen
     * enforces it rather than sending an empty one: the fiscal year the earnings
     * derivation is scoped to is resolved *from the report date*, so a missing date would
     * have to come from a clock and the same enquiry would answer differently on either
     * side of a year end.
     */
    enabled: asOf !== '',
  });

  if (asOf === '') {
    return (
      <p className="rounded-md border border-border bg-surface-sunken px-3 py-2 text-sm text-text-muted">
        A balance sheet is a position at a point in time. Choose a date to draw it at.
      </p>
    );
  }
  if (report.isPending) return <ReportPending />;
  if (report.isError) {
    return (
      <ErrorBanner
        error={report.error}
        onRetry={() => {
          void report.refetch();
        }}
      />
    );
  }

  return (
    <BalanceSheetReport
      report={report.data}
      hideZeroRows={state.hideZeroRows}
      onDrillThrough={onDrillThrough}
    />
  );
}

export function BalanceSheetReport({
  report,
  hideZeroRows,
  onDrillThrough,
}: {
  readonly report: BalanceSheet;
  readonly hideZeroRows: boolean;
  readonly onDrillThrough: (target: DrillTarget) => void;
}): ReactElement {
  const groupBy = report.groupBy;

  return (
    <div className="flex flex-col gap-4">
      <ReportTitle
        title="Balance sheet"
        subtitle={`As at ${report.asOf}`}
        aside={<BasisBadge basis={report.basis} />}
      />
      <SubtotalNote />

      {report.groups.map((group) => (
        <BalanceSheetGroupView
          key={group.key?.dimensionValueId ?? 'unassigned'}
          group={group}
          fiscalYear={report.fiscalYear}
          showHeading={groupBy !== null}
          hideZeroRows={hideZeroRows}
          onDrillThrough={(accountId) => {
            onDrillThrough({
              accountId,
              group: groupBy === null ? null : { dimensionId: groupBy, key: group.key },
            });
          }}
        />
      ))}

      {groupBy !== null && (
        <div className="flex flex-col gap-1">
          <h3 className="text-md font-semibold text-text">Every slice, including unassigned</h3>
          <FootingTable totals={report.totals} fiscalYear={report.fiscalYear} />
          <p className="text-xs text-text-subtle">
            One slice may be out of balance on its own: tags are per line (D-18), so a single
            journal&rsquo;s debit and credit can carry different values and a bucket then holds one
            side of an entry. It is the report as a whole that must foot, and these totals equal the
            same sheet run without a slice (B6).
          </p>
        </div>
      )}
    </div>
  );
}

function BalanceSheetGroupView({
  group,
  fiscalYear,
  showHeading,
  hideZeroRows,
  onDrillThrough,
}: {
  readonly group: BalanceSheetGroup;
  readonly fiscalYear: BalanceSheetFiscalYear;
  readonly showHeading: boolean;
  readonly hideZeroRows: boolean;
  readonly onDrillThrough: (accountId: string) => void;
}): ReactElement {
  return (
    <div className="flex flex-col gap-3">
      {showHeading && <GroupHeading groupKey={group.key} />}

      <StatementSection
        title="Assets"
        rows={group.assets.rows}
        total={group.assets.total}
        totalLabel="Total assets"
        hideZeroRows={hideZeroRows}
        onDrillThrough={onDrillThrough}
      />
      <StatementSection
        title="Liabilities"
        rows={group.liabilities.rows}
        total={group.liabilities.total}
        totalLabel="Total liabilities"
        hideZeroRows={hideZeroRows}
        onDrillThrough={onDrillThrough}
      />
      <StatementSection
        title="Equity"
        rows={group.equity.rows}
        total={group.equity.total}
        totalLabel="Total equity accounts"
        hideZeroRows={hideZeroRows}
        onDrillThrough={onDrillThrough}
      />

      <FootingTable totals={group.totals} fiscalYear={fiscalYear} />
    </div>
  );
}

/**
 * The footing: the three account sections, the two derived lines, and the identity.
 *
 * Deliberately a separate table from the equity section above it. Putting these rows in
 * that table would place two figures that are not accounts among the accounts, in the same
 * columns, with no way for a reader to tell them apart — and the equity section's own total
 * would then appear to omit them.
 */
function FootingTable({
  totals,
  fiscalYear,
}: {
  readonly totals: components['schemas']['BalanceSheetTotals'];
  readonly fiscalYear: BalanceSheetFiscalYear;
}): ReactElement {
  const balanced = isZeroAmount(totals.difference);

  return (
    <table aria-label="Footing" className="w-full border-collapse text-base">
      <tbody>
        <FootingRow label="Total liabilities" value={totals.liabilities} />
        <FootingRow label="Total equity accounts" value={totals.equity} />
        <FootingRow
          label="Prior-year earnings"
          note={`Derived, not an account — revenue less expenses for every fiscal year before ${fiscalYear.startDate}.`}
          value={totals.priorYearEarnings}
        />
        <FootingRow
          label="Current-year earnings"
          note={`Derived, not an account — revenue less expenses over fiscal year ${String(fiscalYear.year)} (${fiscalYear.startDate} to ${fiscalYear.endDate}).`}
          value={totals.currentYearEarnings}
        />
        <FootingRow
          label="Total liabilities and equity"
          value={totals.liabilitiesAndEquity}
          emphasis
          rule
        />
        <FootingRow label="Total assets" value={totals.assets} emphasis />
        <FootingRow
          label="Difference"
          note={
            balanced
              ? 'Assets less liabilities and equity. The sheet balances without a closing journal (B3).'
              : 'Assets less liabilities and equity. Reported rather than asserted, so a discrepancy is visible.'
          }
          value={totals.difference}
          emphasis={!balanced}
        />
      </tbody>
    </table>
  );
}

function FootingRow({
  label,
  note,
  value,
  emphasis,
  rule,
}: {
  readonly label: string;
  readonly note?: string;
  readonly value: string;
  readonly emphasis?: boolean;
  readonly rule?: boolean;
}): ReactElement {
  return (
    <tr className={rule === true ? 'border-t-2 border-border-strong' : 'border-t border-border'}>
      <th scope="row" className="px-3 py-1 text-left font-normal">
        <span className="flex flex-col">
          <span className={emphasis === true ? 'font-semibold' : undefined}>{label}</span>
          {note !== undefined && <span className="text-xs text-text-subtle">{note}</span>}
        </span>
      </th>
      <AmountCell value={value} emphasis={emphasis ?? false} />
    </tr>
  );
}
