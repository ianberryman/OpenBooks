import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';

import { Button, ErrorBanner } from '../components';
import { ConnectedAppList } from './connected-apps/list';
import { useConnectedAppList, useIntentKey, useRevokeConnectedApp } from './connected-apps/queries';
import type { ConnectedApp } from './connected-apps/queries';

/**
 * Connected apps (OB-105; OB-098 — ROADMAP D-54, D-61).
 *
 * The user's own view of what they have personally granted, never every client the org
 * has registered (`oauth-clients.tsx` is that, developer-facing, screen). This screen
 * touches only the caller's own consent and tokens — `connected-apps/queries.ts`'s note on
 * `ConnectedApp` — so it shows the same collection regardless of which permissions the
 * caller otherwise holds.
 */
export function ConnectedAppsScreen(): ReactElement {
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const list = useConnectedAppList();
  const revoke = useRevokeConnectedApp();
  const intentKey = useIntentKey();

  const apps = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);

  function handleRevoke(app: ConnectedApp): void {
    setRevokingId(app.clientId);
    revoke.mutate(
      { clientId: app.clientId, idempotencyKey: intentKey(`revoke:${app.clientId}`) },
      { onSettled: () => setRevokingId(null) },
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-text">Connected apps</h1>
        <p className="max-w-form text-text-muted">
          Third-party applications you have personally authorized, and what each one may do — never
          more than the permissions you granted at consent time.
        </p>
      </div>

      {list.error != null && (
        <ErrorBanner
          error={list.error}
          onRetry={() => {
            void list.refetch();
          }}
        />
      )}
      {revoke.isError && <ErrorBanner error={revoke.error} />}

      <ConnectedAppList
        apps={apps}
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
    </div>
  );
}
