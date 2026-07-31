import type { ReactElement } from 'react';

import { Button, ResponsiveTable } from '../../components';
import { cx } from '../../lib/cx';
import { EmptyRow, Pill, TABLE_CLASSES, TD_CLASSES, TH_CLASSES } from '../settings/section';
import type { Automation } from './queries';

/**
 * One page of automations.
 *
 * `isActive` is read, never derived — it comes straight off the response, the same reason
 * `recurring-invoices/list.tsx`'s `TemplateList` gives: the engine that decides what
 * "active" means is server-side, and a row shows what the server last said, changed by
 * calling back into it (activate/deactivate), never predicted locally.
 */
export interface AutomationListProps {
  readonly automations: readonly Automation[];
  readonly loading: boolean;
  readonly emptyMessage: string;
  readonly rowPendingId: string | null;
  readonly onEdit: (automation: Automation) => void;
  readonly onToggleActive: (automation: Automation) => void;
  readonly onRun: (automation: Automation) => void;
}

function triggerLabel(trigger: Automation['trigger']): string {
  if (trigger.type === 'manual') return 'Manual';
  if (trigger.type === 'scheduled') return `Scheduled · ${trigger.cadence}`;
  return `Event · ${trigger.eventName}`;
}

export function AutomationList({
  automations,
  loading,
  emptyMessage,
  rowPendingId,
  onEdit,
  onToggleActive,
  onRun,
}: AutomationListProps): ReactElement {
  return (
    <ResponsiveTable>
      <table className={TABLE_CLASSES}>
        <caption className="sr-only">Automations</caption>
        <thead>
          <tr>
            <th scope="col" className={TH_CLASSES}>
              Name
            </th>
            <th scope="col" className={TH_CLASSES}>
              Trigger
            </th>
            <th scope="col" className={TH_CLASSES}>
              Actions
            </th>
            <th scope="col" className={TH_CLASSES}>
              Status
            </th>
            <th scope="col" className={cx(TH_CLASSES, 'text-right')}>
              <span className="sr-only">Row actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {automations.length === 0 && (
            <EmptyRow columns={5}>{loading ? 'Loading…' : emptyMessage}</EmptyRow>
          )}
          {automations.map((automation) => (
            <tr key={automation.id}>
              <td className={TD_CLASSES}>
                <button
                  type="button"
                  onClick={() => {
                    onEdit(automation);
                  }}
                  className="rounded-sm text-left text-text underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
                >
                  {automation.name}
                </button>
              </td>
              <td className={TD_CLASSES}>{triggerLabel(automation.trigger)}</td>
              <td className={TD_CLASSES}>
                {automation.actions.length} {automation.actions.length === 1 ? 'action' : 'actions'}
              </td>
              <td className={TD_CLASSES}>
                <Pill tone={automation.isActive ? 'positive' : 'muted'}>
                  {automation.isActive ? 'Active' : 'Inactive'}
                </Pill>
              </td>
              <td className={cx(TD_CLASSES, 'text-right')}>
                <div className="flex justify-end gap-1">
                  <Button
                    size="sm"
                    onClick={() => {
                      onEdit(automation);
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    disabled={rowPendingId === automation.id}
                    aria-label={`${automation.isActive ? 'Deactivate' : 'Activate'} ${automation.name}`}
                    onClick={() => {
                      onToggleActive(automation);
                    }}
                  >
                    {automation.isActive ? 'Deactivate' : 'Activate'}
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={rowPendingId === automation.id}
                    aria-label={`Run ${automation.name} now`}
                    onClick={() => {
                      onRun(automation);
                    }}
                  >
                    Run now
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ResponsiveTable>
  );
}
