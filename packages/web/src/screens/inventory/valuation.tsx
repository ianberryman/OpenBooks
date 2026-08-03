import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';

import { ErrorBanner, Pill, ResponsiveTable, formatMoney } from '../../components';
import { cx } from '../../lib/cx';
import { EmptyRow, TABLE_CLASSES, TD_CLASSES, TH_CLASSES } from '../settings/section';
import { useInventoryValuation } from './queries';
import type { InventoryValuation, InventoryValuationRow } from './queries';

/**
 * The stock list — every tracked item's current on-hand quantity and value (OB-224), and
 * the hub's route into an item's own movement ledger. `asOf` is always the server's default
 * of today: this is the operational view of "what do we have right now", not a historical
 * report, so unlike `reports/balance-sheet.tsx` this carries no date control of its own.
 *
 * Value and unit cost are read off the response, never recomputed here — the server owns
 * the costing method (D-13's discipline: money is a minor-unit string, arithmetic on it
 * belongs to whoever already validated it).
 */
export function InventoryStockList(): ReactElement {
  const report = useInventoryValuation(null);

  if (report.isPending) {
    return (
      <p role="status" className="text-text-subtle">
        Loading stock…
      </p>
    );
  }

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

  return <InventoryStockTable report={report.data} />;
}

function InventoryStockTable({ report }: { readonly report: InventoryValuation }): ReactElement {
  const navigate = useNavigate();

  return (
    <ResponsiveTable>
      <table className={TABLE_CLASSES}>
        <caption className="sr-only">{`Inventory stock as of ${report.asOf}`}</caption>
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
            <EmptyRow columns={6}>
              No tracked items yet — create one to start counting stock.
            </EmptyRow>
          )}
          {report.rows.map((row) => (
            <InventoryStockRow
              key={row.catalogItemId}
              row={row}
              onOpen={() => {
                void navigate(`/inventory/${row.catalogItemId}`);
              }}
            />
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

function InventoryStockRow({
  row,
  onOpen,
}: {
  readonly row: InventoryValuationRow;
  readonly onOpen: () => void;
}): ReactElement {
  return (
    <tr>
      <td className={TD_CLASSES}>
        <button
          type="button"
          onClick={onOpen}
          className="rounded-sm text-left text-text underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
        >
          {row.name}
        </button>
      </td>
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
