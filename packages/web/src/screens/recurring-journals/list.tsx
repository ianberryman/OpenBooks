import type { ReactElement } from 'react';

import { Button, ResponsiveTable } from '../../components';
import { cx } from '../../lib/cx';
import { EmptyRow, Pill, TABLE_CLASSES, TD_CLASSES, TH_CLASSES } from '../settings/section';
import type { RecurringJournalTemplate } from './queries';
import { MATERIALIZATION_MODE_LABELS, cadenceLabel } from './vocabulary';

/**
 * One page of templates — `recurring-invoices/list.tsx`'s shape, without a customer
 * column: a GL template names no single counterparty of its own (`contactId` is a
 * per-*line* field, `queries.ts`'s header explains why), so there is nothing here to show
 * one contact for.
 *
 * `nextRunDate` and `isActive` are read, never derived — both come straight off the
 * response, because the engine that advances them
 * (`packages/server/.../recurring-journals/engine.ts`) is the one place that decides what
 * "next" means (D-90). This table shows what the server last said, and a pause, a resume
 * or a retire changes that by calling back into it, never by predicting the new value
 * locally.
 */
export interface TemplateListProps {
  readonly templates: readonly RecurringJournalTemplate[];
  readonly loading: boolean;
  readonly emptyMessage: string;
  readonly togglePendingId: string | null;
  readonly onEdit: (template: RecurringJournalTemplate) => void;
  readonly onToggleActive: (template: RecurringJournalTemplate) => void;
  readonly onDeactivate: (template: RecurringJournalTemplate) => void;
}

export function TemplateList({
  templates,
  loading,
  emptyMessage,
  togglePendingId,
  onEdit,
  onToggleActive,
  onDeactivate,
}: TemplateListProps): ReactElement {
  return (
    <ResponsiveTable>
      <table className={TABLE_CLASSES}>
        <caption className="sr-only">Recurring journals</caption>
        <thead>
          <tr>
            <th scope="col" className={TH_CLASSES}>
              Name
            </th>
            <th scope="col" className={TH_CLASSES}>
              Cadence
            </th>
            <th scope="col" className={TH_CLASSES}>
              Each cycle
            </th>
            <th scope="col" className={TH_CLASSES}>
              Next run
            </th>
            <th scope="col" className={TH_CLASSES}>
              Status
            </th>
            <th scope="col" className={cx(TH_CLASSES, 'text-right')}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {templates.length === 0 && (
            <EmptyRow columns={6}>{loading ? 'Loading…' : emptyMessage}</EmptyRow>
          )}
          {templates.map((template) => (
            <tr key={template.id}>
              <td className={TD_CLASSES}>
                <button
                  type="button"
                  onClick={() => {
                    onEdit(template);
                  }}
                  className="rounded-sm text-left text-text underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
                >
                  {template.name}
                </button>
                {template.memo !== null && template.memo !== '' && (
                  <span className="block text-xs text-text-subtle">{template.memo}</span>
                )}
              </td>
              <td className={TD_CLASSES}>
                {cadenceLabel(template.frequency, template.intervalCount)}
              </td>
              <td className={TD_CLASSES}>
                {MATERIALIZATION_MODE_LABELS[template.materializationMode]}
              </td>
              <td className={cx(TD_CLASSES, 'font-mono')}>
                {template.isActive ? template.nextRunDate : '—'}
              </td>
              <td className={TD_CLASSES}>
                <Pill tone={template.isActive ? 'positive' : 'muted'}>
                  {template.isActive ? 'Active' : 'Paused'}
                </Pill>
              </td>
              <td className={cx(TD_CLASSES, 'text-right')}>
                <div className="flex justify-end gap-1">
                  <Button
                    size="sm"
                    onClick={() => {
                      onEdit(template);
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    disabled={togglePendingId === template.id}
                    aria-label={`${template.isActive ? 'Pause' : 'Resume'} ${template.name}`}
                    onClick={() => {
                      onToggleActive(template);
                    }}
                  >
                    {template.isActive ? 'Pause' : 'Resume'}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    aria-label={`Retire ${template.name}`}
                    onClick={() => {
                      onDeactivate(template);
                    }}
                  >
                    Retire
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
