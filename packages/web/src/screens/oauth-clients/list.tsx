import type { ReactElement } from 'react';

import { Button, ResponsiveTable } from '../../components';
import { cx } from '../../lib/cx';
import { EmptyRow, Pill, TABLE_CLASSES, TD_CLASSES, TH_CLASSES } from '../settings/section';
import type { OAuthClient } from './queries';

/**
 * One page of the org's registered third-party clients, deactivated ones included — the
 * same "management view, not a live list" reasoning `api-keys/list.tsx` gives.
 */
export interface OAuthClientListProps {
  readonly clients: readonly OAuthClient[];
  readonly loading: boolean;
  readonly deactivatingId: string | null;
  readonly onDeactivate: (client: OAuthClient) => void;
}

export function OAuthClientList({
  clients,
  loading,
  deactivatingId,
  onDeactivate,
}: OAuthClientListProps): ReactElement {
  return (
    <ResponsiveTable>
      <table className={TABLE_CLASSES}>
        <caption className="sr-only">OAuth clients</caption>
        <thead>
          <tr>
            <th scope="col" className={TH_CLASSES}>
              Name
            </th>
            <th scope="col" className={TH_CLASSES}>
              Client ID
            </th>
            <th scope="col" className={TH_CLASSES}>
              Redirect URIs
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
          {clients.length === 0 && (
            <EmptyRow columns={5}>{loading ? 'Loading…' : 'No OAuth clients registered.'}</EmptyRow>
          )}
          {clients.map((client) => (
            <tr key={client.id}>
              <td className={TD_CLASSES}>{client.name}</td>
              <td className={cx(TD_CLASSES, 'font-mono text-xs text-text-muted')}>
                {client.clientId}
              </td>
              <td className={TD_CLASSES}>
                <ul className="flex flex-col gap-0.5">
                  {client.redirectUris.map((uri) => (
                    <li key={uri} className="font-mono text-xs break-all text-text-muted">
                      {uri}
                    </li>
                  ))}
                </ul>
              </td>
              <td className={TD_CLASSES}>
                <Pill tone={client.deactivatedAt === null ? 'positive' : 'muted'}>
                  {client.deactivatedAt === null ? 'Active' : 'Deactivated'}
                </Pill>
              </td>
              <td className={cx(TD_CLASSES, 'text-right')}>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={client.deactivatedAt !== null || deactivatingId === client.id}
                  aria-label={`Deactivate ${client.name}`}
                  onClick={() => {
                    onDeactivate(client);
                  }}
                >
                  Deactivate
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ResponsiveTable>
  );
}
