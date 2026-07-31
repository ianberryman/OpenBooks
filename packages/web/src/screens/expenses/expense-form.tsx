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
  FieldError,
  FieldLabel,
  MoneyInput,
  ResponsiveTable,
  TextInput,
  formatMoney,
} from '../../components';
import type { ComboboxOption } from '../../components';
import {
  blankFormState,
  blankLine,
  fingerprintOf,
  hasProblems,
  problemMessage,
  problemsIn,
  stateFromExpense,
  toCreateRequest,
  toUpdateRequest,
} from './expense-state';
import type { ExpenseFormState, ExpenseLine } from './expense-state';
import {
  EMPLOYEE_CONTACTS_QUERY_KEY,
  useCreateExpense,
  useExpense,
  useIntentKey,
  useUpdateExpense,
} from './queries';
import type { Bill, ExpenseReferenceData } from './queries';
import { ContactFormDialog } from '../contacts/contact-form';

/**
 * The create/edit dialog for a draft expense (D-M1, D-M2).
 *
 * ## Why this only ever edits a draft
 *
 * `updateExpense` answers `document_approved` for anything past `draft` ("the correction
 * is a vendor credit or a void, never an edit", D-38), and this screen's list only ever
 * offers Edit on a draft row (`list.tsx`) — so `expense` here, when not `null`, is always
 * a draft. There is consequently no read-only rendering path in this form at all, unlike
 * `purchases/document-editor.tsx`, which reuses one editor across every status.
 *
 * ## Why editing re-fetches rather than reusing the list row
 *
 * `BillSummary` — what the list holds — carries no `lines`. Opening this dialog for an
 * existing expense is keyed off its id and fetches the full `Bill` (`useExpense`), the
 * same split `purchases.tsx` makes between `BillSummary` and `Bill` for the same reason.
 */
export interface ExpenseFormDialogProps {
  /** `null` creates; an id edits that expense once it has loaded. */
  readonly expenseId: string | null;
  readonly reference: ExpenseReferenceData;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function ExpenseFormDialog({
  expenseId,
  reference,
  open,
  onOpenChange,
}: ExpenseFormDialogProps): ReactElement {
  const existing = useExpense(expenseId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open &&
        (expenseId !== null && existing.expense === null ? (
          <DialogContent
            title="Edit expense"
            footer={
              <DialogClose asChild>
                <Button>Close</Button>
              </DialogClose>
            }
          >
            {existing.error != null ? (
              <ErrorBanner error={existing.error} onRetry={existing.refetch} />
            ) : (
              <p className="text-text-subtle">Loading the expense…</p>
            )}
          </DialogContent>
        ) : (
          <ExpenseFormContent
            // Keyed on the expense, so a second "Edit" starts from that row's own values
            // rather than from whichever expense the dialog last held.
            key={expenseId ?? 'new'}
            expense={existing.expense}
            reference={reference}
            onDone={() => {
              onOpenChange(false);
            }}
          />
        ))}
    </Dialog>
  );
}

