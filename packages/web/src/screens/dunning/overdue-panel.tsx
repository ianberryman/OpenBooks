import type { ReactElement } from 'react';

import { ErrorBanner, formatMoney, ResponsiveTable } from '../../components';
import { cx } from '../../lib/cx';
import {
  EmptyRow,
  SettingsSection,
  TABLE_CLASSES,
  TD_CLASSES,
  TH_CLASSES,
} from '../settings/section';
import { todayIsoDate, useOverdueInvoices } from './queries';

/**
 * A read-only look at what the policies above would be chasing — secondary to the policy
 * CRUD, which is why it is its own card below the list rather than a tab or a column next
 * to it.
 *
 * There is no dunning-specific "what's overdue" endpoint (`queries.ts`'s
 * `useOverdueInvoices` explains why this reads the AR aging report, `GET
 * /v1/reports/aging`, and flattens it). This panel does not let the date move — unlike
 * `money-in/aging.tsx`'s full report, which makes `asOf` a control because D-40 requires a
 * reproducible historical statement, this is "what needs chasing today", and there is
 * nothing to reproduce about today.
 */
const DISPLAY_LIMIT = 10;

export function OverduePanel(): ReactElement {
  const asOf = todayIsoDate();
  const overdue = useOverdueInvoices(asOf);
  const items = overdue.data ?? [];
  const shown = items.slice(0, DISPLAY_LIMIT);

  return (
    <SettingsSection
      title="Overdue invoices"
      description="What is past due today, across every customer — the invoices a policy above would be chasing. Read-only: nothing here is sent from this screen."
    >
      {overdue.isError && (
        <ErrorBanner
          error={overdue.error}
          onRetry={() => {
            void overdue.refetch();
          }}
        />
      )}

      <ResponsiveTable>
        <table className={TABLE_CLASSES}>
          <caption className="sr-only">Overdue invoices, most overdue first</caption>
          <thead>
            <tr>
              <th scope="col" className={TH_CLASSES}>
                Contact
              </th>
              <th scope="col" className={TH_CLASSES}>
                Invoice
              </th>
              <th scope="col" className={TH_CLASSES}>
                Due
              </th>
              <th scope="col" className={cx(TH_CLASSES, 'text-right')}>
                Days overdue
              </th>
              <th scope="col" className={cx(TH_CLASSES, 'text-right')}>
                Outstanding
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <EmptyRow columns={5}>
                {overdue.isPending ? 'Loading…' : `Nothing is overdue as at ${asOf}.`}
              </EmptyRow>
            )}
            {shown.map((entry) => (
              <tr key={entry.documentId}>
                <td className={TD_CLASSES}>{entry.contactName}</td>
                <td className={cx(TD_CLASSES, 'font-mono')}>{entry.documentNumber}</td>
                <td className={cx(TD_CLASSES, 'font-mono')}>{entry.dueDate}</td>
                <td className={cx(TD_CLASSES, 'text-right font-mono tabular-nums')}>
                  {entry.daysPastDue}
                </td>
                <td className={cx(TD_CLASSES, 'text-right font-mono tabular-nums')}>
                  {formatMoney(entry.outstanding)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ResponsiveTable>

      {items.length > DISPLAY_LIMIT && (
        <p className="text-xs text-text-subtle">
          Showing the {DISPLAY_LIMIT} most overdue of {items.length}. The full list is the
          receivable aging report.
        </p>
      )}
    </SettingsSection>
  );
}
