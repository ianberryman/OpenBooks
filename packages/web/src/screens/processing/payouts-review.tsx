import type { ReactElement } from 'react';

import { newIdempotencyKey } from '../../api';
import { Button, ErrorBanner, Pill, ResponsiveTable, formatMoney } from '../../components';
import type { PillTone } from '../../components';
import { useIsCompact } from '../../lib/use-viewport';
import { EmptyRow, TABLE_CLASSES, TD_CLASSES, TH_CLASSES } from '../settings/section';
import { formatTimestamp } from '../settings/support';
import type { PayoutSync } from './payout-sync-queries';
import { usePayoutSyncs, usePostPayoutSync, useSkipPayoutSync } from './payout-sync-queries';

/**
 * The "Stripe payouts to review" queue (OB-237, D-237-2) — every payout sync a connection
 * has staged, newest first, with Post/Skip for the ones still `pending_review`.
 *
 * `purchase-orders/list.tsx`'s isCompact split, mirrored: a `ResponsiveTable` above `md`,
 * JS-gated cards below it — never a CSS `md:hidden` pair (Initiative R's rule; both markups
 * would otherwise ship to every client and only one would ever render).
 *
 * ## Why Post/Skip disable off mutation *variables*, not a separately-tracked row id
 *
 * `usePostPayoutSync`/`useSkipPayoutSync` are one mutation each, shared by every row — a
 * connection with several `pending_review` payouts posts them one at a time from this same
 * screen. Reading `post.variables?.payoutSyncId === payoutSync.id` off the mutation itself
 * is enough to disable the one row actually in flight without a second piece of state that
 * could drift from it.
 */

const STATUS_LABEL: Readonly<Record<PayoutSync['status'], string>> = {
  pending_review: 'Pending review',
  posted: 'Posted',
  skipped: 'Skipped',
};

const STATUS_TONE: Readonly<Record<PayoutSync['status'], PillTone>> = {
  pending_review: 'accent',
  posted: 'positive',
  skipped: 'muted',
};

export interface PayoutsReviewProps {
  readonly connectionId: string;
}

