import type { ReactElement } from 'react';

import { ErrorBanner, ResponsiveTable } from '../../components';
import { cx } from '../../lib/cx';
import { EmptyRow, TABLE_CLASSES, TD_CLASSES, TH_CLASSES } from '../settings/section';
import { useReorderAlerts } from './queries';
import type { ReorderAlert } from './queries';

/**
 * Items at or below their reorder point (OB-224) — the same `belowReorderPoint` flag the
 * valuation report carries per row, pulled into its own compact table so a reorder decision
 * does not require scanning the full valuation for the flag.
 */
export function ReorderAlertsView(): ReactElement {
  const alerts = useReorderAlerts();

  if (alerts.isPending) {
    return (
      <p role="status" className="text-text-subtle">
        Loading reorder alerts…
      </p>
    );
  }

  if (alerts.isError) {
    return (
      <ErrorBanner
        error={alerts.error}
        onRetry={() => {
          void alerts.refetch();
        }}
      />
    );
  }

  return <ReorderAlertsTable alerts={alerts.data.alerts} />;
}

function ReorderAlertsTable({
  alerts,
}: {
  readonly alerts: readonly ReorderAlert[];
}): ReactElement {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-md font-semibold text-text">Reorder alerts</h3>
      <ResponsiveTable>
        <table className={TABLE_CLASSES}>
          <caption className="sr-only">Items at or below their reorder point</caption>
          <thead>
            <tr>
              <th scope="col" className={TH_CLASSES}>
                Item
              </th>
              <th scope="col" className={cx(TH_CLASSES, 'text-right')}>
                On hand
              </th>
              <th scope="col" className={cx(TH_CLASSES, 'text-right')}>
                Reorder point
              </th>
            </tr>
          </thead>
          <tbody>
            {alerts.length === 0 && (
              <EmptyRow columns={3}>Nothing is at or below its reorder point.</EmptyRow>
            )}
            {alerts.map((alert) => (
              <tr key={alert.catalogItemId}>
                <td className={TD_CLASSES}>{alert.name}</td>
                <td className={cx(TD_CLASSES, 'text-right font-mono tabular-nums')}>
                  {alert.onHandQuantity}
                </td>
                <td className={cx(TD_CLASSES, 'text-right font-mono tabular-nums')}>
                  {alert.reorderPoint}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ResponsiveTable>
    </div>
  );
}
