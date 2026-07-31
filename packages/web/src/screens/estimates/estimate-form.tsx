import { useQueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useId, useMemo, useState } from 'react';

import { presentApiError } from '../../api';
import {
  Button,
  Combobox,
  Dialog,
  DialogClose,
  DialogContent,
  ErrorBanner,
  Field,
  FieldLabel,
  ResponsiveTable,
  TextInput,
} from '../../components';
import type { ComboboxOption } from '../../components';
import { ContactFormDialog } from '../contacts/contact-form';
import type { Estimate, EstimateReferenceData } from './queries';
import {
  CONTACTS_QUERY_KEY,
  useCreateEstimate,
  useEstimate,
  useIntentKey,
  useUpdateEstimate,
} from './queries';
import {
  blankFormState,
  blankLine,
  formIsComplete,
  lineIsComplete,
  stateFromEstimate,
  toCreateRequest,
  toUpdateRequest,
} from './estimate-state';
import type { EstimateFormState, EstimateLineDraft } from './estimate-state';
import { LineRow } from './line-row';

/**
 * The one dialog for raising and editing an estimate (OB-172, OB-176; ROADMAP D-M3, D-M4,
 * D-M6, D-M7) — `fixed-assets/asset-form.tsx`'s shape: one dialog, keyed on the estimate
 * being edited (or `'new'`), holding its own local state rather than staying in sync with
 * a prop.
 *
 * ## Editing fetches the full estimate; it is never handed the list row
 *
 * `EstimateSummary` (what `list.tsx` renders from) carries no `lines` — `queries.ts`'s file
 * header explains why the list stays that thin. So this dialog takes only an id when
 * editing and fetches the full `Estimate` itself (`useEstimate`), the same "list is thin,
 * the editor reads the whole thing" split `sales.tsx` keeps between `DocumentList` and
 * `DocumentEditor`.
 *
 * ## Draft only, and the server is the one that actually enforces it
 *
 * `updateEstimate` refuses any patch once `sequence_number` is no longer null
 * (`estimate_approved`) — this dialog does not re-derive that refusal in advance; it is
 * only ever opened for a draft row in the first place (`estimates.tsx`'s edit action is
 * gated the same way `list.tsx`'s is).
 */

export interface EstimateFormDialogProps {
  /** `null` creates; an id edits that estimate. */
  readonly estimateId: string | null;
  readonly reference: EstimateReferenceData;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function EstimateFormDialog({
  estimateId,
  reference,
  open,
  onOpenChange,
}: EstimateFormDialogProps): ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Keyed on the estimate, so a second "Edit" starts from that row's own values
          rather than from whichever estimate the dialog last held. */}
      {open && (
        <EstimateFormGate
          key={estimateId ?? 'new'}
          estimateId={estimateId}
          reference={reference}
          onDone={() => {
            onOpenChange(false);
          }}
        />
      )}
    </Dialog>
  );
}

function EstimateFormGate({
  estimateId,
  reference,
  onDone,
}: {
  readonly estimateId: string | null;
  readonly reference: EstimateReferenceData;
  readonly onDone: () => void;
}): ReactElement {
  const fetched = useEstimate(estimateId);

  if (estimateId === null) {
    return <EstimateFormContent estimate={null} reference={reference} onDone={onDone} />;
  }

  if (fetched.error != null) {
    return (
      <DialogContent title="Edit estimate">
        <ErrorBanner
          error={fetched.error}
          onRetry={() => {
            void fetched.refetch();
          }}
        />
      </DialogContent>
    );
  }

  if (fetched.data === undefined) {
    return (
      <DialogContent title="Edit estimate">
        <p className="text-text-subtle">Loading…</p>
      </DialogContent>
    );
  }

  return <EstimateFormContent estimate={fetched.data} reference={reference} onDone={onDone} />;
}

