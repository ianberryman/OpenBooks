import type { ReactElement } from 'react';
import { useState } from 'react';

import { newIdempotencyKey } from '../api';
import { ErrorBanner, Field, FieldLabel, Select } from '../components';
import type { SelectOption } from '../components';
import { Notice } from './settings/section';
import { WorkItemList } from './work-items/list';
import { useCancelWorkItem, useWorkItems } from './work-items/queries';
import type { WorkItem, WorkItemStatus } from './work-items/queries';

const WORK_ITEM_STATUSES: readonly WorkItemStatus[] = [
  'queued',
  'leased',
  'proposed',
  'failed',
  'cancelled',
];

function asWorkItemStatus(value: string): WorkItemStatus | null {
  return WORK_ITEM_STATUSES.find((status) => status === value) ?? null;
}

const STATUS_FILTER_OPTIONS: readonly SelectOption[] = [
  { value: 'all', label: 'All statuses' },
  { value: 'queued', label: 'Queued' },
  { value: 'leased', label: 'Leased' },
  { value: 'proposed', label: 'Proposed' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
];

/**
 * The work queue (Q4…Q7) — every item an automation's `agent_task` action has enqueued, and
 * whatever the org's own agent has since done with it.
 *
 * ## What this screen is for, and what it is not
 *
 * `screens/automations.tsx` composes what enqueues a work item; this is where a human
 * watches the queue and what came back. Nothing here leases an item or submits a proposal —
 * that is the MCP surface (`work_queue.poll` / `work_queue.submitProposal`, D-118), reached
 * only by the org's own agent, never by a button in this application. A `proposedDraftId`
 * marks the one thing a work item can hand off to a human: an ordinary `journal_drafts` row,
 * reviewed on `agent-proposals.tsx` — the same queue an interactively-proposed entry uses —
 * so this screen's "Review proposal" link goes there rather than duplicating any of that
 * review surface here.
 *
 * ## Write controls are not hidden by permission (D-25)
 *
 * Matching every other screen in this package: Cancel is offered regardless of
 * `workflows.activate`, and a caller who lacks it meets the refusal as an ordinary
 * `permission_denied` `ErrorBanner`, not a control this screen hides.
 */
export function WorkQueueScreen(): ReactElement {
  const [status, setStatus] = useState<WorkItemStatus | null>(null);
  const [cancelPendingId, setCancelPendingId] = useState<string | null>(null);

  const items = useWorkItems(status);
  const cancel = useCancelWorkItem();

  function handleCancel(item: WorkItem): void {
    setCancelPendingId(item.id);
    cancel.mutate(
      { workItemId: item.id, idempotencyKey: newIdempotencyKey() },
      { onSettled: () => setCancelPendingId(null) },
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-text">Work queue</h1>
        <p className="max-w-form text-text-muted">
          What an automation’s agent-task actions have enqueued for the org’s own agent, and what it
          has reported back. Nothing here posts to the ledger — a submitted proposal lands as an
          ordinary journal draft, reviewed on Agent proposals.
        </p>
      </div>

      {items.error != null && (
        <ErrorBanner
          error={items.error}
          onRetry={() => {
            void items.refetch();
          }}
        />
      )}
      {cancel.isError && <ErrorBanner error={cancel.error} />}

      <Field className="w-56">
        <FieldLabel>Status</FieldLabel>
        <Select
          value={status ?? 'all'}
          options={STATUS_FILTER_OPTIONS}
          onValueChange={(value) => {
            setStatus(asWorkItemStatus(value));
          }}
        />
      </Field>

      <WorkItemList
        items={items.items}
        loading={items.isPending}
        emptyMessage="Nothing in the queue."
        cancelPendingId={cancelPendingId}
        onCancel={handleCancel}
      />

      {items.truncated && (
        <Notice tone="info">
          Showing the first page. Narrow the status filter to reach the rest.
        </Notice>
      )}
    </div>
  );
}
