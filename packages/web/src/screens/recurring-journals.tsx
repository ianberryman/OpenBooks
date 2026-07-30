import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';

import { Button, ErrorBanner, Field, FieldLabel, Select } from '../components';
import { DeactivateTemplateDialog } from './recurring-journals/deactivate-dialog';
import { TemplateList } from './recurring-journals/list';
import {
  useIntentKey,
  useSetTemplateActive,
  useTemplateList,
  useTemplateReferenceData,
} from './recurring-journals/queries';
import type { RecurringJournalTemplate } from './recurring-journals/queries';
import { TemplateFormDialog } from './recurring-journals/template-form';

/**
 * Recurring journals (OB-167) — templates the scheduler materialises into ordinary GL
 * journals each cycle (OB-162; ROADMAP D-90) — `recurring-invoices.tsx`'s shape.
 *
 * ## What a template is not, and why this screen stays small
 *
 * A template is not a journal with a repeat flag. It holds no `status`, and each cycle is
 * posted (or landed as a draft, per `materializationMode`) exactly as if a human had
 * started it, through the same posting path a human uses, unattended, via a system actor.
 * This screen's whole job is therefore the schedule and the fixed lines a cycle will post,
 * not anything about a journal already materialised — those are ordinary journals from the
 * moment they post and are read on the Journals screen, not here.
 *
 * ## Three ways a template stops running, and they are not one control
 *
 * - **Pause** — `PATCH { isActive: false }` — reversible, a toggle on the list.
 * - **Resume** — `PATCH { isActive: true }` — the same toggle, the other way.
 * - **Retire** — `POST …/deactivate` — a one-way door, confirmed in its own dialog.
 *
 * There is no dedicated pause/resume route; both are the general update carrying one
 * field. Folding retire into the same toggle would make an irreversible action one
 * accidental second click away from a reversible one, which is why it stays a separate,
 * confirmed control (`deactivate-dialog.tsx`).
 */

type ActiveFilter = 'active' | 'all';

const FILTER_OPTIONS = [
  { value: 'active', label: 'Active only' },
  { value: 'all', label: 'Active and paused' },
];

export function RecurringJournalsScreen(): ReactElement {
  const [filter, setFilter] = useState<ActiveFilter>('active');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<RecurringJournalTemplate | null>(null);
  const [deactivating, setDeactivating] = useState<RecurringJournalTemplate | null>(null);

  const reference = useTemplateReferenceData();
  const list = useTemplateList(filter === 'active' ? true : null);
  const setActive = useSetTemplateActive();
  const intentKey = useIntentKey();

  const templates = useMemo(
    () => list.data?.pages.flatMap((page) => page.items) ?? [],
    [list.data],
  );

  const [togglePendingId, setTogglePendingId] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-text">Recurring journals</h1>
          <p className="max-w-form text-text-muted">
            Templates the scheduler turns into ordinary GL journals each cycle — fixed accounts,
            fixed amounts, posted verbatim.
          </p>
        </div>
        <Button
          variant="primary"
          disabled={reference.data === null}
          onClick={() => {
            setEditing(null);
            setFormOpen(true);
          }}
        >
          New recurring journal
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-3">
        <Field className="w-48">
          <FieldLabel>Status</FieldLabel>
          <Select
            value={filter}
            options={FILTER_OPTIONS}
            onValueChange={(value) => {
              setFilter(value === 'all' ? 'all' : 'active');
            }}
          />
        </Field>
      </div>

      {reference.error != null && (
        <ErrorBanner error={reference.error} onRetry={reference.refetch} />
      )}

      {list.error != null && (
        <ErrorBanner
          error={list.error}
          onRetry={() => {
            void list.refetch();
          }}
        />
      )}

      {setActive.isError && <ErrorBanner error={setActive.error} />}

      <TemplateList
        templates={templates}
        loading={list.isPending}
        emptyMessage={
          filter === 'active'
            ? 'No active recurring journals. A new one starts active — pausing or retiring it is ' +
              'always available afterwards.'
            : 'No recurring journals yet.'
        }
        togglePendingId={togglePendingId}
        onEdit={(template) => {
          setEditing(template);
          setFormOpen(true);
        }}
        onToggleActive={(template) => {
          setTogglePendingId(template.id);
          setActive.mutate(
            {
              templateId: template.id,
              active: !template.isActive,
              idempotencyKey: intentKey(`${template.isActive ? 'pause' : 'resume'}:${template.id}`),
            },
            { onSettled: () => setTogglePendingId(null) },
          );
        }}
        onDeactivate={(template) => {
          setDeactivating(template);
        }}
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

      {reference.data !== null && (
        <TemplateFormDialog
          template={editing}
          reference={reference.data}
          open={formOpen}
          onOpenChange={(open) => {
            setFormOpen(open);
            if (!open) setEditing(null);
          }}
        />
      )}

      <DeactivateTemplateDialog
        template={deactivating}
        onOpenChange={(open) => {
          if (!open) setDeactivating(null);
        }}
      />
    </div>
  );
}
