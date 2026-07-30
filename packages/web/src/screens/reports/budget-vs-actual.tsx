import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useState } from 'react';

import { api, unwrap } from '../../api';
import type { components } from '../../api';
import { ErrorBanner, Select } from '../../components';
import { cx } from '../../lib/cx';
import { AmountCell, GroupHeading, isZeroAmount } from './cells';
import type { ReportFilterState } from './filters';
import { basisQuery, sliceQuery, todayCalendarDate } from './filters';
import { BasisBadge, ReportPending, ReportTitle, describeRange } from './layout';

/**
 * Budget vs actual (OB-182; ROADMAP N, D-N1…D-N6).
 *
 * ## Why this view has no `CAPABILITIES` entry
 *
 * Every other report in this directory shares one filter toolbar (`ReportControls`),
 * gated per-report through `CAPABILITIES` in `reports.tsx`. This report cannot join that
 * scheme even though it wants `basis`/`groupBy`/dimensions from the same shared state: its
 * one required argument is a `periodId` (D-N4), and `ReportControls` renders its "To"/"As
 * at" date field **unconditionally** whenever a report has an entry at all — there is no
 * `ReportCapabilities.dates` value that suppresses it. Taking an entry would put a date
 * input on screen that edits `state.to` and does nothing for this query, with no
 * `UnusedControlNotice` wired to say so (that notice only knows about the *lower* bound
 * being ignored). Rather than add a misleading control or widen `controls.tsx` — out of
 * this ticket's scope — this view stays off the shared toolbar entirely, the same way
 * `cash-flow-projection.tsx` does, and renders its own period picker instead.
 *
 * `basis`, `groupBy` and the dimension filters are still read from the shared
 * `ReportFilterState`, though: this file has no control for them, so they carry whatever
 * was last set on one of the other tabs. That keeps "the budget for the department I just
 * filtered on the P&L tab" a tab switch rather than a re-entry, which is the whole reason
 * the state is shared in the first place (`filters.ts`).
 *
 * ## The cash-basis guard
 *
 * Cash-basis budget-vs-actual reuses `assertCashBasisSupported`'s refusal of basis+slice
 * together (D-N3, same guard as `profit-and-loss.service.ts`), so this view mirrors
 * `ProfitAndLossView`'s query construction: `sliceQuery` is only spread in on accrual.
 */

type BudgetVsActual = components['schemas']['BudgetVsActual'];
type BudgetVsActualGroup = components['schemas']['BudgetVsActualGroup'];
type BudgetVsActualSection = components['schemas']['BudgetVsActualSection'];
type FiscalPeriod = components['schemas']['FiscalPeriod'];

interface Triplet {
  readonly budget: string;
  readonly actual: string;
  readonly variance: string;
}

const PERIODS_QUERY_KEY = ['reports', 'budget-vs-actual', 'periods'] as const;

/**
 * The period containing today, or the most recent one that has started, or (an org whose
 * periods are all in the future) the earliest one. Never a blank selection when periods
 * exist — a reader opening this tab wants this month's budget, not an empty report.
 */
function defaultPeriodId(periods: readonly FiscalPeriod[]): string | null {
  if (periods.length === 0) return null;
  const today = todayCalendarDate();
  const byRecency = [...periods].sort((left, right) =>
    right.startDate.localeCompare(left.startDate),
  );
  const started = byRecency.find((period) => period.startDate <= today);
  return (started ?? byRecency[byRecency.length - 1])?.id ?? null;
}

export interface BudgetVsActualViewProps {
  readonly state: ReportFilterState;
}

export function BudgetVsActualView({ state }: BudgetVsActualViewProps): ReactElement {
  const periods = useQuery({
    queryKey: PERIODS_QUERY_KEY,
    queryFn: async () => unwrap(await api.GET('/v1/fiscal-periods')),
  });
  const periodList = periods.data?.periods ?? [];

  const [selectedPeriodId, setSelectedPeriodId] = useState<string | null>(null);
  const periodId = selectedPeriodId ?? defaultPeriodId(periodList);

  const query = {
    periodId: periodId ?? '',
    // Mirrors `ProfitAndLossView`: cash basis forbids a dimension slice (D-N3), so the
    // slice parameters are withheld rather than sent and refused.
    ...(state.basis === 'cash' ? {} : sliceQuery(state)),
    ...basisQuery(state),
  };
  const report = useQuery({
    queryKey: ['reports', 'budget-vs-actual', query],
    queryFn: async (): Promise<BudgetVsActual> =>
      unwrap(await api.GET('/v1/reports/budget-vs-actual', { params: { query } })),
    enabled: periodId !== null,
  });

  return (
    <div className="flex flex-col gap-4">
      <PeriodControl
        periods={periodList}
        pending={periods.isPending}
        value={periodId}
        onChange={setSelectedPeriodId}
      />

      {periods.isError && (
        <ErrorBanner
          error={periods.error}
          onRetry={() => {
            void periods.refetch();
          }}
        />
      )}

      {periods.isSuccess && periodList.length === 0 && (
        <p className="text-text-subtle">
          No fiscal periods exist yet. Generate one from Settings before running this report — every
          budget and every posting belongs to a period, and nothing creates one on your behalf.
        </p>
      )}

      {periodId !== null && report.isPending && <ReportPending />}
      {periodId !== null && report.isError && (
        <ErrorBanner
          error={report.error}
          onRetry={() => {
            void report.refetch();
          }}
        />
      )}
      {periodId !== null && report.isSuccess && (
        <BudgetVsActualReport report={report.data} hideZeroRows={state.hideZeroRows} />
      )}
    </div>
  );
}

