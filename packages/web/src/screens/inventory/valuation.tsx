import type { ReactElement } from 'react';
import { useState } from 'react';

import { ErrorBanner, Pill, ResponsiveTable, formatMoney } from '../../components';
import { cx } from '../../lib/cx';
import { EmptyRow, TABLE_CLASSES, TD_CLASSES, TH_CLASSES } from '../settings/section';
import { useInventoryValuation } from './queries';
import type { InventoryValuation, InventoryValuationRow } from './queries';

/**
 * The inventory valuation report (OB-224) — every catalog item currently on hand, its
 * server-costed unit cost and value, and whether it has fallen to or below its reorder
 * point. `reports/balance-sheet.tsx`'s `asOf` shape: a position at a point in time, so this
 * screen owns a date control rather than always showing "now".
 *
 * Value and unit cost are read off the response, never recomputed here — the server owns
 * the costing method (D-13's discipline: money is a minor-unit string, arithmetic on it
 * belongs to whoever already validated it).
 */

function today(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${String(now.getFullYear())}-${month}-${day}`;
}

export function InventoryValuationView(): ReactElement {
  const [asOf, setAsOf] = useState<string>(today);
  const report = useInventoryValuation(asOf);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-3">
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-text">As of</span>
          <input
            type="date"
            value={asOf}
            onChange={(event) => {
              setAsOf(event.target.value);
            }}
            className={cx(
              'h-9 rounded-md border border-border bg-surface px-2 text-base text-text',
              'font-mono tabular-nums',
            )}
          />
        </label>
      </div>

      {report.isPending && (
        <p role="status" className="text-text-subtle">
          Running the valuation…
        </p>
      )}

      {report.isError && (
        <ErrorBanner
          error={report.error}
          onRetry={() => {
            void report.refetch();
          }}
        />
      )}

      {report.data !== undefined && <InventoryValuationTable report={report.data} />}
    </div>
  );
}

function InventoryValuationTable({
  report,
}: {
  readonly report: InventoryValuation;
}): ReactElement {
  return (
    <ResponsiveTable>
      <table className={TABLE_CLASSES}>
        <caption className="sr-only">{`Inventory valuation as of ${report.asOf}`}</caption>
        <thead>
          <tr>
            <th scope="col" className={TH_CLASSES}>
              Item
            </th>
            <th scope="col" className={TH_CLASSES}>
              SKU
            </th>
            <th scope="col" className={cx(TH_CLASSES, 'text-right')}>
              On hand
            </th>
            <th scope="col" className={cx(TH_CLASSES, 'text-right')}>
              Unit cost
            </th>
            <th scope="col" className={cx(TH_CLASSES, 'text-right')}>
              Value
            </th>
            <th scope="col" className={TH_CLASSES}>
              <span className="sr-only">Reorder status</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {report.rows.length === 0 && (
            <EmptyRow columns={6}>No inventory items are on hand as of this date.</EmptyRow>
          )}
          {report.rows.map((row) => (
            <InventoryValuationRowView key={row.catalogItemId} row={row} />
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-border-strong">
            <th scope="row" colSpan={4} className={cx(TD_CLASSES, 'text-right font-semibold')}>
              Total value
            </th>
            <td className={cx(TD_CLASSES, 'text-right font-mono tabular-nums font-semibold')}>
              {formatMoney(report.totalValue)}
            </td>
            <td className={TD_CLASSES} />
          </tr>
        </tfoot>
      </table>
    </ResponsiveTable>
  );
}

function InventoryValuationRowView({ row }: { readonly row: InventoryValuationRow }): ReactElement {
  return (
    <tr>
      <td className={TD_CLASSES}>{row.name}</td>
      <td className={cx(TD_CLASSES, 'font-mono text-xs text-text-subtle')}>{row.code ?? '—'}</td>
      <td className={cx(TD_CLASSES, 'text-right font-mono tabular-nums')}>{row.onHandQuantity}</td>
      <td className={cx(TD_CLASSES, 'text-right font-mono tabular-nums')}>
        {row.unitCost === null ? '—' : formatMoney(row.unitCost)}
      </td>
      <td className={cx(TD_CLASSES, 'text-right font-mono tabular-nums')}>
        {formatMoney(row.value)}
      </td>
      <td className={TD_CLASSES}>
        {row.belowReorderPoint && <Pill tone="negative">Below reorder point</Pill>}
      </td>
    </tr>
  );
}
