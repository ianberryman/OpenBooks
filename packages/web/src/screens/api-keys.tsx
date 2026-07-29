import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';

import { Button, ErrorBanner } from '../components';
import { CreateApiKeyDialog } from './api-keys/create-dialog';
import { ApiKeyList } from './api-keys/list';
import {
  useApiKeyList,
  useAssignableRoles,
  useIntentKey,
  useRevokeApiKey,
} from './api-keys/queries';
import type { ApiKey } from './api-keys/queries';

/**
 * API keys (OB-105; OB-055, OB-061 — ROADMAP D-55, D-61).
 *
 * First-party, role-bound credentials — "no person behind it" (`CreateApiKeyRequest`'s own
 * words). A key authenticates as `roleId`, never as the issuer, so narrowing the role
 * narrows every key issued against it, the same guarantee D-54 gives an OAuth token.
 *
 * The full opaque value exists on the wire exactly once, in the create response
 * (`ApiKeyWithSecret`) — see `api-keys/create-dialog.tsx`. Every later read, including
 * this list, carries only `keyPrefix`: enough for an operator to tell keys apart, never
 * enough to reconstruct the secret.
 */
export function ApiKeysScreen(): ReactElement {
  const [createOpen, setCreateOpen] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const roles = useAssignableRoles();
  const list = useApiKeyList();
  const revoke = useRevokeApiKey();
  const intentKey = useIntentKey();

  const keys = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);
  const rolesById = useMemo(
    () => new Map(roles.roles.map((role) => [role.id, role])),
    [roles.roles],
  );

  function handleRevoke(key: ApiKey): void {
    setRevokingId(key.id);
    revoke.mutate(
      { apiKeyId: key.id, idempotencyKey: intentKey(`revoke:${key.id}`) },
      { onSettled: () => setRevokingId(null) },
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-text">API keys</h1>
          <p className="max-w-form text-text-muted">
            Role-bound credentials for scripts and integrations — each one authenticates as the role
            it was issued with, never as whoever issued it.
          </p>
        </div>
        <Button
          variant="primary"
          disabled={roles.roles.length === 0}
          onClick={() => {
            setCreateOpen(true);
          }}
        >
          Issue a key
        </Button>
      </div>

      {roles.error != null && <ErrorBanner error={roles.error} />}
      {list.error != null && (
        <ErrorBanner
          error={list.error}
          onRetry={() => {
            void list.refetch();
          }}
        />
      )}
      {revoke.isError && <ErrorBanner error={revoke.error} />}

      <ApiKeyList
        keys={keys}
        rolesById={rolesById}
        loading={list.isPending}
        revokingId={revokingId}
        onRevoke={handleRevoke}
      />

      {list.hasNextPage && (
        <div>
          <Button
            disabled={list.isFetchingNextPage}
            onClick={() => {
              void list.fetchNextPage();
            }}
          >
            {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}

      <CreateApiKeyDialog open={createOpen} roles={roles.roles} onOpenChange={setCreateOpen} />
    </div>
  );
}
