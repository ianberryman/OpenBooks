import type { ReactElement } from 'react';
import { useId, useMemo, useState } from 'react';

import { presentApiError } from '../../api';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  ErrorBanner,
  Field,
  FieldLabel,
  ResponsiveTable,
  Select,
  TextInput,
} from '../../components';
import type { ComboboxOption } from '../../components';
import { BalanceIndicator } from './balance-indicator';
import { LineRow, NO_CONTACT } from './line-row';
import type { RecurringJournalTemplate, TemplateFrequency, TemplateReferenceData } from './queries';
import { useCreateTemplate, useIntentKey, useUpdateTemplate } from './queries';
import {
  balanceOf,
  blankFormState,
  blankLine,
  formIsComplete,
  lineIsComplete,
  stateFromTemplate,
  toCreateRequest,
  toUpdateRequest,
} from './template-state';
import type { TemplateFormState, TemplateLineDraft } from './template-state';
import {
  FREQUENCY_OPTIONS,
  MATERIALIZATION_MODE_EXPLANATIONS,
  MATERIALIZATION_MODE_OPTIONS,
  cadenceLabel,
} from './vocabulary';

/**
 * The one form for creating and editing a recurring GL journal template (OB-167; OB-162,
 * D-90).
 *
 * ## `startDate` is a create-only field because it is a create-only value
 *
 * It never appears on `RecurringJournalTemplate` at all — it seeds `nextRunDate` once and
 * is then gone, per that field's own description. So the field is absent from this form
 * while editing rather than shown disabled: a template's schedule from here on is read and
 * written through `nextRunDate`/`lastRunDate`, which this screen does not offer as editable
 * either, because "move the next run to a specific date by hand" is a different, larger
 * feature this ticket does not build.
 *
 * ## A line here is already a posting instruction
 *
 * `{ accountId, side, amount }` is exactly what `postJournal` takes, so nothing here prices
 * a line the way `sales/` prices a quantity and a unit amount — what is entered is exactly
 * what is sent, each cycle, verbatim. That is also why the two rules this form guards
 * before submit are the ledger kernel's own two rules (at least two lines, debits equal
 * credits) rather than anything about pricing.
 *
 * ## `isActive` is not a field on this form
 *
 * Pause, resume and retire are list-level controls (`queries.ts`'s
 * `useSetTemplateActive`/`useDeactivateTemplate`), not something this dialog writes. A
 * template being edited is not thereby being paused, and folding the two into one submit
 * would make "I fixed a line" and "I paused this template" the same click.
 */

function isFrequency(value: string): value is TemplateFrequency {
  return value === 'weekly' || value === 'monthly' || value === 'quarterly' || value === 'yearly';
}

export interface TemplateFormDialogProps {
  /** `null` creates; a template edits it. */
  readonly template: RecurringJournalTemplate | null;
  readonly reference: TemplateReferenceData;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function TemplateFormDialog({
  template,
  reference,
  open,
  onOpenChange,
}: TemplateFormDialogProps): ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Keyed on the template so a second "Edit" starts from that row's values rather
          than from whichever template the dialog last held — the state below is
          initialised once, not kept in sync with the prop. */}
      {open && (
        <TemplateFormContent
          key={template?.id ?? 'new'}
          template={template}
          reference={reference}
          onDone={() => {
            onOpenChange(false);
          }}
        />
      )}
    </Dialog>
  );
}

