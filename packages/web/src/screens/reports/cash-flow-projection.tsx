import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useState } from 'react';

import { api, unwrap } from '../../api';
import type { components } from '../../api';
import { ErrorBanner, Select } from '../../components';
import type { SelectOption } from '../../components';
import { cx } from '../../lib/cx';
import { AmountCell } from './cells';
import { todayCalendarDate } from './filters';
import { ReportPending, ReportTitle } from './layout';

/**
 * The forward cash-flow projection (OB-158; ROADMAP D-88, K6).
 *
 * The odd one out among these viewers, and deliberately so: every other report in
 * this directory shares `ReportFilterState` and `ReportControls` (`reports.tsx`),
 * because a P&L, a balance sheet and a general ledger all answer "what happened,
 * or what stands, over this range" and take the same range/slice arguments. This
 * report answers a different question — "what will happen" — and its controls
 * are its own: `asOf` is where the forecast starts rather than a range bound,
 * there is no dimension slice (D-88 scopes K6 to AR/AP due dates only), and
 * `horizon`/`granularity` have no equivalent on any other endpoint here. Bolting
 * it onto the shared toolbar would mean either widening every other report's
 * capabilities for a control none of them use, or a `ReportCapabilities` variant
 * that hides everything and shows nothing — this file's own small toolbar is
 * plainer than either.
 */

type CashFlowProjection = components['schemas']['CashFlowProjection'];
type CashFlowProjectionBucket = components['schemas']['CashFlowProjectionBucket'];
type CashFlowGranularity = CashFlowProjection['granularity'];

const GRANULARITY_OPTIONS: readonly SelectOption[] = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
];

/**
 * The wire enum is a closed, two-member union; `Select`'s `onValueChange` hands
 * back the plain `string` any generic select must — this is the one place that
 * narrows it back, and it can only ever see one of the two values `Select` was
 * given.
 */
function isGranularity(value: string): value is CashFlowGranularity {
  return value === 'weekly' || value === 'monthly';
}

const HORIZON_MIN = 1;
const HORIZON_MAX = 52;
const HORIZON_DEFAULT = 12;

export function CashFlowProjectionView(): ReactElement {
  const [asOf, setAsOf] = useState(todayCalendarDate());
  const [granularity, setGranularity] = useState<CashFlowGranularity>('monthly');
  const [horizon, setHorizon] = useState(HORIZON_DEFAULT);

  const query = { asOf, granularity, horizon };
  const report = useQuery({
    queryKey: ['reports', 'cash-flow-projection', query],
    queryFn: async (): Promise<CashFlowProjection> =>
      unwrap(await api.GET('/v1/reports/cash-flow-projection', { params: { query } })),
  });

  return (
    <div className="flex flex-col gap-4">
      <CashFlowProjectionControls
        asOf={asOf}
        onAsOfChange={setAsOf}
        granularity={granularity}
        onGranularityChange={setGranularity}
        horizon={horizon}
        onHorizonChange={setHorizon}
      />

      {report.isPending && <ReportPending />}
      {report.isError && (
        <ErrorBanner
          error={report.error}
          onRetry={() => {
            void report.refetch();
          }}
        />
      )}
      {report.isSuccess && <CashFlowProjectionReport report={report.data} />}
    </div>
  );
}

function CashFlowProjectionControls({
  asOf,
  onAsOfChange,
  granularity,
  onGranularityChange,
  horizon,
  onHorizonChange,
}: {
  readonly asOf: string;
  readonly onAsOfChange: (value: string) => void;
  readonly granularity: CashFlowGranularity;
  readonly onGranularityChange: (value: CashFlowGranularity) => void;
  readonly horizon: number;
  readonly onHorizonChange: (value: number) => void;
}): ReactElement {
  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-3">
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-text">As of</span>
        <input
          type="date"
          value={asOf}
          onChange={(event) => {
            onAsOfChange(event.target.value);
          }}
          className={cx(
            'h-9 rounded-md border border-border bg-surface px-2 text-base text-text',
            'font-mono tabular-nums',
          )}
        />
      </label>

      {/* A `<div>` and an `aria-label`, not a `<label>`: `Select`'s trigger is a button,
          which `<label>` cannot be associated with (`controls.tsx`'s `groupBy` control). */}
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-text">Bucket</span>
        <Select
          aria-label="Bucket"
          value={granularity}
          options={GRANULARITY_OPTIONS}
          onValueChange={(value) => {
            if (isGranularity(value)) onGranularityChange(value);
          }}
          className="w-32"
        />
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-text">Horizon (buckets)</span>
        <input
          type="number"
          min={HORIZON_MIN}
          max={HORIZON_MAX}
          value={horizon}
          onChange={(event) => {
            const parsed = Number(event.target.value);
            if (Number.isInteger(parsed) && parsed >= HORIZON_MIN && parsed <= HORIZON_MAX) {
              onHorizonChange(parsed);
            }
          }}
          className="h-9 w-24 rounded-md border border-border bg-surface px-2 text-base text-text font-mono tabular-nums"
        />
      </label>
    </div>
  );
}

export function CashFlowProjectionReport({
  report,
}: {
  readonly report: CashFlowProjection;
}): ReactElement {
  return (
    <div className="flex flex-col gap-3">
      <ReportTitle
        title="Cash-flow projection"
        subtitle={`Forecast from ${report.asOf}, ${report.granularity} buckets`}
      />

      <table aria-label="Cash-flow projection" className="w-full border-collapse text-base">
        <thead>
          <tr className="border-b border-border text-xs text-text-subtle">
            <th scope="col" className="px-3 py-1 text-left font-medium">
              Period
            </th>
            <th scope="col" className="px-3 py-1 text-right font-medium">
              Expected in
            </th>
            <th scope="col" className="px-3 py-1 text-right font-medium">
              Expected out
            </th>
            <th scope="col" className="px-3 py-1 text-right font-medium">
              Net change
            </th>
            <th scope="col" className="px-3 py-1 text-right font-medium">
              Projected closing cash
            </th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-border bg-surface-sunken">
            <th scope="row" className="px-3 py-1 text-left font-semibold" colSpan={4}>
              Opening cash, at {report.asOf}
            </th>
            <AmountCell value={report.openingCash} emphasis />
          </tr>
          {report.buckets.map((bucket) => (
            <BucketRow key={`${bucket.periodStart}-${bucket.periodEnd}`} bucket={bucket} />
          ))}
        </tbody>
      </table>

      {report.buckets.length === 0 && (
        <p className="text-text-subtle">Nothing to project — the horizon has no buckets in it.</p>
      )}

      {!report.includesRecurringCommitments && (
        <p className="text-xs text-text-subtle">
          This forecast is built from outstanding invoice and bill due dates only. It does not yet
          include recurring commitments — a rent payment or a payroll run with no invoice or bill
          behind it — because recurring journals do not exist in OpenBooks yet.
        </p>
      )}
    </div>
  );
}

function BucketRow({ bucket }: { readonly bucket: CashFlowProjectionBucket }): ReactElement {
  return (
    <tr className="border-b border-border last:border-0">
      <th scope="row" className="px-3 py-1 text-left font-normal">
        {bucket.periodStart} – {bucket.periodEnd}
      </th>
      <AmountCell value={bucket.expectedInflows} />
      <AmountCell value={bucket.expectedOutflows} />
      <AmountCell value={bucket.netChange} />
      <AmountCell value={bucket.projectedClosingCash} emphasis />
    </tr>
  );
}
