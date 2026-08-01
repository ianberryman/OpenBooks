import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';

import { permissionSet, useIdentity } from '../../auth/identity';
import { Button, Dialog, DialogClose, DialogContent, ErrorBanner } from '../../components';
import { ConnectBankFeedDialog } from './connect-dialog';
import { BankFeedList } from './list';
import type { BankFeedConnection } from './queries';
import {
  useBankAccountOptions,
  useBankFeedList,
  useDeactivateBankFeed,
  useIntentKey,
  useSyncBankFeed,
} from './queries';

/**
 * Live bank feeds (OB-227; ROADMAP D-126…D-131).
 *
 * `processing.tsx`'s shape, mirrored for the banking equivalent: a list of connections, a
 * connect dialog, and per-row lifecycle actions, gated by the permissions
 * `connections.service.ts` enforces — `banking.read` to view, `banking.connect` to connect
 * or disconnect, `banking.import` to trigger a manual sync. The gating here is advisory
 * (D-25): it only hides actions that would always refuse; the service is the gate, and this
 * screen stays reachable by URL and surfaces whatever the service says.
 *
 * ## No secret is ever read back
 *
 * `BankFeedConnection` — everything a read returns — carries no `restrictedKey` (D-83). The
 * connect dialog's key input is write-only: sent once, cleared on submit, never re-displayed.
 * There is no "reveal" control because there is nothing behind one to reveal.
 *
 * ## Disconnect is one-way, so it is confirmed
 *
 * Unlike a processor connection's reversible deactivate/reactivate, a feed has no reactivate
 * route — reconnecting is a fresh connect (`queries.ts`), and disconnecting reverts the bank
 * account to `file` import. So it is a confirmed action rather than a plain toggle.
 */
export function BankFeedsScreen(): ReactElement {
  const identity = useIdentity();
  const permissions = permissionSet(identity.data ?? null);
  const canRead = permissions.has('banking.read');
  const canConnect = permissions.has('banking.connect');
  const canSync = permissions.has('banking.import');

  const [connecting, setConnecting] = useState(false);
  const [confirming, setConfirming] = useState<BankFeedConnection | null>(null);
  const [syncPendingId, setSyncPendingId] = useState<string | null>(null);

  const bankAccounts = useBankAccountOptions();
  const list = useBankFeedList(null);
  const sync = useSyncBankFeed();
  const deactivate = useDeactivateBankFeed();
  const intentKey = useIntentKey();

  const connections = useMemo(
    () => list.data?.pages.flatMap((page) => page.items) ?? [],
    [list.data],
  );
  const bankAccountsById = useMemo(
    () => new Map((bankAccounts.data ?? []).map((account) => [account.id, account])),
    [bankAccounts.data],
  );

  function onSync(connection: BankFeedConnection): void {
    setSyncPendingId(connection.id);
    sync.reset();
    sync.mutate(
      { bankFeedId: connection.id, idempotencyKey: intentKey(`sync:${connection.id}`) },
      { onSettled: () => setSyncPendingId(null) },
    );
  }

  function onConfirmDisconnect(): void {
    if (confirming === null) return;
    const connection = confirming;
    deactivate.reset();
    deactivate.mutate(
      { bankFeedId: connection.id, idempotencyKey: intentKey(`disconnect:${connection.id}`) },
      { onSuccess: () => setConfirming(null) },
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-text">Bank feeds</h1>
          <p className="max-w-form text-text-muted">
            Connect this organization&rsquo;s own Stripe Financial Connections credential to a bank
            account and a daily job imports its transactions. The restricted key is stored securely
            through the secrets provider and cannot be viewed again on this screen, or any other,
            once saved.
          </p>
        </div>
        {canConnect && (
          <Button
            variant="primary"
            disabled={bankAccounts.data === undefined}
            onClick={() => {
              setConnecting(true);
            }}
          >
            Connect a bank feed
          </Button>
        )}
      </div>

      {!canRead ? (
        <div className="flex flex-col items-start gap-2 rounded-lg border border-border bg-surface p-6">
          <p className="text-base font-medium text-text">You cannot view bank feeds.</p>
          <p className="text-sm text-text-muted">
            Viewing live feeds needs the <code>banking.read</code> permission. Ask an administrator
            of this organization to grant it.
          </p>
        </div>
      ) : (
        <>
          {bankAccounts.error != null && (
            <ErrorBanner
              error={bankAccounts.error}
              onRetry={() => {
                void bankAccounts.refetch();
              }}
            />
          )}

          {list.isError && (
            <ErrorBanner
              error={list.error}
              onRetry={() => {
                void list.refetch();
              }}
            />
          )}

          {sync.isError && <ErrorBanner error={sync.error} />}
          {deactivate.isError && <ErrorBanner error={deactivate.error} />}

          <BankFeedList
            connections={connections}
            bankAccountsById={bankAccountsById}
            loading={list.isPending}
            canSync={canSync}
            canDisconnect={canConnect}
            syncPendingId={syncPendingId}
            disconnectPendingId={deactivate.isPending ? deactivate.variables.bankFeedId : null}
            onSync={onSync}
            onDisconnect={setConfirming}
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
        </>
      )}

      <ConnectBankFeedDialog
        open={connecting}
        bankAccounts={bankAccounts.data ?? []}
        onOpenChange={setConnecting}
      />

      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        {confirming !== null && (
          <DialogContent
            title="Disconnect this bank feed?"
            description="The daily sync stops pulling and the bank account reverts to file import. Every transaction already imported stays exactly as it is. There is no reactivate — reconnecting is a fresh connection."
            footer={
              <>
                <DialogClose asChild>
                  <Button disabled={deactivate.isPending}>Cancel</Button>
                </DialogClose>
                <Button
                  variant="primary"
                  disabled={deactivate.isPending}
                  onClick={onConfirmDisconnect}
                >
                  {deactivate.isPending ? 'Disconnecting…' : 'Disconnect feed'}
                </Button>
              </>
            }
          >
            <p className="text-sm text-text-muted">
              This affects only the live feed. Nothing already recorded changes.
            </p>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