function PeriodControl({
  periods,
  pending,
  value,
  onChange,
}: {
  readonly periods: readonly FiscalPeriod[];
  readonly pending: boolean;
  readonly value: string | null;
  readonly onChange: (periodId: string) => void;
}): ReactElement {
  const byRecency = [...periods].sort((left, right) =>
    right.startDate.localeCompare(left.startDate),
  );

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-3">
      {/* A `<div>` and an `aria-label`, not a `<label>`: `Select`'s trigger is a button,
          which `<label>` cannot be associated with (`controls.tsx`'s `groupBy` control). */}
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-text">Period</span>
        <Select
          aria-label="Period"
          value={value}
          placeholder={pending ? 'Loading…' : 'Choose a period'}
          disabled={periods.length === 0}
          options={byRecency.map((period) => ({
            value: period.id,
            label: `${period.name} (${period.startDate} – ${period.endDate})`,
          }))}
          onValueChange={onChange}
          className="w-72"
        />
      </div>
    </div>
  );
}

export function BudgetVsActualReport({
  report,
  hideZeroRows,
}: {
  readonly report: BudgetVsActual;
  readonly hideZeroRows: boolean;
}): ReactElement {
  const groupBy = report.groupBy;

  return (
    <div className="flex flex-col gap-4">
      <ReportTitle
        title="Budget vs actual"
        subtitle={`${report.period.name} — ${describeRange(report.period.startDate, report.period.endDate)}`}
        aside={<BasisBadge basis={report.basis} />}
      />

      {report.groups.map((group) => (
        <BudgetVsActualGroupView
          key={group.key?.dimensionValueId ?? 'unassigned'}
          group={group}
          showHeading={groupBy !== null}
          hideZeroRows={hideZeroRows}
        />
      ))}

      {groupBy !== null && (
        <TripletTable
          ariaLabel="Every slice, including unassigned"
          caption="Every slice, including unassigned"
          rows={[
            { label: 'Revenue', triplet: report.totals.revenue },
            { label: 'Expenses', triplet: report.totals.expenses },
            { label: 'Net income', triplet: report.totals.netIncome, emphasis: true },
          ]}
        />
      )}

      {groupBy !== null && (
        <p className="text-xs text-text-subtle">
          These totals equal the same report run without a slice — tagging never moves money (B6),
          which is why the unassigned bucket is always one of the groups above.
        </p>
      )}
    </div>
  );
}

function BudgetVsActualGroupView({
  group,
  showHeading,
  hideZeroRows,
}: {
  readonly group: BudgetVsActualGroup;
  readonly showHeading: boolean;
  readonly hideZeroRows: boolean;
}): ReactElement {
  return (
    <div className="flex flex-col gap-3">
      {showHeading && <GroupHeading groupKey={group.key} />}

      <BudgetVsActualSectionTable
        title="Revenue"
        section={group.revenue}
        hideZeroRows={hideZeroRows}
      />
      <BudgetVsActualSectionTable
        title="Expenses"
        section={group.expenses}
        hideZeroRows={hideZeroRows}
      />

      {/* The server's own `netIncome`, not `revenue − expenses` recomputed here — matching
          `profit-and-loss.tsx`'s rule that this layer does no arithmetic (`cells.tsx`). */}
      <TripletTable
        ariaLabel="Net income"
        rows={[{ label: 'Net income', triplet: group.netIncome, emphasis: true }]}
      />
    </div>
  );
}

