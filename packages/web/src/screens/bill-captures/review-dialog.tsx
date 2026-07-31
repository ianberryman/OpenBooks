import type { FormEvent, ReactElement } from 'react';
import { useId, useMemo, useState } from 'react';

import { newIdempotencyKey, presentApiError } from '../../api';
import { cx } from '../../lib/cx';
import {
  Button,
  Combobox,
  Dialog,
  DialogClose,
  DialogContent,
  ErrorBanner,
  Field,
  FieldError,
  FieldLabel,
  ResponsiveTable,
  Select,
  TextInput,
} from '../../components';
import type { ComboboxOption, SelectOption } from '../../components';
import { LineRow, NO_TAX_RATE } from './line-row';
import { useCreateDraftFromCapture } from './queries';
import type { Bill, DocumentCapture, ReferenceData } from './queries';
import {
  blankLine,
  hasProblems,
  isUntouched,
  problemsIn,
  requestFromState,
  stateFromCapture,
  todayIsoDate,
} from './review-state';
import type { ReviewLine, ReviewState } from './review-state';

/**
 * The review form (OB-189) — confirms an `extracted` capture into a draft bill via
 * `POST .../draft`.
 *
 * ## Why this is not `purchases/document-editor.tsx` with a capture bolted on
 *
 * That editor owns a document's whole lifecycle — draft, save, approve, void — because it
 * edits something that already has an id and can be revisited. This dialog produces
 * exactly one request and is done: there is no draft saved between keystrokes, no
 * `readOnly` state, and nothing computed by the server to blank while the form is dirty
 * (`review-state.ts`'s header). Once `createDraftFromCapture` returns, the object that
 * exists is a `Bill` in `purchases`, and that screen — not this dialog — is where it is
 * edited further, approved, or voided.
 *
 * ## Idempotency
 *
 * One key per submit, minted at the moment the button is pressed (`dimensions.tsx`'s
 * `AxisFormDialog` pattern) rather than bound to a fingerprint: this form has no retry
 * story beyond "the user presses Submit again", and the button disables while the mutation
 * is in flight, so a fresh key per click is exactly one key per intent.
 */
export interface ReviewDialogProps {
  readonly capture: DocumentCapture | null;
  readonly reference: ReferenceData;
  readonly onClose: () => void;
  readonly onCreated: (bill: Bill) => void;
}

function emptyState(): ReviewState {
  return {
    contactId: null,
    issueDate: todayIsoDate(),
    dueDate: '',
    taxMode: 'exclusive',
    reference: '',
    memo: '',
    lines: [blankLine()],
  };
}

