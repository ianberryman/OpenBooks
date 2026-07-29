import type { ReactElement } from 'react';
import { useState } from 'react';

import { Button, ErrorBanner } from '../components';
import { ConnectProcessorDialog } from './processing/connect-dialog';
import { ConnectionList } from './processing/list';
import type { ProcessorConnection } from './processing/queries';
import {
  useConnectionList,
  useIntentKey,
  useProcessingReferenceData,
  useSetConnectionActive,
} from './processing/queries';

/**
 * Connect-a-processor settings (OB-151; wraps OB-147/OB-150's `/v1/processing/connections`
 * and the pay-link route the hosted invoice page opens — ROADMAP D-82…D-86, D-101…D-104).
 *
 * `recurring-invoices.tsx`'s shape, mirrored: a settings-style list plus a create dialog
 * plus a deactivate/reactivate action, gated by a permission (`processing.read` to view,
 * `processing.write` to mutate — enforced by `connections.service.ts`, surfaced here rather
 * than re-checked, per D-25 in `shell/nav.ts`).
 *
 * ## No secret is ever read back, and this screen has no code path that could show one
 *
 * `ProcessorConnection` — everything `GET`/`POST` on this surface returns — carries no
 * `secretKey` and no `webhookSecret` field (D-83). The connect dialog's two secret inputs
 * are write-only: sent once, cleared on submit, never re-displayed. There is no "reveal"
 * control anywhere on this screen because there is nothing behind one to reveal — the
 * server itself keeps only the *names* it stored the values under, never the values.
 *
 * ## Deactivate/reactivate, not a one-way retirement
 *
 * Unlike `recurring-invoices.tsx`'s "retire" (a one-way door, confirmed in its own
 * dialog), a processor connection strands nothing when taken out of circulation
 * (`connections.service.ts`'s own comment) — the webhook and the poll simply stop writing
 * new payments through it, and every payment already recorded stays exactly as posted.
 * So this is the reversible toggle `bank-accounts.tsx` gives its own two routes, not a
 * confirmed dialog: a plain row action, mirrored the same way.
 */
export function ProcessingScreen(): ReactElement {
  const [connecting, setConnecting] = useState(false);
  const [togglePendingId, setTogglePendingId] = useState<string | null>(null);

  const reference = useProcessingReferenceData();
  const list = useConnectionList();
  const setActive = useSetConnectionActive();
  const intentKey = useIntentKey();

  function toggleActive(connection: ProcessorConnection): void {
    const active = !connection.isActive;
    setTogglePendingId(connection.id);
    setActive.mutate(
      {
        connectionId: connection.id,
        active,
        idempotencyKey: intentKey(`${active ? 'reactivate' : 'deactivate'}:${connection.id}`),
      },
      { onSettled: () => setTogglePendingId(null) },
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-text">Payment processing</h1>
          <p className="max-w-form text-text-muted">
            Connect this organization&rsquo;s own Stripe or Square account so customers can pay a
            hosted invoice directly. Keys are stored securely through the secrets provider and
            cannot be viewed again on this screen, or any other, once saved.
          </p>
        </div>
        <Button
          variant="primary"
          disabled={reference.data === null}
          onClick={() => {
            setConnecting(true);
          }}
        >
          Connect a processor
        </Button>
      </div>

      {reference.error != null && (
        <ErrorBanner error={reference.error} onRetry={reference.refetch} />
      )}

      {list.error != null && <ErrorBanner error={list.error} onRetry={list.refetch} />}

      {setActive.isError && <ErrorBanner error={setActive.error} />}

      {reference.data === null ? (
        <p className="text-text-subtle">Loading the chart of accounts…</p>
      ) : (
        <ConnectionList
          connections={list.connections}
          reference={reference.data}
          loading={list.isPending}
          togglePendingId={togglePendingId}
          onToggleActive={toggleActive}
        />
      )}

      {reference.data !== null && (
        <ConnectProcessorDialog
          open={connecting}
          reference={reference.data}
          onOpenChange={setConnecting}
        />
      )}
    </div>
  );
}