function TemplateFormContent({
  template,
  reference,
  onDone,
}: {
  readonly template: RecurringJournalTemplate | null;
  readonly reference: TemplateReferenceData;
  readonly onDone: () => void;
}): ReactElement {
  const formId = useId();
  const [state, setState] = useState<TemplateFormState>(() =>
    template === null ? blankFormState() : stateFromTemplate(template),
  );

  const create = useCreateTemplate();
  const update = useUpdateTemplate();
  const intentKey = useIntentKey();

  const pending = create.isPending || update.isPending;
  const error: unknown = create.error ?? update.error;
  const fieldErrors = presentApiError(error).fieldErrors;

  const accountOptions = useMemo<ComboboxOption[]>(
    () =>
      reference.accounts.map((account) => ({
        value: account.id,
        label: account.name,
        detail: account.code,
        disabled: !account.isActive,
      })),
    [reference.accounts],
  );

  const contactOptions = useMemo<ComboboxOption[]>(
    () => [
      NO_CONTACT,
      ...reference.contacts.map((contact) => ({
        value: contact.id,
        label: contact.displayName,
        ...(contact.code === null ? {} : { detail: contact.code }),
        disabled: !contact.isActive,
      })),
    ],
    [reference.contacts],
  );

  function edit(next: Partial<TemplateFormState>): void {
    setState((current) => ({ ...current, ...next }));
  }

  function editLine(line: TemplateLineDraft): void {
    edit({ lines: state.lines.map((existing) => (existing.key === line.key ? line : existing)) });
  }

  const complete = formIsComplete(state, template === null);
  const linesComplete = state.lines.every(lineIsComplete);
  const totals = balanceOf(state.lines);
  const linesError = fieldErrors['lines'];

  function submit(): void {
    if (!complete) return;

    if (template === null) {
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
        templateId: template.id,
        patch,
        idempotencyKey: intentKey(`update:${template.id}:${JSON.stringify(patch)}`),
      },
      { onSuccess: onDone },
    );
  }

  const intervalCountForPreview = Number(state.intervalCount.trim());
  const cadencePreview = cadenceLabel(
    state.frequency,
    Number.isInteger(intervalCountForPreview) && intervalCountForPreview > 0
      ? intervalCountForPreview
      : 1,
  );

  return (
    <DialogContent
      title={template === null ? 'New recurring journal' : 'Edit recurring journal'}
      description="A schedule and the balanced lines it posts, verbatim, each cycle."
      className="max-w-3xl"
      footer={
        <>
          <DialogClose asChild>
            <Button disabled={pending}>Cancel</Button>
          </DialogClose>
          <Button type="submit" form={formId} variant="primary" disabled={pending || !complete}>
            {pending ? 'Saving…' : template === null ? 'Create' : 'Save'}
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

        <Field error={fieldErrors['name']} hint="What an operator picks this template out by.">
          <FieldLabel>Name</FieldLabel>
          <TextInput
            value={state.name}
            disabled={pending}
            placeholder="e.g. Monthly rent accrual"
            onChange={(event) => {
              edit({ name: event.target.value });
            }}
          />
        </Field>

        <Field hint={MATERIALIZATION_MODE_EXPLANATIONS[state.materializationMode]}>
          <FieldLabel>Each cycle</FieldLabel>
          <Select
            options={MATERIALIZATION_MODE_OPTIONS}
            value={state.materializationMode}
            disabled={pending}
            onValueChange={(value) => {
              if (value === 'draft' || value === 'posted') edit({ materializationMode: value });
            }}
          />
        </Field>

        <div className="flex flex-wrap items-end gap-4">
          <Field className="w-40">
            <FieldLabel>Frequency</FieldLabel>
            <Select
              options={FREQUENCY_OPTIONS}
              value={state.frequency}
              disabled={pending}
              onValueChange={(value) => {
                if (isFrequency(value)) edit({ frequency: value });
              }}
            />
          </Field>

          <Field
            className="w-32"
            error={fieldErrors['intervalCount']}
            hint="How many frequency units between cycles."
          >
            <FieldLabel>Every</FieldLabel>
            <TextInput
              type="number"
              min={1}
              inputMode="numeric"
              value={state.intervalCount}
              disabled={pending}
              onChange={(event) => {
                edit({ intervalCount: event.target.value });
              }}
            />
          </Field>

          <p className="pb-2 text-sm text-text-muted">{cadencePreview}</p>
        </div>

        <div className="flex flex-wrap gap-4">
          {template === null && (
            <Field className="w-44" error={fieldErrors['startDate']} hint="The first run date.">
              <FieldLabel>Start date</FieldLabel>
              <TextInput
                type="date"
                value={state.startDate}
                disabled={pending}
                onChange={(event) => {
                  edit({ startDate: event.target.value });
                }}
              />
            </Field>
          )}

          <Field
            className="w-44"
            error={fieldErrors['endDate']}
            hint="Optional. Leave blank for open-ended."
          >
            <FieldLabel>End date</FieldLabel>
            <TextInput
              type="date"
              value={state.endDate}
              disabled={pending}
              onChange={(event) => {
                edit({ endDate: event.target.value });
              }}
            />
          </Field>
        </div>

        <Field
          error={fieldErrors['memo']}
          hint="Carried onto each cycle's journal header. Optional."
        >
          <FieldLabel>Memo</FieldLabel>
          <TextInput
            value={state.memo}
            disabled={pending}
            onChange={(event) => {
              edit({ memo: event.target.value });
            }}
          />
        </Field>

        <ResponsiveTable>
          <table className="w-full border-collapse">
            <caption className="sr-only">Template lines</caption>
            <thead>
              <tr className="text-left text-xs text-text-subtle">
                <th scope="col" className="p-1 font-medium">
                  Account
                </th>
                <th scope="col" className="p-1 font-medium">
                  Debit
                </th>
                <th scope="col" className="p-1 font-medium">
                  Credit
                </th>
                <th scope="col" className="p-1 font-medium">
                  Contact
                </th>
                <th scope="col" className="p-1 font-medium">
                  Description
                </th>
                <th scope="col" className="p-1 font-medium">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {state.lines.map((line, index) => (
                <LineRow
                  key={line.key}
                  line={line}
                  index={index}
                  accountOptions={accountOptions}
                  contactOptions={contactOptions}
                  fieldErrors={fieldErrors}
                  disabled={pending}
                  onChange={editLine}
                  onRemove={() => {
                    edit({ lines: state.lines.filter((it) => it.key !== line.key) });
                  }}
                />
              ))}
            </tbody>
          </table>
        </ResponsiveTable>

        <div className="flex items-center gap-3">
          <Button
            disabled={pending}
            onClick={() => {
              edit({ lines: [...state.lines, blankLine()] });
            }}
          >
            Add line
          </Button>
          {state.lines.length < 2 ? (
            <span className="text-xs text-text-subtle">At least two lines are required.</span>
          ) : (
            !linesComplete && (
              <span className="text-xs text-text-subtle">
                Every line needs an account, a side and an amount.
              </span>
            )
          )}
        </div>

        <BalanceIndicator totals={totals} linesError={linesError} />
      </form>
    </DialogContent>
  );
}
