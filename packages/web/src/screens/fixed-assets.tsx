import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';

import { Button, ErrorBanner, Field, FieldLabel, Select } from '../components';
import { AssetFormDialog } from './fixed-assets/asset-form';
import { DepreciationAccountsPanel } from './fixed-assets/depreciation-accounts-panel';
import { DisposeAssetDialog } from './fixed-assets/dispose-dialog';
import { FixedAssetList } from './fixed-assets/list';
import {
  useDepreciationAccounts,
  useFixedAssetList,
  useFixedAssetReferenceData,
} from './fixed-assets/queries';
import type { FixedAsset, FixedAssetStatus } from './fixed-assets/queries';
import { AssetDetail } from './fixed-assets/schedule-view';

/**
 * Fixed assets (OB-163…OB-167; ROADMAP D-113…D-116) — the register the daily depreciation
 * sweep (D-113, `depreciation-sweep.ts`) posts against, one journal per due period per
 * asset.
 *
 * ## What this screen is careful not to compute
 *
 * A schedule is computed once, server-side, from five fields at registration (or at an
 * edit that changes one of them) — `CreateFixedAssetRequest`'s own words — and this screen
 * never re-derives a period's amount, a next-due date, or which periods have posted. It
 * reads `FixedAssetScheduleRow.postedJournalId` to tell posted from pending, exactly as
 * `recurring-invoices.tsx` reads `nextRunDate` rather than predicting it.
 *
 * ## Three surfaces, one register
 *
 * The list (`fixed-assets/list.tsx`) is the register itself. Selecting a row drills into
 * `fixed-assets/schedule-view.tsx` for that asset's full schedule — `reconciliation.tsx`'s
 * list-plus-detail shape, mirrored for the same reason: a schedule can run to hundreds of
 * rows, which belongs in its own panel rather than inline in a table row. Registering,
 * editing and disposing are each their own dialog, and disposal is deliberately not the same
 * control as pause/resume on the recurring-invoices screen — there is no reversible pause
 * here at all; `active` moves to `disposed` exactly once, through `dispose-dialog.tsx`'s
 * confirmation, never back.
 */

type StatusFilter = 'active' | 'disposed' | 'all';

const FILTER_OPTIONS = [
  { value: 'active', label: 'Active only' },
  { value: 'disposed', label: 'Disposed only' },
  { value: 'all', label: 'All' },
];

function toQueryStatus(filter: StatusFilter): FixedAssetStatus | null {
  return filter === 'all' ? null : filter;
}

export function FixedAssetsScreen(): ReactElement {
  const [filter, setFilter] = useState<StatusFilter>('active');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<FixedAsset | null>(null);
  const [disposing, setDisposing] = useState<FixedAsset | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const reference = useFixedAssetReferenceData();
  const depreciationAccounts = useDepreciationAccounts();
  const list = useFixedAssetList(toQueryStatus(filter));

  const assets = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-text">Fixed assets</h1>
          <p className="max-w-form text-text-muted">
            The register the daily depreciation sweep posts against — cost, salvage, method and life
            compute the whole schedule once, at registration.
          </p>
        </div>
        <Button
          variant="primary"
          // Gated on the depreciation-account defaults too, not just the chart — the
          // register form seeds both account pickers from them (`blankFormState`), and
          // opening before they arrive would show an empty picker for an org that has in
          // fact nominated a default.
          disabled={reference.data === null || depreciationAccounts.data === undefined}
          onClick={() => {
            setEditing(null);
            setFormOpen(true);
          }}
        >
          Register asset
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-3">
        <Field className="w-48">
          <FieldLabel>Status</FieldLabel>
          <Select
            value={filter}
            options={FILTER_OPTIONS}
            onValueChange={(value) => {
              if (value === 'active' || value === 'disposed' || value === 'all') {
                setFilter(value);
              }
            }}
          />
        </Field>
      </div>

      {reference.error != null && (
        <ErrorBanner error={reference.error} onRetry={reference.refetch} />
      )}

      {list.error != null && (
        <ErrorBanner
          error={list.error}
          onRetry={() => {
            void list.refetch();
          }}
        />
      )}

      {reference.data === null ? (
        <p className="text-text-subtle">Loading accounts…</p>
      ) : (
        <>
          <FixedAssetList
            assets={assets}
            reference={reference.data}
            loading={list.isPending}
            emptyMessage={
              filter === 'active'
                ? 'No active fixed assets. Registering one computes its whole depreciation ' +
                  'schedule immediately.'
                : 'No fixed assets yet.'
            }
            selectedId={selectedId}
            onSelect={(asset) => {
              setSelectedId(asset.id);
            }}
            onEdit={(asset) => {
              setEditing(asset);
              setFormOpen(true);
            }}
            onDispose={(asset) => {
              setDisposing(asset);
            }}
          />

          {list.hasNextPage && (
            <div>
              <Button
                disabled={list.isFetchingNextPage}
                onClick={() => {
                  void list.fetchNextPage();
                }}
              >
                {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          )}

          {selectedId !== null && (
            <AssetDetail
              // Keyed on the asset, so drilling into a second one starts its own fetch
              // rather than showing the previous asset's schedule while the new one loads.
              key={selectedId}
              fixedAssetId={selectedId}
              reference={reference.data}
              onEdit={(asset) => {
                setEditing(asset);
                setFormOpen(true);
              }}
              onDispose={(asset) => {
                setDisposing(asset);
              }}
            />
          )}

          <DepreciationAccountsPanel reference={reference.data} />

          <AssetFormDialog
            asset={editing}
            reference={reference.data}
            depreciationAccounts={depreciationAccounts.data ?? null}
            open={formOpen}
            onOpenChange={(open) => {
              setFormOpen(open);
              if (!open) setEditing(null);
            }}
          />

          <DisposeAssetDialog
            asset={disposing}
            reference={reference.data}
            onOpenChange={(open) => {
              if (!open) setDisposing(null);
            }}
          />
        </>
      )}
    </div>
  );
}
