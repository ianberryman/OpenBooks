import type { ReactElement } from 'react';
import { useState } from 'react';

import { Button, ErrorBanner } from '../components';
import { AutomationFormDialog } from './automations/form-dialog';
import { AutomationList } from './automations/list';
import {
  useActivateAutomation,
  useAutomationList,
  useDeactivateAutomation,
  useIntentKey,
  useRunAutomation,
} from './automations/queries';
import type { Automation, AutomationRunResult } from './automations/queries';
import { Notice } from './settings/section';

/**
 * Automations (initiative Q; ROADMAP D-99, D-100, D-119) — a trigger and an ordered list of
 * actions the user composes and owns.
 *
 * ## What an automation is not
 *
 * This screen never calls a model and never posts to the ledger. An `annotate` action
 * writes a deterministic note; an `agent_task` action enqueues a work item the org's own
 * agent polls over MCP (`work_queue.poll`) and eventually submits a proposal back to
 * (`work_queue.submitProposal`) — that proposal lands as an ordinary `journal_drafts` row a
 * human reviews on `agent-proposals.tsx`, exactly the same queue an interactive agent uses.
 * `screens/work-items.tsx` is where a human watches what an `agent_task` action produced;
 * this screen is only where the trigger and the actions are composed.
 *
 * ## Write controls are not hidden by permission (D-25)
 *
 * Matching `dunning.tsx` and `bill-captures.tsx`: nothing here hides Activate, Deactivate or
 * Run now because a role lacks `workflows.activate` — that permission is deliberately
 * separate from `workflows.write` (composing) and owner-only, enforced service-side. A
 * caller who lacks it still sees every control and meets the refusal as an ordinary
 * `permission_denied` `ErrorBanner`, phrased by `presentApiError` as "Not available to you"
 * rather than a control that quietly vanished.
 */
export function AutomationsScreen(): ReactElement {
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Automation | null>(null);
  const [rowPendingId, setRowPendingId] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<{
    readonly automationName: string;
    readonly result: AutomationRunResult;
  } | null>(null);

  const list = useAutomationList();
  const activate = useActivateAutomation();
  const deactivate = useDeactivateAutomation();
  const run = useRunAutomation();
  const intentKey = useIntentKey();

  const automations = list.data?.items ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-text">Automations</h1>
          <p className="max-w-form text-text-muted">
            A trigger and an ordered list of actions each firing runs. An annotate action writes a
            note; an agent-task action enqueues a prompt the org’s own agent picks up over MCP —
            nothing here calls a model or posts to the ledger directly.
          </p>
        </div>
        <Button
          variant="primary"
          onClick={() => {
            setEditing(null);
            setFormOpen(true);
          }}
        >
          New automation
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
      {activate.isError && <ErrorBanner error={activate.error} />}
      {deactivate.isError && <ErrorBanner error={deactivate.error} />}
      {run.isError && <ErrorBanner error={run.error} />}

      {lastRun !== null && (
        <Notice
          tone="success"
          title={`Ran “${lastRun.automationName}”`}
          actions={
            <Button
              size="sm"
              onClick={() => {
                setLastRun(null);
              }}
            >
              Dismiss
            </Button>
          }
        >
          {lastRun.result.annotationsWritten}{' '}
          {lastRun.result.annotationsWritten === 1 ? 'annotation' : 'annotations'} written,{' '}
          {lastRun.result.workItemsEnqueued}{' '}
          {lastRun.result.workItemsEnqueued === 1 ? 'work item' : 'work items'} enqueued.
        </Notice>
      )}

      <AutomationList
        automations={automations}
        loading={list.isPending}
        emptyMessage="No automations yet. Actions run in the order composed here — nothing fires until one exists and is activated."
        rowPendingId={rowPendingId}
        onEdit={(automation) => {
          setEditing(automation);
          setFormOpen(true);
        }}
        onToggleActive={(automation) => {
          setRowPendingId(automation.id);
          const idempotencyKey = intentKey(
            `${automation.isActive ? 'deactivate' : 'activate'}:${automation.id}`,
          );
          if (automation.isActive) {
            deactivate.mutate(
              { automationId: automation.id, idempotencyKey },
              { onSettled: () => setRowPendingId(null) },
            );
          } else {
            activate.mutate(
              { automationId: automation.id, idempotencyKey },
              { onSettled: () => setRowPendingId(null) },
            );
          }
        }}
        onRun={(automation) => {
          setRowPendingId(automation.id);
          setLastRun(null);
          run.mutate(
            { automationId: automation.id, idempotencyKey: intentKey(`run:${automation.id}`) },
            {
              onSuccess: (result) => {
                setLastRun({ automationName: automation.name, result });
              },
              onSettled: () => setRowPendingId(null),
            },
          );
        }}
      />

      <AutomationFormDialog
        automation={editing}
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) setEditing(null);
        }}
      />
    </div>
  );
}
