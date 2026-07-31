import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';

import { Button, ResponsiveTable } from '../../components';
import { cx } from '../../lib/cx';
import { EmptyRow, Pill, TABLE_CLASSES, TD_CLASSES, TH_CLASSES } from '../settings/section';
import type { PillTone } from '../settings/section';
import type { WorkItem, WorkItemStatus } from './queries';

const STATUS_TONE: Readonly<Record<WorkItemStatus, PillTone>> = {
  queued: 'neutral',
  leased: 'neutral',
  proposed: 'positive',
  failed: 'negative',
  cancelled: 'muted',
};

/** Cancel withdraws an item before an agent has finished with it — `cancelWorkItem`'s own
 * words, "so no agent picks it up (or finishes acting on it)" — which is only meaningful
 * while the item is still `queued` or `leased`. A `proposed`, `failed` or `cancelled` item
 * has nothing left to withdraw. */
function isCancellable(status: WorkItemStatus): boolean {
  return status === 'queued' || status === 'leased';
}

/**
 * One page of work items.
 *
 * There is no `submittedByClient` on `WorkItem` — the generated schema carries only
 * `agentModel` (the agent's own attested provenance, D-100), `leasedBy` (who currently
 * holds, or last held, the lease) and `submittedAt`, so provenance here is those three
 * columns rather than a fourth the wire contract does not have.
 */
export interface WorkItemListProps {
  readonly items: readonly WorkItem[];
  readonly loading: boolean;
  readonly emptyMessage: string;
  readonly cancelPendingId: string | null;
  readonly onCancel: (item: WorkItem) => void;
}

export function WorkItemList({
  items,
  loading,
  emptyMessage,
  cancelPendingId,
  onCancel,
}: WorkItemListProps): ReactElement {
  return (
    <ResponsiveTable>
      <table className={TABLE_CLASSES}>
        <caption className="sr-only">Work queue</caption>
        <thead>
          <tr>
            <th scope="col" className={TH_CLASSES}>
              Prompt
            </th>
            <th scope="col" className={TH_CLASSES}>
              Status
            </th>
            <th scope="col" className={TH_CLASSES}>
              Attempts
            </th>
            <th scope="col" className={TH_CLASSES}>
              Flagged
            </th>
            <th scope="col" className={TH_CLASSES}>
              Provenance
            </th>
            <th scope="col" className={cx(TH_CLASSES, 'text-right')}>
              <span className="sr-only">Row actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 && (
            <EmptyRow columns={6}>{loading ? 'Loading…' : emptyMessage}</EmptyRow>
          )}
          {items.map((item) => (
            <tr key={item.id}>
              <td className={cx(TD_CLASSES, 'max-w-md')}>
                <span className="block truncate" title={item.prompt}>
                  {item.prompt}
                </span>
                <span className="block text-xs text-text-subtle">{item.sourceKind}</span>
              </td>
              <td className={TD_CLASSES}>
                <Pill tone={STATUS_TONE[item.status]}>{item.status}</Pill>
                {item.lastError !== null && (
                  <span
                    className="mt-1 block max-w-xs truncate text-xs text-danger-text"
                    title={item.lastError}
                  >
                    {item.lastError}
                  </span>
                )}
              </td>
              <td className={TD_CLASSES}>{item.attempts}</td>
              <td className={TD_CLASSES}>{item.flagged ? 'Yes' : 'No'}</td>
              <td className={cx(TD_CLASSES, 'text-text-muted')}>
                <div className="flex flex-col gap-0.5 text-xs">
                  <span>{item.agentModel ?? '—'}</span>
                  <span>{item.leasedBy ?? '—'}</span>
                  <span>{item.submittedAt ?? '—'}</span>
                </div>
              </td>
              <td className={cx(TD_CLASSES, 'text-right')}>
                <div className="flex items-center justify-end gap-2">
                  {/* No per-item deep link exists into the review queue — `agent-
                      proposals.tsx` lists every pending proposal with no id filter — so this
                      links to that queue as a whole, the same shape `bill-captures/capture-
                      list.tsx`'s "View in Purchases" link takes. */}
                  {item.proposedDraftId !== null && (
                    <Link
                      to="/agent-proposals"
                      className="text-xs font-medium text-accent underline-offset-2 hover:underline"
                    >
                      Review proposal
                    </Link>
                  )}
                  {isCancellable(item.status) && (
                    <Button
                      size="sm"
                      disabled={cancelPendingId === item.id}
                      aria-label={`Cancel work item ${item.id}`}
                      onClick={() => {
                        onCancel(item);
                      }}
                    >
                      Cancel
                    </Button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ResponsiveTable>
  );
}
