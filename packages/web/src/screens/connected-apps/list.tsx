import type { ReactElement } from 'react';

import { Button } from '../../components';
import { cx } from '../../lib/cx';
import { EmptyRow, TABLE_CLASSES, TD_CLASSES, TH_CLASSES } from '../settings/section';
import type { ConnectedApp } from './queries';

/**
 * One page of the apps the caller has personally authorized. No status pill: unlike
 * `api-keys/list.tsx` and `oauth-clients/list.tsx`, a revoked consent is not a state this
 * list ever shows — `revokeConnectedApp` invalidates this same query on success, so a
 * revoked row simply stops appearing rather than being relabelled.
 */
export interface ConnectedAppListProps {
  readonly apps: readonly ConnectedApp[];
  readonly loading: boolean;
  readonly revokingId: string | null;
  readonly onRevoke: (app: ConnectedApp) => void;
}

export function ConnectedAppList({
  apps,
  loading,
  revokingId,
  onRevoke,
}: ConnectedAppListProps): ReactElement {
  return (
    <table className={TABLE_CLASSES}>
      <caption className="sr-only">Connected apps</caption>
      <thead>
        <tr>
          <th scope="col" className={TH_CLASSES}>
            App
          </th>
          <th scope="col" className={TH_CLASSES}>
            Access granted
          </th>
          <th scope="col" className={TH_CLASSES}>
            Last used
          </th>
          <th scope="col" className={TH_CLASSES}>
            Authorized
          </th>
          <th scope="col" className={cx(TH_CLASSES, 'text-right')}>
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {apps.length === 0 && (
          <EmptyRow columns={5}>
            {loading ? 'Loading…' : 'No apps have been authorized to act on your behalf.'}
          </EmptyRow>
        )}
        {apps.map((app) => (
          <tr key={app.clientId}>
            <td className={TD_CLASSES}>{app.name}</td>
            <td className={TD_CLASSES}>
              <ul className="flex flex-col gap-0.5">
                {app.scope.map((permission) => (
                  <li key={permission} className="font-mono text-xs text-text-muted">
                    {permission}
                  </li>
                ))}
              </ul>
            </td>
            <td className={cx(TD_CLASSES, 'text-text-muted')}>{app.lastUsedAt ?? 'Never'}</td>
            <td className={cx(TD_CLASSES, 'text-text-muted')}>{app.consentedAt}</td>
            <td className={cx(TD_CLASSES, 'text-right')}>
              <Button
                size="sm"
                variant="danger"
                disabled={revokingId === app.clientId}
                aria-label={`Revoke access for ${app.name}`}
                onClick={() => {
                  onRevoke(app);
                }}
              >
                Revoke
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
