import type { ReactElement } from 'react';
import { Link, useParams } from 'react-router-dom';

import { ErrorBanner, Pill, ResponsiveTable, formatMoney } from '../../components';
import type { PillTone } from '../../components';
import { cx } from '../../lib/cx';
import { EmptyRow, TABLE_CLASSES, TD_CLASSES, TH_CLASSES } from '../settings/section';
import { useItemLedger } from './queries';
import type { InventoryItemLedger, InventoryLedgerEntry } from './queries';

/**
 * One tracked item, drilled into (OB-224) — `fixed-assets/schedule-view.tsx`'s shape: a
 * summary of the thing itself, above the one table this screen adds to it, both read
 * straight off the server rather than recomputed.
 *
 * The movement ledger is the append-only audit trail behind the header's on-hand: every
 * receipt, sale, adjustment, true-up and reversal, oldest first, each carrying the running
 * on-hand quantity and value it left. The last entry's running totals equal the header's,
 * by construction on the server (`InventoryItemLedger`'s own contract) — nothing here
 * re-folds the deltas to check that.
 */
export function InventoryItemDetail(): ReactElement {
  const { itemId } = useParams();

  if (itemId === undefined) {
    return <ErrorBanner error={new Error('No item id in the route.')} />;
  }

  return <ItemDetailContent itemId={itemId} />;
}

function ItemDetailContent({ itemId }: { readonly itemId: string }): ReactElement {
  const ledger = useItemLedger(itemId);

  return (
    <div className="flex flex-col gap-4">
      <Link
        to="/inventory"
        className="w-fit text-sm text-text-muted underline-offset-2 hover:underline"
      >
        ← Back to inventory
      </Link>

      {ledger.isPending && (
        <p role="status" className="text-text-subtle">
          Loading the item…
        </p>
      )}

      {ledger.isError && (
        <ErrorBanner
          error={ledger.error}
          onRetry={() => {
            void ledger.refetch();
          }}
        />
      )}

      {ledger.data !== undefined && <ItemDetailBody item={ledger.data} />}
    </div>
  );
}

function ItemDetailBody({ item }: { readonly item: InventoryItemLedger }): ReactElement {
  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold text-text">{item.name}</h2>
          {item.code !== null && <p className="font-mono text-xs text-text-subtle">{item.code}</p>}
        </div>
        {item.reorderPoint !== null && <Pill tone="muted">Reorder at {item.reorderPoint}</Pill>}
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
        <Fact label="On hand" value={item.onHandQuantity} />
        <Fact label="Unit cost" value={item.unitCost === null ? '—' : formatMoney(item.unitCost)} />
        <Fact label="Value" value={formatMoney(item.value)} />
        <Fact label="Reorder point" value={item.reorderPoint ?? '—'} />
      </dl>

      <MovementTable entries={item.entries} />
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

const MOVEMENT_LABELS: Readonly<Record<InventoryLedgerEntry['movementType'], string>> = {
  receipt: 'Receipt',
  sale: 'Sale',
  adjustment: 'Adjustment',
  true_up: 'True-up',
  reversal: 'Reversal',
};

const MOVEMENT_TONES: Readonly<Record<InventoryLedgerEntry['movementType'], PillTone>> = {
  receipt: 'positive',
  sale: 'accent',
  adjustment: 'neutral',
  true_up: 'muted',
  reversal: 'negative',
};

function MovementTable({
  entries,
}: {
  readonly entries: readonly InventoryLedgerEntry[];
}): ReactElement {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-text">Movement ledger</h3>
      <ResponsiveTable>
        <table className={TABLE_CLASSES}>
          <caption className="sr-only">Stock movements, oldest first</caption>
          <thead>
            <tr>
              <th scope="col" className={TH_CLASSES}>
                Date
              </th>
              <th scope="col" className={TH_CLASSES}>
                Type
              </th>
              <th scope="col" className={TH_CLASSES}>
                Source
              </th>
              <th scope="col" className={cx(TH_CLASSES, 'text-right')}>
                Qty change
              </th>
              <th scope="col" className={cx(TH_CLASSES, 'text-right')}>
                Value change
              </th>
              <th scope="col" className={cx(TH_CLASSES, 'text-right')}>
                Running on hand
              </th>
              <th scope="col" className={cx(TH_CLASSES, 'text-right')}>
                Running value
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 && <EmptyRow columns={7}>No movements yet.</EmptyRow>}
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td className={cx(TD_CLASSES, 'font-mono')}>{entry.movementDate}</td>
                <td className={TD_CLASSES}>
                  <Pill tone={MOVEMENT_TONES[entry.movementType]}>
                    {MOVEMENT_LABELS[entry.movementType]}
                  </Pill>
                </td>
                <td className={cx(TD_CLASSES, 'text-xs text-text-subtle')}>
                  {entry.sourceDocType === null
                    ? '—'
                    : entry.sourceDocId === null
                      ? entry.sourceDocType
                      : `${entry.sourceDocType} · ${entry.sourceDocId}`}
                </td>
                <td className={cx(TD_CLASSES, 'text-right font-mono tabular-nums')}>
                  {entry.quantityDelta}
                </td>
                <td className={cx(TD_CLASSES, 'text-right font-mono tabular-nums')}>
                  {formatMoney(entry.valueDelta)}
                </td>
                <td className={cx(TD_CLASSES, 'text-right font-mono tabular-nums')}>
                  {entry.runningQuantity}
                </td>
                <td className={cx(TD_CLASSES, 'text-right font-mono tabular-nums')}>
                  {formatMoney(entry.runningValue)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ResponsiveTable>
    </div>
  );
}
