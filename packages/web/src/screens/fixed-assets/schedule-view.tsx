import type { ReactElement } from 'react';

import { Button, ErrorBanner, formatMinorUnits, ResponsiveTable } from '../../components';
import { cx } from '../../lib/cx';
import { EmptyRow, Pill, TABLE_CLASSES, TD_CLASSES, TH_CLASSES } from '../settings/section';
import type { FixedAsset, FixedAssetReferenceData, FixedAssetScheduleRow } from './queries';
import { useFixedAsset, useFixedAssetSchedule } from './queries';
import { METHOD_LABELS } from './vocabulary';

/**
 * One fixed asset, drilled into (OB-167) — `reconciliation/session-detail.tsx`'s shape: a
 * summary of the thing itself, above the one table this screen adds to it, both read
 * straight off the server rather than recomputed.
 *
 * `Σ depreciationAmountMinor` over every row equals `acquisitionCostMinor −
 * salvageValueMinor` exactly (L6, `FixedAssetScheduleRow`'s own description) — a fact worth
 * knowing, and not one this view re-checks; the schedule shown is whatever
 * `computeDepreciationSchedule` produced, in full, on registration or on the last edit that
 * changed a scheduling input.
 */
export interface AssetDetailProps {
  readonly fixedAssetId: string;
  readonly reference: FixedAssetReferenceData;
  /** The full asset, not just its id — this panel's own `useFixedAsset` fetch is the one
   *  copy of it guaranteed fresh, and the caller may not have this asset in whatever page
   *  of the register it currently holds (a filter, a later page). */
  readonly onEdit: (asset: FixedAsset) => void;
  readonly onDispose: (asset: FixedAsset) => void;
}

export function AssetDetail({
  fixedAssetId,
  reference,
  onEdit,
  onDispose,
}: AssetDetailProps): ReactElement {
  const asset = useFixedAsset(fixedAssetId);
  const schedule = useFixedAssetSchedule(fixedAssetId);

  if (asset.isPending) {
    return <p className="text-text-muted">Loading the asset…</p>;
  }

  if (asset.isError) {
    return (
      <ErrorBanner
        error={asset.error}
        onRetry={() => {
          void asset.refetch();
        }}
      />
    );
  }

  const data = asset.data;

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold text-text">{data.name}</h2>
          <p className="text-sm text-text-subtle">
            {reference.accountsById.get(data.assetAccountId)?.name ?? 'Unknown account'} &middot;{' '}
            {METHOD_LABELS[data.method]} &middot; in service {data.inServiceDate}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Pill tone={data.status === 'active' ? 'positive' : 'muted'}>
            {data.status === 'active' ? 'Active' : 'Disposed'}
          </Pill>
          {data.status === 'active' && (
            <>
              <Button
                size="sm"
                onClick={() => {
                  onEdit(data);
                }}
              >
                Edit
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={() => {
                  onDispose(data);
                }}
              >
                Dispose
              </Button>
            </>
          )}
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
        <Fact label="Acquisition cost" value={formatMinorUnits(data.acquisitionCostMinor)} />
        <Fact label="Salvage value" value={formatMinorUnits(data.salvageValueMinor)} />
        <Fact label="Useful life" value={`${String(data.usefulLifeMonths)} months`} />
        <Fact
          label="Declining rate"
          value={
            data.decliningRatePpm === null ? '—' : `${String(data.decliningRatePpm / 10_000)}%`
          }
        />
      </dl>

      {data.status === 'disposed' && (
        <div className="rounded-md border border-border bg-surface-sunken p-3 text-sm text-text-muted">
          Disposed {data.disposedDate}. Disposal journal{' '}
          <span className="font-mono">{data.disposalJournalId}</span>.
        </div>
      )}

      <ScheduleTable
        loading={schedule.isPending}
        rows={schedule.data ?? []}
        error={schedule.error}
        onRetry={() => {
          void schedule.refetch();
        }}
      />
    </div>
  );
}

function Fact({ label, value }: { readonly label: string; readonly value: string }): ReactElement {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-text-subtle">{label}</dt>
      <dd className="font-mono tabular-nums text-text">{value}</dd>
    </div>
  );
}

function ScheduleTable({
  rows,
  loading,
  error,
  onRetry,
}: {
  readonly rows: readonly FixedAssetScheduleRow[];
  readonly loading: boolean;
  readonly error: unknown;
  readonly onRetry: () => void;
}): ReactElement {
  if (error != null) {
    return <ErrorBanner error={error} onRetry={onRetry} />;
  }

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-text">Depreciation schedule</h3>
      <ResponsiveTable>
        <table className={TABLE_CLASSES}>
          <caption className="sr-only">Depreciation schedule</caption>
          <thead>
            <tr>
              <th scope="col" className={TH_CLASSES}>
                Period
              </th>
              <th scope="col" className={TH_CLASSES}>
                Date
              </th>
              <th scope="col" className={cx(TH_CLASSES, 'text-right')}>
                Amount
              </th>
              <th scope="col" className={TH_CLASSES}>
                State
              </th>
              <th scope="col" className={TH_CLASSES}>
                Journal
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <EmptyRow columns={5}>{loading ? 'Loading…' : 'No schedule.'}</EmptyRow>
            )}
            {rows.map((row) => (
              <tr key={row.periodIndex}>
                <td className={TD_CLASSES}>{row.periodIndex}</td>
                <td className={cx(TD_CLASSES, 'font-mono')}>{row.periodDate}</td>
                <td className={cx(TD_CLASSES, 'text-right font-mono tabular-nums')}>
                  {formatMinorUnits(row.depreciationAmountMinor)}
                </td>
                <td className={TD_CLASSES}>
                  <Pill tone={row.postedJournalId === null ? 'neutral' : 'positive'}>
                    {row.postedJournalId === null ? 'Pending' : 'Posted'}
                  </Pill>
                </td>
                <td className={cx(TD_CLASSES, 'font-mono text-xs text-text-subtle')}>
                  {row.postedJournalId ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ResponsiveTable>
    </div>
  );
}
