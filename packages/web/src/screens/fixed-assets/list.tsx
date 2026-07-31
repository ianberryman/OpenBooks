import type { ReactElement } from 'react';

import { Button, formatMinorUnits, ResponsiveTable } from '../../components';
import { cx } from '../../lib/cx';
import { EmptyRow, Pill, TABLE_CLASSES, TD_CLASSES, TH_CLASSES } from '../settings/section';
import type { FixedAsset, FixedAssetReferenceData } from './queries';
import { METHOD_LABELS } from './vocabulary';

/**
 * One page of the register.
 *
 * `status` is read off the response, never derived — `disposeFixedAsset` is the only path
 * from `active` to `disposed` and it is one-way (`FixedAsset.status`'s own words), so this
 * table simply shows what the server last said, the same discipline `recurring-invoices/
 * list.tsx` keeps for `isActive` and `nextRunDate`.
 */
export interface FixedAssetListProps {
  readonly assets: readonly FixedAsset[];
  readonly reference: FixedAssetReferenceData;
  readonly loading: boolean;
  readonly emptyMessage: string;
  readonly selectedId: string | null;
  readonly onSelect: (asset: FixedAsset) => void;
  readonly onEdit: (asset: FixedAsset) => void;
  readonly onDispose: (asset: FixedAsset) => void;
}

export function FixedAssetList({
  assets,
  reference,
  loading,
  emptyMessage,
  selectedId,
  onSelect,
  onEdit,
  onDispose,
}: FixedAssetListProps): ReactElement {
  return (
    <ResponsiveTable>
      <table className={TABLE_CLASSES}>
        <caption className="sr-only">Fixed assets</caption>
        <thead>
          <tr>
            <th scope="col" className={TH_CLASSES}>
              Name
            </th>
            <th scope="col" className={TH_CLASSES}>
              Asset account
            </th>
            <th scope="col" className={TH_CLASSES}>
              Method
            </th>
            <th scope="col" className={cx(TH_CLASSES, 'text-right')}>
              Acquisition cost
            </th>
            <th scope="col" className={TH_CLASSES}>
              In service
            </th>
            <th scope="col" className={TH_CLASSES}>
              Status
            </th>
            <th scope="col" className={cx(TH_CLASSES, 'text-right')}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {assets.length === 0 && (
            <EmptyRow columns={7}>{loading ? 'Loading…' : emptyMessage}</EmptyRow>
          )}
          {assets.map((asset) => (
            <tr key={asset.id} aria-selected={selectedId === asset.id}>
              <td className={TD_CLASSES}>
                <button
                  type="button"
                  onClick={() => {
                    onSelect(asset);
                  }}
                  className="rounded-sm text-left text-text underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
                >
                  {asset.name}
                </button>
                {asset.description !== null && asset.description !== '' && (
                  <span className="block text-xs text-text-subtle">{asset.description}</span>
                )}
              </td>
              <td className={TD_CLASSES}>
                {reference.accountsById.get(asset.assetAccountId)?.name ?? 'Unknown account'}
              </td>
              <td className={TD_CLASSES}>{METHOD_LABELS[asset.method]}</td>
              <td className={cx(TD_CLASSES, 'text-right font-mono tabular-nums')}>
                {formatMinorUnits(asset.acquisitionCostMinor)}
              </td>
              <td className={cx(TD_CLASSES, 'font-mono')}>{asset.inServiceDate}</td>
              <td className={TD_CLASSES}>
                <Pill tone={asset.status === 'active' ? 'positive' : 'muted'}>
                  {asset.status === 'active' ? 'Active' : 'Disposed'}
                </Pill>
              </td>
              <td className={cx(TD_CLASSES, 'text-right')}>
                <div className="flex justify-end gap-1">
                  <Button
                    size="sm"
                    onClick={() => {
                      onSelect(asset);
                    }}
                  >
                    View
                  </Button>
                  {asset.status === 'active' && (
                    <>
                      <Button
                        size="sm"
                        onClick={() => {
                          onEdit(asset);
                        }}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        aria-label={`Dispose ${asset.name}`}
                        onClick={() => {
                          onDispose(asset);
                        }}
                      >
                        Dispose
                      </Button>
                    </>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ResponsiveTable>
  );
}