export function ReviewDialog({
  capture,
  reference,
  onClose,
  onCreated,
}: ReviewDialogProps): ReactElement {
  const formId = useId();
  const createDraft = useCreateDraftFromCapture();
  const [state, setState] = useState<ReviewState>(emptyState);
  const [seeded, setSeeded] = useState<string | null>(null);

  /**
   * Seeded from the capture the first time this dialog opens for it, rather than in an
   * effect — an effect would also fire while the user is typing and undo their edit
   * (`dimensions.tsx`'s `AxisFormDialog` states the same reasoning for a rename form).
   */
  if (capture !== null && capture.id !== seeded) {
    setSeeded(capture.id);
    setState(stateFromCapture(capture, todayIsoDate()));
    createDraft.reset();
  }
  if (capture === null && seeded !== null) setSeeded(null);

  const vendorOptions = useMemo<ComboboxOption[]>(
    () =>
      reference.vendors.map((vendor) => ({
        value: vendor.id,
        label: vendor.displayName,
        ...(vendor.code === null ? {} : { detail: vendor.code }),
        disabled: !vendor.isActive,
      })),
    [reference.vendors],
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

  const taxRateOptions = useMemo<SelectOption[]>(
    () => [
      // First, and a real choice rather than a placeholder: D-35 gives a line at most one
      // rate and **no default**, because a rate nobody chose is a rate that ends up on a
      // filing.
      { value: NO_TAX_RATE, label: 'No tax' },
      ...reference.taxRates.map((rate) => ({
        value: rate.id,
        label: `${rate.name} (${rate.percentage}%)`,
        disabled: !rate.isActive,
      })),
    ],
    [reference.taxRates],
  );

  const problems = problemsIn(state);
  const presented = createDraft.error === null ? null : presentApiError(createDraft.error);
  const fieldErrors = presented?.fieldErrors ?? {};

  /**
   * Server field messages arrive keyed by the dotted path `ValidationIssue` uses, and the
   * index in `lines.N.…` is an index into the array that was **sent** — which drops the
   * untouched rows (`purchases/document-editor.tsx`'s `serverLineErrors`, same reasoning).
   */
  const serverLineErrors = useMemo(() => {
    const messages = new Map<string, string>();
    let sentIndex = 0;
    for (const line of state.lines) {
      if (isUntouched(line)) continue;
      for (const field of ['description', 'quantity', 'accountId', 'unitAmount', 'taxRateId']) {
        const message = fieldErrors[`lines.${String(sentIndex)}.${field}`];
        if (message !== undefined && !messages.has(line.key)) messages.set(line.key, message);
      }
      sentIndex += 1;
    }
    return messages;
  }, [state.lines, fieldErrors]);

  function edit(next: ReviewState): void {
    setState(next);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (capture === null || hasProblems(problems)) return;
    createDraft.mutate(
      {
        captureId: capture.id,
        body: requestFromState(state),
        idempotencyKey: newIdempotencyKey(),
      },
      {
        onSuccess: (bill) => {
          onCreated(bill);
        },
      },
    );
  }

  return (
    <Dialog
      open={capture !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        title="Review captured bill"
        description={
          'What extraction read off the document. Check the vendor, the dates and every ' +
          'line, then submit to create a draft bill — nothing posts to the ledger until ' +
          'that draft is approved in Purchases.'
        }
        className="max-w-3xl"
        footer={
          <>
            <DialogClose asChild>
              <Button>Cancel</Button>
            </DialogClose>
            <Button variant="primary" type="submit" form={formId} disabled={createDraft.isPending}>
              {createDraft.isPending ? 'Creating draft…' : 'Create draft bill'}
            </Button>
          </>
        }
      >
        <form id={formId} onSubmit={handleSubmit} className="flex flex-col gap-4">
          {capture !== null && capture.status === 'failed' && capture.extractionError !== null && (
            <p
              className={cx(
                'rounded-lg border border-warning-border bg-warning-soft p-3',
                'text-sm text-warning-text',
              )}
            >
              Extraction did not finish: {capture.extractionError}
            </p>
          )}

          {presented !== null && <ErrorBanner error={createDraft.error} />}

          <div className="flex flex-wrap gap-4">
            <Field className="w-64" error={fieldErrors['contactId']}>
              <FieldLabel>Vendor</FieldLabel>
              <Combobox
                value={state.contactId}
                options={vendorOptions}
                disabled={createDraft.isPending}
                emptyMessage="No vendor contacts match. Create one in Contacts first."
                onValueChange={(contactId) => {
                  edit({ ...state, contactId });
                }}
              />
            </Field>

            <Field className="w-40" error={fieldErrors['issueDate']}>
              <FieldLabel>Issue date</FieldLabel>
              <TextInput
                type="date"
                value={state.issueDate}
                disabled={createDraft.isPending}
                onChange={(event) => {
                  edit({ ...state, issueDate: event.target.value });
                }}
              />
            </Field>

            <Field className="w-40" error={fieldErrors['dueDate']} hint="Optional.">
              <FieldLabel>Due date</FieldLabel>
              <TextInput
                type="date"
                value={state.dueDate}
                disabled={createDraft.isPending}
                onChange={(event) => {
                  edit({ ...state, dueDate: event.target.value });
                }}
              />
            </Field>

            <Field
              className="w-64"
              error={fieldErrors['reference']}
              hint="The vendor’s own invoice number, as printed."
            >
              <FieldLabel>Vendor’s invoice number</FieldLabel>
              <TextInput
                value={state.reference}
                disabled={createDraft.isPending}
                onChange={(event) => {
                  edit({ ...state, reference: event.target.value });
                }}
              />
            </Field>

            <Field
              className="w-56"
              hint="Decides what a unit price means, and the server prices the draft from this."
            >
              <FieldLabel>Unit prices</FieldLabel>
              <Select
                value={state.taxMode}
                options={[
                  { value: 'exclusive', label: 'Exclude tax' },
                  { value: 'inclusive', label: 'Include tax' },
                ]}
                disabled={createDraft.isPending}
                onValueChange={(taxMode) => {
                  edit({ ...state, taxMode: taxMode === 'inclusive' ? 'inclusive' : 'exclusive' });
                }}
              />
            </Field>

            <Field className="min-w-64 flex-1" error={fieldErrors['memo']}>
              <FieldLabel>Memo</FieldLabel>
              <TextInput
                value={state.memo}
                disabled={createDraft.isPending}
                onChange={(event) => {
                  edit({ ...state, memo: event.target.value });
                }}
              />
            </Field>
          </div>

          <ResponsiveTable>
            <table className="w-full border-collapse">
              <caption className="sr-only">Bill lines</caption>
              <thead>
                <tr className="text-left text-xs text-text-subtle">
                  <th scope="col" className="p-1 font-medium">
                    Description
                  </th>
                  <th scope="col" className="p-1 text-right font-medium">
                    Quantity
                  </th>
                  <th scope="col" className="p-1 font-medium">
                    Expense account
                  </th>
                  <th scope="col" className="p-1 font-medium">
                    Tax rate
                  </th>
                  <th scope="col" className="p-1 text-right font-medium">
                    Unit price
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
                    taxRateOptions={taxRateOptions}
                    problem={problems.lines.get(line.key)}
                    serverError={serverLineErrors.get(line.key)}
                    disabled={createDraft.isPending}
                    onChange={(next: ReviewLine) => {
                      edit({
                        ...state,
                        lines: state.lines.map((existing) =>
                          existing.key === next.key ? next : existing,
                        ),
                      });
                    }}
                    onRemove={() => {
                      edit({ ...state, lines: state.lines.filter((it) => it.key !== line.key) });
                    }}
                  />
                ))}
              </tbody>
            </table>
          </ResponsiveTable>

          <div>
            <Button
              disabled={createDraft.isPending}
              onClick={() => {
                edit({ ...state, lines: [...state.lines, blankLine()] });
              }}
            >
              Add line
            </Button>
          </div>

          {fieldErrors['lines'] !== undefined && <FieldError>{fieldErrors['lines']}</FieldError>}
          {problems.noLines && <FieldError>Add at least one line.</FieldError>}
          {problems.vendor && <FieldError>Choose the vendor this bill is from.</FieldError>}
        </form>
      </DialogContent>
    </Dialog>
  );
}
