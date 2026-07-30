import type { ReactElement } from 'react';

import { Button, Combobox, Field, MoneyInput, TextInput } from '../../components';
import type { ComboboxOption } from '../../components';
import { withAmount } from './template-state';
import type { TemplateLineDraft } from './template-state';

/**
 * One template line: account, debit, credit, contact and description —
 * `journal-entry/line-row.tsx`'s debit/credit pair over `recurring-invoices/line-row.tsx`'s
 * layout, because a `RecurringJournalLine` is a plain posting instruction rather than a
 * priced document line: there is no quantity, no unit amount and no tax rate to pick, only
 * what each cycle posts verbatim.
 *
 * Two amount columns, one `side` — the model stores a side and one non-negative amount,
 * because the side carries the sign and a negative credit is a caller that has confused
 * the two models (`RecurringJournalLineInput`). The *form* is the debit/credit pair every
 * bookkeeper reads, so typing into one column moves the line to that side rather than
 * giving it two amounts (`withAmount` in `template-state.ts`).
 */
export interface LineRowProps {
  readonly line: TemplateLineDraft;
  readonly index: number;
  readonly accountOptions: readonly ComboboxOption[];
  readonly contactOptions: readonly ComboboxOption[];
  readonly fieldErrors: Readonly<Record<string, string>>;
  readonly disabled: boolean;
  readonly onChange: (line: TemplateLineDraft) => void;
  readonly onRemove: () => void;
}

/**
 * The value that means "no selection" — `journal-entry/line-row.tsx`'s `NONE` sentinel,
 * for the same reason: `Combobox` commits an option and never the absence of one, so
 * clearing a contact needs a real row to click, and `''` is mapped back to `null` the
 * moment it is committed.
 */
const NONE = '';

/** Absent or null means *no contact* — offered as a real row so a chosen one can be cleared. */
export const NO_CONTACT: ComboboxOption = { value: NONE, label: 'No contact' };

function optionValue(value: string): string | null {
  return value === NONE ? null : value;
}

function CellError({ message }: { readonly message: string | undefined }): ReactElement | null {
  return message === undefined ? null : (
    <p role="alert" className="mt-1 text-xs text-danger-text">
      {message}
    </p>
  );
}

export function LineRow({
  line,
  index,
  accountOptions,
  contactOptions,
  fieldErrors,
  disabled,
  onChange,
  onRemove,
}: LineRowProps): ReactElement {
  const path = `lines.${String(index)}`;
  const number = String(index + 1);
  const amountError = fieldErrors[`${path}.amount`] ?? fieldErrors[`${path}.side`];
  // On the side the amount is on, so the message sits under the box that holds the value
  // it is about; a line with no side yet has nothing but the debit box to point at.
  const amountSide = line.side ?? 'debit';

  return (
    <tr className="align-top">
      <td className="min-w-48 p-1">
        <Field error={fieldErrors[`${path}.accountId`]}>
          <Combobox
            aria-label={`Account, line ${number}`}
            options={accountOptions}
            value={line.accountId}
            disabled={disabled}
            placeholder="Search accounts…"
            onValueChange={(value) => {
              onChange({ ...line, accountId: value });
            }}
          />
        </Field>
      </td>

      <td className="w-32 p-1">
        <MoneyInput
          aria-label={`Debit, line ${number}`}
          value={line.side === 'debit' ? line.amount : null}
          disabled={disabled}
          onValueChange={(value) => {
            onChange(withAmount(line, 'debit', value));
          }}
        />
        {amountSide === 'debit' && <CellError message={amountError} />}
      </td>

      <td className="w-32 p-1">
        <MoneyInput
          aria-label={`Credit, line ${number}`}
          value={line.side === 'credit' ? line.amount : null}
          disabled={disabled}
          onValueChange={(value) => {
            onChange(withAmount(line, 'credit', value));
          }}
        />
        {amountSide === 'credit' && <CellError message={amountError} />}
      </td>

      <td className="min-w-40 p-1">
        <Field error={fieldErrors[`${path}.contactId`]}>
          <Combobox
            aria-label={`Contact, line ${number}`}
            options={contactOptions}
            value={line.contactId}
            disabled={disabled}
            placeholder="None"
            onValueChange={(value) => {
              onChange({ ...line, contactId: value === null ? null : optionValue(value) });
            }}
          />
        </Field>
      </td>

      <td className="min-w-48 p-1">
        <Field error={fieldErrors[`${path}.description`]}>
          <TextInput
            aria-label={`Description, line ${number}`}
            value={line.description}
            disabled={disabled}
            onChange={(event) => {
              onChange({ ...line, description: event.target.value });
            }}
          />
        </Field>
      </td>

      <td className="p-1 pt-3">
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Remove line ${number}`}
          disabled={disabled}
          onClick={onRemove}
        >
          ×
        </Button>
      </td>
    </tr>
  );
}