function BudgetVsActualSectionTable({
  title,
  section,
  hideZeroRows,
}: {
  readonly title: string;
  readonly section: BudgetVsActualSection;
  readonly hideZeroRows: boolean;
}): ReactElement {
  const visible = hideZeroRows
    ? section.rows.filter((row) => !(isZeroAmount(row.budget) && isZeroAmount(row.actual)))
    : section.rows;

  return (
    <section className="flex flex-col gap-1">
      <h4 className="text-sm font-semibold tracking-wide text-text-muted uppercase">{title}</h4>
      <table aria-label={title} className="w-full border-collapse text-base">
        <thead>
          <tr className="border-b border-border text-xs text-text-subtle">
            <th scope="col" className="px-3 py-1 text-left font-medium">
              Account
            </th>
            <th scope="col" className="px-3 py-1 text-right font-medium">
              Budget
            </th>
            <th scope="col" className="px-3 py-1 text-right font-medium">
              Actual
            </th>
            <th scope="col" className="px-3 py-1 text-right font-medium">
              Variance
            </th>
            <th scope="col" className="px-3 py-1 text-right font-medium">
              Variance %
            </th>
          </tr>
        </thead>
        <tbody>
          {visible.length === 0 && (
            <tr>
              <td colSpan={5} className="px-3 py-2 text-text-subtle">
                {hideZeroRows ? 'Every account in this section stands at zero.' : 'No accounts.'}
              </td>
            </tr>
          )}
          {visible.map((row) => (
            <tr key={row.accountId} className="border-b border-border last:border-0">
              <th scope="row" className="px-3 py-1 text-left font-normal">
                <span className="flex items-baseline gap-2">
                  <span className="font-mono text-xs text-text-subtle">{row.code}</span>
                  {row.name}
                </span>
              </th>
              <AmountCell value={row.budget} />
              <AmountCell value={row.actual} />
              {/* Signed to the section the same way `ProfitAndLossRow`'s amounts are — a
                  positive variance is favourable, and `AmountCell` colors it accordingly
                  with no sign flip in this layer (`cells.tsx`). */}
              <AmountCell value={row.variance} />
              <VariancePercentCell value={row.variancePercent} />
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-border-strong">
            <th scope="row" className="px-3 py-1 text-left font-semibold">
              Total {title.toLowerCase()}
            </th>
            <AmountCell value={section.budget} emphasis />
            <AmountCell value={section.actual} emphasis />
            <AmountCell value={section.variance} emphasis />
            <td />
          </tr>
        </tfoot>
      </table>
    </section>
  );
}

/**
 * `variancePercent` arrives as a plain number (`variance / budget × 100`) rather than a
 * wire cents string, because it is a ratio and not an amount — so it takes its own cell
 * rather than `AmountCell`, which formats minor units. It borrows the same two amount
 * tokens `AmountCell`/`Amount` use (`cells.tsx`) rather than a color invented here, and
 * `null` — a zero budget, which the section header comment says rows are still included
 * for — prints as a dash instead of a claimed 0%.
 */
function VariancePercentCell({ value }: { readonly value: number | null }): ReactElement {
  return (
    <td className="px-3 py-1 text-right whitespace-nowrap">
      {value === null ? (
        <span aria-hidden className="text-text-subtle">
          —
        </span>
      ) : (
        <span
          className={cx(
            'font-mono tabular-nums',
            value < 0 ? 'text-amount-negative' : 'text-amount-positive',
          )}
        >
          {value > 0 ? '+' : ''}
          {value.toFixed(1)}%
        </span>
      )}
    </td>
  );
}

function TripletTable({
  ariaLabel,
  caption,
  rows,
}: {
  readonly ariaLabel: string;
  readonly caption?: string;
  readonly rows: readonly {
    readonly label: string;
    readonly triplet: Triplet;
    readonly emphasis?: boolean;
  }[];
}): ReactElement {
  return (
    <table aria-label={ariaLabel} className="w-full border-collapse text-base">
      {caption !== undefined && (
        <caption className="pt-2 pb-1 text-left text-sm font-semibold text-text">{caption}</caption>
      )}
      <thead>
        <tr className="border-b border-border text-xs text-text-subtle">
          <th scope="col" className="px-3 py-1 text-left font-medium">
            <span className="sr-only">Line</span>
          </th>
          <th scope="col" className="px-3 py-1 text-right font-medium">
            Budget
          </th>
          <th scope="col" className="px-3 py-1 text-right font-medium">
            Actual
          </th>
          <th scope="col" className="px-3 py-1 text-right font-medium">
            Variance
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.label}
            className={
              row.emphasis === true
                ? 'border-t-2 border-border-strong'
                : 'border-b border-border last:border-0'
            }
          >
            <th
              scope="row"
              className={cx(
                'px-3 py-1 text-left',
                row.emphasis === true ? 'font-semibold' : 'font-normal',
              )}
            >
              {row.label}
            </th>
            <AmountCell value={row.triplet.budget} emphasis={row.emphasis ?? false} />
            <AmountCell value={row.triplet.actual} emphasis={row.emphasis ?? false} />
            <AmountCell value={row.triplet.variance} emphasis={row.emphasis ?? false} />
          </tr>
        ))}
      </tbody>
    </table>
  );
}