function EstimateFormContent({
  estimate,
  reference,
  onDone,
}: {
  readonly estimate: Estimate | null;
  readonly reference: EstimateReferenceData;
  readonly onDone: () => void;
}): ReactElement {
  const formId = useId();
  const [state, setState] = useState<EstimateFormState>(() =>
    estimate === null ? blankFormState() : stateFromEstimate(estimate),
  );
  const [newCustomerName, setNewCustomerName] = useState<string | null>(null);

  const create = useCreateEstimate();
  const update = useUpdateEstimate();
  const intentKey = useIntentKey();
  const queryClient = useQueryClient();

  const pending = create.isPending || update.isPending;
  const error: unknown = create.error ?? update.error;
  const fieldErrors = presentApiError(error).fieldErrors;

  function edit(next: Partial<EstimateFormState>): void {
    setState((current) => ({ ...current, ...next }));
  }

  function editLine(line: EstimateLineDraft): void {
    edit({ lines: state.lines.map((existing) => (existing.key === line.key ? line : existing)) });
  }

  const customerOptions = useMemo<ComboboxOption[]>(
    () =>
      reference.customers.map((contact) => ({
        value: contact.id,
        label: contact.displayName,
        ...(contact.code === null ? {} : { detail: contact.code }),
        // Archived contacts are listed and disabled rather than omitted, so an estimate
        // that already names one still shows which customer it was raised for.
        disabled: !contact.isActive && contact.id !== state.contactId,
      })),
    [reference.customers, state.contactId],
  );

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

  const complete = formIsComplete(state);
  const linesComplete = state.lines.length > 0 && state.lines.every(lineIsComplete);

  function submit(): void {
    if (!complete) return;

    if (estimate === null) {
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
        estimateId: estimate.id,
        patch,
        idempotencyKey: intentKey(`update:${estimate.id}:${JSON.stringify(patch)}`),
      },
      { onSuccess: onDone },
    );
  }

  return (
    <DialogContent
      title={estimate === null ? 'New estimate' : 'Edit estimate'}
      description="A customer, the lines it quotes, and — optionally — when it lapses. Nothing here posts a journal until it is converted to an invoice."
      className="max-w-3xl"
      footer={
        <>
          <DialogClose asChild>
            <Button disabled={pending}>Cancel</Button>
          </DialogClose>
          <Button type="submit" form={formId} variant="primary" disabled={pending || !complete}>
            {pending ? 'Saving…' : estimate === null ? 'Create' : 'Save'}
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

        <div className="flex flex-wrap gap-4">
          <Field className="min-w-64 flex-1" error={fieldErrors['contactId']}>
            <FieldLabel>Customer</FieldLabel>
            <Combobox
              options={customerOptions}
              value={state.contactId}
              disabled={pending}
              placeholder="Search customers…"
              emptyMessage="No customers yet."
              onValueChange={(value) => {
                edit({ contactId: value });
              }}
              onCreate={{
                label: (q) => (q.trim() === '' ? 'New customer' : `Create "${q.trim()}"`),
                onSelect: (q) => {
                  setNewCustomerName(q.trim());
                },
              }}
            />
          </Field>

          <Field className="w-44" error={fieldErrors['issueDate']}>
            <FieldLabel>Issue date</FieldLabel>
            <TextInput
              type="date"
              value={state.issueDate}
              disabled={pending}
              onChange={(event) => {
                edit({ issueDate: event.target.value });
              }}
            />
          </Field>

          <Field
            className="w-44"
            error={fieldErrors['expiryDate']}
            hint="Optional. Purely informational — nothing enforces it."
          >
            <FieldLabel>Expiry date</FieldLabel>
            <TextInput
              type="date"
              value={state.expiryDate}
              disabled={pending}
              onChange={(event) => {
                edit({ expiryDate: event.target.value });
              }}
            />
          </Field>
        </div>

        <div className="flex flex-wrap gap-4">
          <Field className="min-w-48 flex-1" error={fieldErrors['reference']} hint="Optional.">
            <FieldLabel>Reference</FieldLabel>
            <TextInput
              value={state.reference}
              disabled={pending}
              onChange={(event) => {
                edit({ reference: event.target.value });
              }}
            />
          </Field>

          <Field className="min-w-48 flex-1" error={fieldErrors['memo']} hint="Optional.">
            <FieldLabel>Memo</FieldLabel>
            <TextInput
              value={state.memo}
              disabled={pending}
              onChange={(event) => {
                edit({ memo: event.target.value });
              }}
            />
          </Field>
        </div>

        <ResponsiveTable>
          <table className="w-full border-collapse">
            <caption className="sr-only">Estimate lines</caption>
            <thead>
              <tr className="text-left text-xs text-text-subtle">
                <th scope="col" className="p-1 font-medium">
                  Description
                </th>
                <th scope="col" className="p-1 text-right font-medium">
                  Qty
                </th>
                <th scope="col" className="p-1 text-right font-medium">
                  Unit price
                </th>
                <th scope="col" className="p-1 font-medium">
                  Income account
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
          {state.lines.length === 0 ? (
            <span className="text-xs text-text-subtle">At least one line is required.</span>
          ) : (
            !linesComplete && (
              <span className="text-xs text-text-subtle">
                Every line needs a quantity, a unit price and an income account.
              </span>
            )
          )}
        </div>
      </form>

      <ContactFormDialog
        contact={null}
        open={newCustomerName !== null}
        onOpenChange={(open) => {
          if (!open) setNewCustomerName(null);
        }}
        initialDisplayName={newCustomerName ?? ''}
        initialIsCustomer
        onCreated={(created) => {
          void queryClient.invalidateQueries({ queryKey: CONTACTS_QUERY_KEY });
          edit({ contactId: created.id });
        }}
      />
    </DialogContent>
  );
}
