import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';

import { api, unwrap } from '../../api';
import type { components } from '../../api';
import { ErrorBanner } from '../../components';
import { AmountCell, GroupHeading } from './cells';
import type { DrillTarget, ReportFilterState } from './filters';
import { rangeQuery, sliceQuery } from './filters';
import { BasisBadge, ReportPending, ReportTitle, describeRange } from './layout';
import { StatementSection, SubtotalNote } from './statement';

/**
 * The profit and loss (OB-042; B2, B6, B7).
 *
 * ## Nothing here flips a sign
 *
 * The server has already signed both sections to their own side: revenue is positive when
 * the org earned, expense is positive when it spent, and `netIncome = revenue − expenses`
 * is positive for a profit. The flip keys off the account's `type` and never its
 * `normalBalance`, which is what makes a contra-revenue account — sales discounts,
 * returns — subtract from revenue as a discount should. Flipping again here would undo
 * exactly that, and it would look right on every chart without a contra account, which is
 * most charts until the first one appears.
 *
 * ## Slices
 *
 * A sliced statement is one group per dimension value **plus the unassigned bucket**, and
 * `totals` is every group summed including that bucket — equal to the same statement run
 * without `groupBy`, which is B6. Both are rendered: the groups so the reader can see the
 * division, the totals so they can see it adds back up.
 */

type ProfitAndLoss = components['schemas']['ProfitAndLoss'];
type ProfitAndLossGroup = components['schemas']['ProfitAndLossGroup'];

export interface ProfitAndLossViewProps {
  readonly state: ReportFilterState;
  readonly onDrillThrough: (target: DrillTarget) => void;
}

export function ProfitAndLossView({ state, onDrillThrough }: ProfitAndLossViewProps): ReactElement {
  const query = { ...rangeQuery(state), ...sliceQuery(state) };
  const report = useQuery({
    queryKey: ['reports', 'profit-and-loss', query],
    queryFn: async (): Promise<ProfitAndLoss> =>
      unwrap(await api.GET('/v1/reports/profit-and-loss', { params: { query } })),
  });

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
    <ProfitAndLossReport
      report={report.data}
      hideZeroRows={state.hideZeroRows}
      onDrillThrough={onDrillThrough}
    />
  );
}

export function ProfitAndLossReport({
  report,
  hideZeroRows,
  onDrillThrough,
}: {
  readonly report: ProfitAndLoss;
  readonly hideZeroRows: boolean;
  readonly onDrillThrough: (target: DrillTarget) => void;
}): ReactElement {
  const groupBy = report.groupBy;

  return (
    <div className="flex flex-col gap-4">
      <ReportTitle
        title="Profit and loss"
        subtitle={describeRange(report.range.from, report.range.to)}
        aside={<BasisBadge basis={report.basis} />}
      />
      <SubtotalNote />
      <ReviewNotice review={report.review} />

      {report.groups.map((group) => (
        <ProfitAndLossGroupView
          key={group.key?.dimensionValueId ?? 'unassigned'}
          group={group}
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
        <table className="w-full border-collapse text-base">
          <caption className="pt-2 pb-1 text-left text-sm font-semibold text-text">
            Every slice, including unassigned
          </caption>
          <tbody>
            <TotalRow label="Revenue" value={report.totals.revenue} />
            <TotalRow label="Expenses" value={report.totals.expenses} />
            <TotalRow label="Net income" value={report.totals.netIncome} emphasis />
          </tbody>
        </table>
      )}

      {groupBy !== null && (
        <p className="text-xs text-text-subtle">
          These totals equal the same statement run without a slice — tagging never moves money
          (B6), which is why the unassigned bucket is always one of the groups above.
        </p>
      )}
    </div>
  );
}

function ProfitAndLossGroupView({
  group,
  showHeading,
  hideZeroRows,
  onDrillThrough,
}: {
  readonly group: ProfitAndLossGroup;
  readonly showHeading: boolean;
  readonly hideZeroRows: boolean;
  readonly onDrillThrough: (accountId: string) => void;
}): ReactElement {
  return (
    <div className="flex flex-col gap-3">
      {showHeading && <GroupHeading groupKey={group.key} />}

      <StatementSection
        title="Revenue"
        rows={group.revenue.rows}
        total={group.revenue.total}
        totalLabel="Total revenue"
        hideZeroRows={hideZeroRows}
        onDrillThrough={onDrillThrough}
      />
      <StatementSection
        title="Expenses"
        rows={group.expenses.rows}
        total={group.expenses.total}
        totalLabel="Total expenses"
        hideZeroRows={hideZeroRows}
        onDrillThrough={onDrillThrough}
      />

      <table aria-label="Result" className="w-full border-collapse text-base">
        <tbody>
          {/* The server's own `netIncome`, not `revenue.total − expenses.total` recomputed
              here. There is one place these figures are summed and it is not the browser. */}
          <TotalRow label="Net income" value={group.netIncome} emphasis />
        </tbody>
      </table>
    </div>
  );
}

function TotalRow({
  label,
  value,
  emphasis,
}: {
  readonly label: string;
  readonly value: string;
  readonly emphasis?: boolean;
}): ReactElement {
  return (
    <tr className="border-t-2 border-border-strong">
      <th scope="row" className="px-3 py-1 text-left font-semibold">
        {label}
      </th>
      <AmountCell value={value} emphasis={emphasis ?? false} />
    </tr>
  );
}

/**
 * The cash-basis edges the transform flagged rather than guessed (K3/K4). Rendered
 * where a reader will see it — above the numbers — so a cash-basis statement never
 * looks complete while quietly leaving out an unapplied receipt or a mixed journal.
 * Renders nothing on accrual basis or a clean run: `review` is empty there.
 */
function ReviewNotice({
  review,
}: {
  readonly review: components['schemas']['ProfitAndLoss']['review'];
}): ReactElement | null {
  if (review.length === 0) return null;

  return (
    <div
      role="status"
      className="rounded-md border border-border bg-surface-sunken px-3 py-2 text-sm text-text-muted"
    >
      <p className="font-medium text-text">Some entries are not recognised and need review</p>
      <ul className="mt-1 list-disc pl-5">
        {review.map((flag) => (
          <li key={flag.kind}>{flag.detail}</li>
        ))}
      </ul>
    </div>
  );
}
