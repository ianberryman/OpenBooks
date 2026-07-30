import type { ReactElement } from 'react';
import { useId, useState } from 'react';

import { presentApiError } from '../../api';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  ErrorBanner,
  Field,
  FieldLabel,
  Select,
  TextInput,
} from '../../components';
import type { SelectOption } from '../../components';
import { ActionEditor } from './action-editor';
import {
  blankFormState,
  formIsComplete,
  stateFromAutomation,
  toCreateRequest,
  toUpdateRequest,
} from './automation-state';
import type { AutomationFormState, TriggerDraft } from './automation-state';
import type { Automation, AutomationScheduleCadence } from './queries';
import { useCreateAutomation, useIntentKey, useUpdateAutomation } from './queries';

/**
 * The one form for creating and editing an automation — `recurring-invoices/template-
 * form.tsx`'s shape: create and edit differ only in what seeds the fields and what the
 * submit label says.
 *
 * ## `isActive` is not a field on this form
 *
 * Activate, deactivate and run are list-level controls (`screens/automations.tsx`), not
 * something this dialog writes — `workflows.activate` is a separate, owner-only permission
 * from `workflows.write`, which composes an automation but cannot enable it to fire
 * (`UpdateAutomationRequest`'s own comment). Folding the two into one submit would make "I
 * fixed the prompt" and "I turned this automation on" the same click.
 */

const CADENCE_OPTIONS: readonly SelectOption[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
];

function isCadence(value: string): value is AutomationScheduleCadence {
  return value === 'daily' || value === 'weekly' || value === 'monthly';
}

export interface AutomationFormDialogProps {
  /** `null` creates; an automation edits it. */
  readonly automation: Automation | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function AutomationFormDialog({
  automation,
  open,
  onOpenChange,
}: AutomationFormDialogProps): ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Keyed on the automation so a second "Edit" starts from that row's values rather
          than from whichever automation the dialog last held — the state below is
          initialised once, not kept in sync with the prop
          (`recurring-invoices/template-form.tsx`'s same reasoning). */}
      {open && (
        <AutomationFormContent
          key={automation?.id ?? 'new'}
          automation={automation}
          onDone={() => {
            onOpenChange(false);
          }}
        />
      )}
    </Dialog>
  );
}

function AutomationFormContent({
  automation,
  onDone,
}: {
  readonly automation: Automation | null;
  readonly onDone: () => void;
}): ReactElement {
  const formId = useId();
  const [state, setState] = useState<AutomationFormState>(() =>
    automation === null ? blankFormState() : stateFromAutomation(automation),
  );

  const create = useCreateAutomation();
  const update = useUpdateAutomation();
  const intentKey = useIntentKey();

  const pending = create.isPending || update.isPending;
  const error: unknown = create.error ?? update.error;
  const fieldErrors = presentApiError(error).fieldErrors;

  function edit(next: Partial<AutomationFormState>): void {
    setState((current) => ({ ...current, ...next }));
  }

  function editTrigger(trigger: TriggerDraft): void {
    edit({ trigger });
  }

  const complete = formIsComplete(state);

  function submit(): void {
    if (!complete) return;

    if (automation === null) {
      const body = toCreateRequest(state);
      create.mutate(
        { ...body, idempotencyKey: intentKey(`create:${JSON.stringify(body)}`) },
        { onSuccess: onDone },
      );
      return;
    }

    const patch = toUpdateRequest(state);
    update.mutate(
      {
        automationId: automation.id,
        patch,
        idempotencyKey: intentKey(`update:${automation.id}:${JSON.stringify(patch)}`),
      },
      { onSuccess: onDone },
    );
  }

  return (
    <DialogContent
      title={automation === null ? 'New automation' : 'Edit automation'}
      description="A trigger and an ordered list of actions. Created inactive — enabling it to fire is a separate step, gated by a separate permission."
      className="max-w-3xl"
      footer={
        <>
          <DialogClose asChild>
            <Button disabled={pending}>Cancel</Button>
          </DialogClose>
          <Button type="submit" form={formId} variant="primary" disabled={pending || !complete}>
            {pending ? 'Saving…' : automation === null ? 'Create' : 'Save'}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {error !== undefined && error !== null && <ErrorBanner error={error} />}

        <Field error={fieldErrors['name']}>
          <FieldLabel>Name</FieldLabel>
          <TextInput
            value={state.name}
            disabled={pending}
            placeholder="e.g. Flag overdue invoices"
            onChange={(event) => {
              edit({ name: event.target.value });
            }}
          />
        </Field>

        <fieldset className="flex flex-col gap-2">
          <legend className="pb-1 text-sm font-medium text-text">Trigger</legend>

          <label className="flex items-center gap-2 text-sm text-text">
            <input
              type="radio"
              name="trigger-type"
              className="accent-accent"
              checked={state.trigger.type === 'manual'}
              disabled={pending}
              onChange={() => {
                editTrigger({ type: 'manual' });
              }}
            />
            Manual — fires only from “Run now”
          </label>

          <label className="flex items-center gap-2 text-sm text-text">
            <input
              type="radio"
              name="trigger-type"
              className="accent-accent"
              checked={state.trigger.type === 'scheduled'}
              disabled={pending}
              onChange={() => {
                editTrigger({
                  type: 'scheduled',
                  cadence: state.trigger.type === 'scheduled' ? state.trigger.cadence : 'daily',
                });
              }}
            />
            Scheduled — the daily sweep matches a cadence
          </label>
          {state.trigger.type === 'scheduled' && (
            <Field className="ml-6 w-40">
              <FieldLabel>Cadence</FieldLabel>
              <Select
                options={CADENCE_OPTIONS}
                value={state.trigger.cadence}
                disabled={pending}
                onValueChange={(value) => {
                  if (isCadence(value)) editTrigger({ type: 'scheduled', cadence: value });
                }}
              />
            </Field>
          )}

          <label className="flex items-center gap-2 text-sm text-text">
            <input
              type="radio"
              name="trigger-type"
              className="accent-accent"
              checked={state.trigger.type === 'event'}
              disabled={pending}
              onChange={() => {
                editTrigger({
                  type: 'event',
                  eventName: state.trigger.type === 'event' ? state.trigger.eventName : '',
                });
              }}
            />
            Event — a change-feed event name fires it
          </label>
          {state.trigger.type === 'event' && (
            <Field
              className="ml-6 min-w-64"
              error={fieldErrors['trigger.eventName']}
              hint="e.g. bill.approved.v1"
            >
              <FieldLabel>Event name</FieldLabel>
              <TextInput
                value={state.trigger.eventName}
                disabled={pending}
                onChange={(event) => {
                  editTrigger({ type: 'event', eventName: event.target.value });
                }}
              />
            </Field>
          )}
        </fieldset>

        <ActionEditor
          actions={state.actions}
          fieldErrors={fieldErrors}
          disabled={pending}
          onChange={(actions) => {
            edit({ actions });
          }}
        />
      </form>
    </DialogContent>
  );
}
