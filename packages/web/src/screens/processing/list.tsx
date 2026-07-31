import type { ReactElement } from 'react';

import { Button, Pill, ResponsiveTable } from '../../components';
import { cx } from '../../lib/cx';
import { EmptyRow, TABLE_CLASSES, TD_CLASSES, TH_CLASSES } from '../settings/section';
import { formatTimestamp } from '../settings/support';
import type { ProcessingReferenceData, ProcessorConnection } from './queries';

const PROCESSOR_LABEL: Readonly<Record<ProcessorConnection['processor'], string>> = {
  stripe: 'Stripe',
  square: 'Square',
  fake: 'Fake (test)',
};

/**
 * Every connection the org holds, active and inactive alike (`connections.ts`'s "not a
 * paged collection" — see `queries.ts`). Never a secret in sight: `ProcessorConnection`
 * has no `secretKey`/`webhookSecret` field to render even by accident (D-83).
 *
 * `clearingAccountId`/`feeAccountId` are read against `reference.accountsById` rather
 * than shown as bare uuids — `recurring-invoices/list.tsx`'s same reasoning for
 * `contactsById`, applied to the two accounts this row names.
 */
export interface ConnectionListProps {
  readonly connections: readonly ProcessorConnection[];
  readonly reference: ProcessingReferenceData;
  readonly loading: boolean;
  readonly togglePendingId: string | null;
  readonly onToggleActive: (connection: ProcessorConnection) => void;
}

function accountLabel(reference: ProcessingReferenceData, accountId: string): string {
  const account = reference.accountsById.get(accountId);
  return account === undefined ? 'Unknown account' : `${account.code} — ${account.name}`;
}

export function ConnectionList({
  connections,
  reference,
  loading,
  togglePendingId,
  onToggleActive,
}: ConnectionListProps): ReactElement {
  return (
    <ResponsiveTable>
      <table className={TABLE_CLASSES}>
        <caption className="sr-only">Payment-processor connections</caption>
        <thead>
          <tr>
            <th scope="col" className={TH_CLASSES}>
              Processor
            </th>
            <th scope="col" className={TH_CLASSES}>
              Clearing account
            </th>
            <th scope="col" className={TH_CLASSES}>
              Fee account
            </th>
            <th scope="col" className={TH_CLASSES}>
              Last polled
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
          {connections.length === 0 && (
            <EmptyRow columns={6}>
              {loading ? 'Loading…' : 'No payment processors connected yet.'}
            </EmptyRow>
          )}
          {connections.map((connection) => (
            <tr key={connection.id}>
              <td className={TD_CLASSES}>
                {PROCESSOR_LABEL[connection.processor]}
                {connection.externalAccountId !== null && (
                  <span className="block text-xs text-text-subtle">
                    {connection.externalAccountId}
                  </span>
                )}
              </td>
              <td className={TD_CLASSES}>
                {accountLabel(reference, connection.clearingAccountId)}
              </td>
              <td className={TD_CLASSES}>{accountLabel(reference, connection.feeAccountId)}</td>
              <td className={cx(TD_CLASSES, 'text-text-muted')}>
                {connection.lastPolledAt === null
                  ? 'Never'
                  : formatTimestamp(connection.lastPolledAt)}
              </td>
              <td className={TD_CLASSES}>
                <Pill tone={connection.isActive ? 'positive' : 'muted'}>
                  {connection.isActive ? 'Active' : 'Inactive'}
                </Pill>
              </td>
              <td className={cx(TD_CLASSES, 'text-right')}>
                <Button
                  size="sm"
                  disabled={togglePendingId === connection.id}
                  aria-label={`${connection.isActive ? 'Deactivate' : 'Reactivate'} ${PROCESSOR_LABEL[connection.processor]}`}
                  onClick={() => {
                    onToggleActive(connection);
                  }}
                >
                  {connection.isActive ? 'Deactivate' : 'Reactivate'}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ResponsiveTable>
  );
}
