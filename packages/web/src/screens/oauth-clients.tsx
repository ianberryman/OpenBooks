import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';

import { Button, ErrorBanner } from '../components';
import { OAuthClientList } from './oauth-clients/list';
import { RegisterOAuthClientDialog } from './oauth-clients/register-dialog';
import {
  useDeactivateOAuthClient,
  useIntentKey,
  useOAuthClientList,
} from './oauth-clients/queries';
import type { OAuthClient } from './oauth-clients/queries';

/**
 * OAuth clients (OB-105; OB-053, OB-098 — ROADMAP D-53, D-54, D-61).
 *
 * The developer-facing half of the authorization-server pair `connected-apps.tsx`
 * completes: this screen registers *who may ask* for access — third-party clients, admin-
 * registered and never self-service — and `connected-apps.tsx` shows what a signed-in user
 * has themselves *granted* to one. Deactivating a client here revokes nothing already
 * consented to; it only refuses that client a new token from here on.
 */
export function OAuthClientsScreen(): ReactElement {
  const [registerOpen, setRegisterOpen] = useState(false);
  const [deactivatingId, setDeactivatingId] = useState<string | null>(null);

  const list = useOAuthClientList();
  const deactivate = useDeactivateOAuthClient();
  const intentKey = useIntentKey();

  const clients = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);

  function handleDeactivate(client: OAuthClient): void {
    setDeactivatingId(client.id);
    deactivate.mutate(
      { oauthClientId: client.id, idempotencyKey: intentKey(`deactivate:${client.id}`) },
      { onSettled: () => setDeactivatingId(null) },
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-text">OAuth clients</h1>
          <p className="max-w-form text-text-muted">
            Third-party applications registered to request access on a user's behalf, and the
            redirect URIs each one may be sent back to.
          </p>
        </div>
        <Button
          variant="primary"
          onClick={() => {
            setRegisterOpen(true);
          }}
        >
          Register a client
        </Button>
      </div>

      {list.error != null && (
        <ErrorBanner
          error={list.error}
          onRetry={() => {
            void list.refetch();
          }}
        />
      )}
      {deactivate.isError && <ErrorBanner error={deactivate.error} />}

      <OAuthClientList
        clients={clients}
        loading={list.isPending}
        deactivatingId={deactivatingId}
        onDeactivate={handleDeactivate}
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

      <RegisterOAuthClientDialog open={registerOpen} onOpenChange={setRegisterOpen} />
    </div>
  );
}