function ExpenseFormContent({
  expense,
  reference,
  onDone,
}: {
  readonly expense: Bill | null;
  readonly reference: ExpenseReferenceData;
  readonly onDone: () => void;
}): ReactElement {
  const formId = useId();
  const [state, setState] = useState<ExpenseFormState>(() =>
    expense === null ? blankFormState() : stateFromExpense(expense),
  );

  const create = useCreateExpense();
  const update = useUpdateExpense();
  const intentKey = useIntentKey();
  const queryClient = useQueryClient();
  // Inline employee creation from the picker: the typed name, or null when the form is shut.
  const [newEmployeeName, setNewEmployeeName] = useState<string | null>(null);

  const pending = create.isPending || update.isPending;
  const error: unknown = create.error ?? update.error;
  const fieldErrors = presentApiError(error).fieldErrors;

  function edit(next: Partial<ExpenseFormState>): void {
    setState((current) => ({ ...current, ...next }));
  }

  function editLine(key: string, next: Partial<ExpenseLine>): void {
    setState((current) => ({
      ...current,
      lines: current.lines.map((line) => (line.key === key ? { ...line, ...next } : line)),
    }));
  }

  const employeeOptions = useMemo<ComboboxOption[]>(
    () =>
      reference.employees.map((employee) => ({
        value: employee.id,
        label: employee.displayName,
        ...(employee.code === null ? {} : { detail: employee.code }),
        disabled: !employee.isActive,
      })),
    [reference.employees],
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

  const problems = problemsIn(state);
  const complete = !hasProblems(problems);

  /** The server's gross for a line, matched by the id it came back with — blank while the
   *  form is unsaved or has been edited since, `purchases/document-editor.tsx`'s reason:
   *  a browser-side recomputation of per-line tax arithmetic (D-35) would be a second one. */
  const grossByLineKey = useMemo(() => {
    const gross = new Map<string, string>();
    for (const line of expense?.lines ?? []) gross.set(line.lineId, line.grossAmount);
    return gross;
  }, [expense]);

  function submit(): void {
    if (!complete) return;

    if (expense === null) {
      const body = toCreateRequest(state);
      create.mutate(
        { ...body, idempotencyKey: intentKey(`create:${fingerprintOf(body)}`) },
        { onSuccess: onDone },
      );
      return;
    }

    const patch = toUpdateRequest(state);
    update.mutate(
      {
        expenseId: expense.id,
        patch,
        idempotencyKey: intentKey(`update:${expense.id}:${fingerprintOf(patch)}`),
      },
      { onSuccess: onDone },
    );
  }

  return (
    <DialogContent
      title={expense === null ? 'New expense' : 'Edit expense'}
      description="Reimbursement is Pay Bills settling this same document once it is approved — there is no separate reimbursement step."
      className="max-w-3xl"
      footer={
        <>
          <DialogClose asChild>
            <Button disabled={pending}>Cancel</Button>
          </DialogClose>
          <Button type="submit" form={formId} variant="primary" disabled={pending || !complete}>
            {pending ? 'Saving…' : expense === null ? 'Create draft' : 'Save'}
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
          <Field
            className="min-w-64 flex-1"
            error={fieldErrors['contactId']}
            hint="Only contacts flagged as employees appear here."
          >
            <FieldLabel>Employee</FieldLabel>
            <Combobox
              options={employeeOptions}
              value={state.contactId}
              disabled={pending}
              placeholder="Search employees…"
              emptyMessage="No active employees on file."
              onValueChange={(value) => {
                edit({ contactId: value });
              }}
              onCreate={{
                label: (q) => (q.trim() === '' ? 'New employee' : `Create "${q.trim()}"`),
                onSelect: (q) => {
                  setNewEmployeeName(q.trim());
                },
              }}
            />
          </Field>

          <Field className="w-40" error={fieldErrors['issueDate']}>
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

          <Field className="w-40" error={fieldErrors['dueDate']} hint="Optional.">
            <FieldLabel>Due date</FieldLabel>
            <TextInput
              type="date"
              value={state.dueDate}
              disabled={pending}
              onChange={(event) => {
                edit({ dueDate: event.target.value });
              }}
            />
          </Field>

          <Field className="min-w-64 flex-1" error={fieldErrors['reference']} hint="Optional.">
            <FieldLabel>Reference</FieldLabel>
            <TextInput
              placeholder="e.g. a receipt or claim number"
              value={state.reference}
              disabled={pending}
              onChange={(event) => {
                edit({ reference: event.target.value });
              }}
            />
          </Field>

          <Field className="min-w-64 flex-1" error={fieldErrors['memo']} hint="Optional.">
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
            <caption className="sr-only">Expense lines</caption>
            <thead>
              <tr className="text-left text-xs text-text-subtle">
                <th scope="col" className="p-1 font-medium">
                  Description
                </th>
                <th scope="col" className="p-1 text-right font-medium">
                  Quantity
                </th>
                <th scope="col" className="p-1 font-medium">
                  Account
                </th>
                <th scope="col" className="p-1 text-right font-medium">
                  Unit amount
                </th>
                <th scope="col" className="p-1 text-right font-medium">
                  Line total
                </th>
                <th scope="col" className="p-1 font-medium">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {state.lines.map((line, index) => {
                const position = String(index + 1);
                const problem = problems.lines.get(line.key);
                const message = problem === undefined ? undefined : problemMessage(problem);
                const grossAmount = grossByLineKey.get(line.key) ?? null;

                return (
                  <tr key={line.key} className="align-top">
                    <td className="p-1">
                      <Field error={message}>
                        <TextInput
                          aria-label={`Description, line ${position}`}
                          value={line.description}
                          disabled={pending}
                          onChange={(event) => {
                            editLine(line.key, { description: event.target.value });
                          }}
                        />
                      </Field>
                    </td>
                    <td className="w-20 p-1">
                      <Field>
                        <TextInput
                          aria-label={`Quantity, line ${position}`}
                          inputMode="decimal"
                          className="text-right font-mono tabular-nums"
                          value={line.quantity}
                          disabled={pending}
                          onChange={(event) => {
                            editLine(line.key, { quantity: event.target.value });
                          }}
                        />
                      </Field>
                    </td>
                    <td className="min-w-48 p-1">
                      <Combobox
                        aria-label={`Account, line ${position}`}
                        value={line.accountId}
                        options={accountOptions}
                        disabled={pending}
                        onValueChange={(accountId) => {
                          editLine(line.key, { accountId });
                        }}
                      />
                    </td>
                    <td className="w-32 p-1">
                      <MoneyInput
                        aria-label={`Unit amount, line ${position}`}
                        value={line.unitAmount}
                        disabled={pending}
                        onValueChange={(unitAmount) => {
                          editLine(line.key, { unitAmount });
                        }}
                      />
                    </td>
                    <td className="w-32 p-1 text-right">
                      <span className="font-mono text-base tabular-nums text-text-muted">
                        {grossAmount === null ? '—' : formatMoney(grossAmount)}
                      </span>
                    </td>
                    <td className="w-10 p-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Remove line ${position}`}
                        disabled={pending}
                        onClick={() => {
                          edit({ lines: state.lines.filter((it) => it.key !== line.key) });
                        }}
                      >
                        ✕
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ResponsiveTable>

        <div>
          <Button
            disabled={pending}
            onClick={() => {
              edit({ lines: [...state.lines, blankLine()] });
            }}
          >
            Add line
          </Button>
        </div>

        {fieldErrors['lines'] !== undefined && <FieldError>{fieldErrors['lines']}</FieldError>}
        {problems.noLines && <FieldError>Add at least one line.</FieldError>}
        {problems.employee && <FieldError>Choose the employee this reimburses.</FieldError>}
      </form>

      {/* Inline employee creation: seeded with the typed name and pre-marked an employee (the
          only role a contact here may carry, `contact_is_not_an_employee` otherwise). On
          success the employees list is refetched (its own query key, which useCreateContact's
          `['contacts']` invalidation does not reach) and the new employee selected. */}
      <ContactFormDialog
        contact={null}
        open={newEmployeeName !== null}
        onOpenChange={(next) => {
          if (!next) setNewEmployeeName(null);
        }}
        initialDisplayName={newEmployeeName ?? ''}
        initialIsEmployee
        onCreated={(created) => {
          void queryClient.invalidateQueries({ queryKey: EMPLOYEE_CONTACTS_QUERY_KEY });
          edit({ contactId: created.id });
        }}
      />
    </DialogContent>
  );
}
