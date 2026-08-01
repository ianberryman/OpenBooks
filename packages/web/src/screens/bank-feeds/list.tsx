import type { ReactElement } from 'react';

import { Button, Pill, ResponsiveTable } from '../../components';
import { cx } from '../../lib/cx';
import { EmptyRow, TABLE_CLASSES, TD_CLASSES, TH_CLASSES } from '../settings/section';
import { formatTimestamp } from '../settings/support';
import type { BankAccount, BankFeedConnection } from './queries';

const FEED_SOURCE_LABEL: Readonly<Record<BankFeedConnection['feedSource'], string>> = {
  stripe_financial_connections: 'Stripe Financial Connections',
  fake: 'Fake (test)',
};

/**
 * Every live-feed connection the org holds, active and inactive alike (the list serves both,
 * because a disconnected feed is exactly what a reader comes here to confirm was
 * disconnected). Never a secret in sight: `BankFeedConnection` has no `restrictedKey` field
 * to render even by accident (D-83).
 *
 * `bankAccountId` is read against `bankAccountsById` rather than shown as a bare uuid —
 * `processing/list.tsx`'s same reasoning for the accounts it names.
 */
export interface BankFeedListProps {
  readonly connections: readonly BankFeedConnection[];
  readonly bankAccountsById: ReadonlyMap<string, BankAccount>;
  readonly loading: boolean;
  readonly canSync: boolean;
  readonly canDisconnect: boolean;
  readonly syncPendingId: string | null;
  readonly disconnectPendingId: string | null;
  readonly onSync: (connection: BankFeedConnection) => void;
  readonly onDisconnect: (connection: BankFeedConnection) => void;
}

function bankAccountLabel(
  bankAccountsById: ReadonlyMap<string, BankAccount>,
  bankAccountId: string,
): string {
  const account = bankAccountsById.get(bankAccountId);
  return account === undefined ? 'Unknown bank account' : account.name;
}

export function BankFeedList({
  connections,
  bankAccountsById,
  loading,
  canSync,
  canDisconnect,
  syncPendingId,
  disconnectPendingId,
  onSync,
  onDisconnect,
}: BankFeedListProps): ReactElement {
  const showActions = canSync || canDisconnect;

  return (
    <ResponsiveTable className="rounded-lg border border-border bg-surface">
      <table className={TABLE_CLASSES}>
        <caption className="sr-only">Live bank-feed connections</caption>
        <thead>
          <tr>
            <th scope="col" className={TH_CLASSES}>
              Bank account
            </th>
            <th scope="col" className={TH_CLASSES}>
              Feed source
            </th>
            <th scope="col" className={TH_CLASSES}>
              Institution
            </th>
            <th scope="col" className={TH_CLASSES}>
              Last synced
            </th>
            <th scope="col" className={TH_CLASSES}>
              Status
            </th>
            {showActions && (
              <th scope="col" className={cx(TH_CLASSES, 'text-right')}>
                <span className="sr-only">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {connections.length === 0 && (
            <EmptyRow columns={showActions ? 6 : 5}>
              {loading ? 'Loading…' : 'No bank feeds connected yet.'}
            </EmptyRow>
          )}
          {connections.map((connection) => {
            const label = FEED_SOURCE_LABEL[connection.feedSource];
            return (
              <tr key={connection.id}>
                <td className={TD_CLASSES}>
                  {bankAccountLabel(bankAccountsById, connection.bankAccountId)}
                  <span className="block font-mono text-xs text-text-subtle">
                    {connection.externalAccountId}
                  </span>
                </td>
                <td className={TD_CLASSES}>{label}</td>
                <td className={cx(TD_CLASSES, 'text-text-muted')}>
                  {connection.institution ?? '—'}
                </td>
                <td className={cx(TD_CLASSES, 'text-text-muted')}>
                  {connection.lastSyncedAt === null
                    ? 'Never'
                    : formatTimestamp(connection.lastSyncedAt)}
                </td>
                <td className={TD_CLASSES}>
                  <Pill tone={connection.isActive ? 'positive' : 'muted'}>
                    {connection.isActive ? 'Active' : 'Disconnected'}
                  </Pill>
                  {connection.lastSyncError !== null && (
                    <span className="mt-1 block text-xs text-warning-text">
                      Last sync failed: {connection.lastSyncError}
                    </span>
                  )}
                </td>
                {showActions && (
                  <td className={cx(TD_CLASSES, 'whitespace-nowrap text-right')}>
                    <div className="flex justify-end gap-2">
                      {canSync && connection.isActive && (
                        <Button
                          size="sm"
                          disabled={syncPendingId === connection.id}
                          aria-label={`Sync ${label} now`}
                          onClick={() => {
                            onSync(connection);
                          }}
                        >
                          {syncPendingId === connection.id ? 'Syncing…' : 'Sync now'}
                        </Button>
                      )}
                      {canDisconnect && connection.isActive && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={disconnectPendingId === connection.id}
                          aria-label={`Disconnect ${label}`}
                          onClick={() => {
                            onDisconnect(connection);
                          }}
                        >
                          Disconnect
                        </Button>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </ResponsiveTable>
  );
}
