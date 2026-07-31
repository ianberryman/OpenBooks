import type { ReactElement } from 'react';

import { Button, Pill, ResponsiveTable } from '../../components';
import { cx } from '../../lib/cx';
import { EmptyRow, TABLE_CLASSES, TD_CLASSES, TH_CLASSES } from '../settings/section';
import type { ApiKey, AssignableRole } from './queries';

/**
 * One page of the org's API keys, revoked ones included (`ApiKeyPage`'s own words) — a
 * management view, not a live-credential list. Never the secret itself: `ApiKey` has no
 * `key` field at all, only `keyPrefix` — the full opaque value exists on the wire exactly
 * once, at creation, and this table is not that moment.
 */
export interface ApiKeyListProps {
  readonly keys: readonly ApiKey[];
  readonly rolesById: ReadonlyMap<string, AssignableRole>;
  readonly loading: boolean;
  readonly revokingId: string | null;
  readonly onRevoke: (key: ApiKey) => void;
}

export function ApiKeyList({
  keys,
  rolesById,
  loading,
  revokingId,
  onRevoke,
}: ApiKeyListProps): ReactElement {
  return (
    <ResponsiveTable>
      <table className={TABLE_CLASSES}>
        <caption className="sr-only">API keys</caption>
        <thead>
          <tr>
            <th scope="col" className={TH_CLASSES}>
              Name
            </th>
            <th scope="col" className={TH_CLASSES}>
              Key
            </th>
            <th scope="col" className={TH_CLASSES}>
              Role
            </th>
            <th scope="col" className={TH_CLASSES}>
              Last used
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
          {keys.length === 0 && (
            <EmptyRow columns={6}>{loading ? 'Loading…' : 'No API keys yet.'}</EmptyRow>
          )}
          {keys.map((key) => (
            <tr key={key.id}>
              <td className={TD_CLASSES}>{key.name}</td>
              <td className={cx(TD_CLASSES, 'font-mono text-xs text-text-muted')}>
                {key.keyPrefix}…
              </td>
              <td className={TD_CLASSES}>{rolesById.get(key.roleId)?.name ?? 'Unknown role'}</td>
              <td className={cx(TD_CLASSES, 'text-text-muted')}>{key.lastUsedAt ?? 'Never'}</td>
              <td className={TD_CLASSES}>
                <Pill tone={key.revokedAt === null ? 'positive' : 'muted'}>
                  {key.revokedAt === null ? 'Active' : 'Revoked'}
                </Pill>
              </td>
              <td className={cx(TD_CLASSES, 'text-right')}>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={key.revokedAt !== null || revokingId === key.id}
                  aria-label={`Revoke ${key.name}`}
                  onClick={() => {
                    onRevoke(key);
                  }}
                >
                  Revoke
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ResponsiveTable>
  );
}