export function PayoutsReview({ connectionId }: PayoutsReviewProps): ReactElement {
  const list = usePayoutSyncs(connectionId);
  const post = usePostPayoutSync(connectionId);
  const skip = useSkipPayoutSync(connectionId);
  const isCompact = useIsCompact();

  function onPost(payoutSyncId: string): void {
    post.mutate({ payoutSyncId, idempotencyKey: newIdempotencyKey() });
  }

  function onSkip(payoutSyncId: string): void {
    skip.mutate({ payoutSyncId, idempotencyKey: newIdempotencyKey() });
  }

  const posting = (payoutSyncId: string): boolean =>
    post.isPending && post.variables?.payoutSyncId === payoutSyncId;
  const skipping = (payoutSyncId: string): boolean =>
    skip.isPending && skip.variables?.payoutSyncId === payoutSyncId;

  if (list.syncs.length === 0 && !list.isPending) {
    return (
      <div className="flex flex-col gap-3">
        {list.error != null && <ErrorBanner error={list.error} onRetry={list.refetch} />}
        <p className="text-text-muted">No payouts to review yet.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {list.error != null && <ErrorBanner error={list.error} onRetry={list.refetch} />}
      {post.isError && <ErrorBanner error={post.error} />}
      {skip.isError && <ErrorBanner error={skip.error} />}

      {isCompact ? (
        <ul className="flex flex-col gap-3" aria-label="Payout syncs">
          {list.syncs.map((sync) => (
            <PayoutCard
              key={sync.id}
              sync={sync}
              posting={posting(sync.id)}
              skipping={skipping(sync.id)}
              onPost={onPost}
              onSkip={onSkip}
            />
          ))}
        </ul>
      ) : (
        <ResponsiveTable>
          <table className={TABLE_CLASSES}>
            <caption className="sr-only">Payout syncs</caption>
            <thead>
              <tr>
                <th scope="col" className={TH_CLASSES}>
                  Occurred
                </th>
                <th scope="col" className={TH_CLASSES}>
                  Gross
                </th>
                <th scope="col" className={TH_CLASSES}>
                  Fee
                </th>
                <th scope="col" className={TH_CLASSES}>
                  Net
                </th>
                <th scope="col" className={TH_CLASSES}>
                  Status
                </th>
                <th scope="col" className="sr-only">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {list.isPending && <EmptyRow columns={6}>Loading…</EmptyRow>}
              {list.syncs.map((sync) => (
                <tr key={sync.id}>
                  <td className={TD_CLASSES}>{formatTimestamp(sync.occurredAt)}</td>
                  <td className={`${TD_CLASSES} font-mono tabular-nums`}>
                    {formatMoney(sync.grossMinor)}
                  </td>
                  <td className={`${TD_CLASSES} font-mono tabular-nums`}>
                    {formatMoney(sync.feeMinor)}
                  </td>
                  <td className={`${TD_CLASSES} font-mono tabular-nums`}>
                    {formatMoney(sync.netMinor)}
                  </td>
                  <td className={TD_CLASSES}>
                    <Pill tone={STATUS_TONE[sync.status]}>{STATUS_LABEL[sync.status]}</Pill>
                  </td>
                  <td className={`${TD_CLASSES} text-right`}>
                    <PayoutRowActions
                      sync={sync}
                      posting={posting(sync.id)}
                      skipping={skipping(sync.id)}
                      onPost={onPost}
                      onSkip={onSkip}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ResponsiveTable>
      )}
    </div>
  );
}

/**
 * A `pending_review` row offers Post/Skip; a `posted` row names the journal it produced; a
 * `skipped` row shows the reason (or the fact that none was given) rather than leaving the cell
 * blank — including a manual payout, which is skipped because no per-payout breakdown exists in
 * any Stripe API (OB-237b correction).
 */
function PayoutRowActions({
  sync,
  posting,
  skipping,
  onPost,
  onSkip,
}: {
  readonly sync: PayoutSync;
  readonly posting: boolean;
  readonly skipping: boolean;
  readonly onPost: (payoutSyncId: string) => void;
  readonly onSkip: (payoutSyncId: string) => void;
}): ReactElement {
  if (sync.status === 'pending_review') {
    return (
      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={posting || skipping}
          onClick={() => {
            onPost(sync.id);
          }}
        >
          {posting ? 'Posting…' : 'Post'}
        </Button>
        <Button
          size="sm"
          disabled={posting || skipping}
          onClick={() => {
            onSkip(sync.id);
          }}
        >
          {skipping ? 'Skipping…' : 'Skip'}
        </Button>
      </div>
    );
  }

  if (sync.status === 'posted') {
    return <span className="text-xs text-text-subtle">Journal posted</span>;
  }

  return (
    <span className="text-xs text-text-subtle">
      {sync.skipReason === null || sync.skipReason === '' ? 'No reason given' : sync.skipReason}
    </span>
  );
}

function PayoutCard({
  sync,
  posting,
  skipping,
  onPost,
  onSkip,
}: {
  readonly sync: PayoutSync;
  readonly posting: boolean;
  readonly skipping: boolean;
  readonly onPost: (payoutSyncId: string) => void;
  readonly onSkip: (payoutSyncId: string) => void;
}): ReactElement {
  return (
    <li className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm text-text-subtle">{formatTimestamp(sync.occurredAt)}</p>
          <p className="mt-0.5 font-mono text-lg font-semibold tabular-nums text-text">
            {formatMoney(sync.netMinor)}
          </p>
        </div>
        <Pill tone={STATUS_TONE[sync.status]}>{STATUS_LABEL[sync.status]}</Pill>
      </div>

      <div className="flex items-end justify-between gap-3 border-t border-border pt-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">Gross</p>
          <p className="mt-0.5 font-mono text-sm text-text">{formatMoney(sync.grossMinor)}</p>
        </div>
        <div className="text-right">
          <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">Fee</p>
          <p className="mt-0.5 font-mono text-sm text-text">{formatMoney(sync.feeMinor)}</p>
        </div>
      </div>

      <PayoutRowActions
        sync={sync}
        posting={posting}
        skipping={skipping}
        onPost={onPost}
        onSkip={onSkip}
      />
    </li>
  );
}
