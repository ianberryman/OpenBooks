import type { ReactElement } from 'react';

import { Button, Combobox, Field, MoneyInput, TextInput } from '../../components';
import type { ComboboxOption } from '../../components';
import type { TemplateLineDraft } from './template-state';

/**
 * One template line — `sales/line-row.tsx`, without the three computed amount columns.
 * `RecurringInvoiceLine`'s own description is why: a template line is "not yet a document
 * line", so there is no `netAmount`/`taxAmount`/`grossAmount` to read back and never will
 * be until a cycle materialises it. What is entered here is exactly what is sent.
 */
export interface LineRowProps {
  readonly line: TemplateLineDraft;
  readonly index: number;
  readonly accountOptions: readonly ComboboxOption[];
  readonly taxRateOptions: readonly ComboboxOption[];
  readonly fieldErrors: Readonly<Record<string, string>>;
  readonly disabled: boolean;
  readonly onChange: (line: TemplateLineDraft) => void;
  readonly onRemove: () => void;
}

/**
 * The value that means "no selection" — `sales/line-row.tsx`'s `NONE`/`NO_TAX_RATE`
 * sentinel, for the same reason: `Combobox` commits an option and never the absence of
 * one, so clearing a tax rate needs a real row to click, and `''` is mapped back to `null`
 * the moment it is committed.
 */
const NONE = '';

/** Absent or null means *no tax* — never a default rate (D-35). */
export const NO_TAX_RATE: ComboboxOption = { value: NONE, label: 'No tax' };

function optionValue(value: string | null): string | null {
  return value === null || value === NONE ? null : value;
}

export function LineRow({
  line,
  index,
  accountOptions,
  taxRateOptions,
  fieldErrors,
  disabled,
  onChange,
  onRemove,
}: LineRowProps): ReactElement {
  const path = `lines.${String(index)}`;
  const number = String(index + 1);

  return (
    <tr className="align-top">
      <td className="p-1">
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

      <td className="w-24 p-1">
        <Field error={fieldErrors[`${path}.quantity`]}>
          <TextInput
            aria-label={`Quantity, line ${number}`}
            // `type="text"` with `inputMode="decimal"`: a number input silently discards
            // what it cannot parse, and a quantity is multiplied by a price before anyone
            // sees the result (`MoneyInput`'s reason, applied to a multiplier).
            inputMode="decimal"
            autoComplete="off"
            value={line.quantity}
            disabled={disabled}
            className="text-right font-mono tabular-nums"
            onChange={(event) => {
              onChange({ ...line, quantity: event.target.value });
            }}
          />
        </Field>
      </td>

      <td className="w-32 p-1">
        <Field error={fieldErrors[`${path}.unitAmount`]}>
          <MoneyInput
            aria-label={`Unit price, line ${number}`}
            value={line.unitAmount}
            disabled={disabled}
            onValueChange={(value) => {
              onChange({ ...line, unitAmount: value });
            }}
          />
        </Field>
      </td>

      <td className="min-w-48 p-1">
        <Field error={fieldErrors[`${path}.accountId`]}>
          <Combobox
            aria-label={`Income account, line ${number}`}
            options={accountOptions}
            value={line.accountId}
            disabled={disabled}
            placeholder="Search income accounts…"
            onValueChange={(value) => {
              onChange({ ...line, accountId: value });
            }}
          />
        </Field>
      </td>

      <td className="min-w-40 p-1">
        <Field error={fieldErrors[`${path}.taxRateId`]}>
          <Combobox
            aria-label={`Tax rate, line ${number}`}
            options={taxRateOptions}
            value={line.taxRateId}
            disabled={disabled}
            placeholder="No tax"
            onValueChange={(value) => {
              onChange({ ...line, taxRateId: optionValue(value) });
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
