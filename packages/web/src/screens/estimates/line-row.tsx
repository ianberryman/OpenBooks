import type { ReactElement } from 'react';

import { Button, Combobox, Field, MoneyInput, TextInput } from '../../components';
import type { ComboboxOption } from '../../components';
import type { EstimateLineDraft } from './estimate-state';

/**
 * One estimate line — `recurring-invoices/line-row.tsx`'s shape, minus the tax-rate column:
 * this screen offers no tax-rate picker on a line at all (see `estimate-state.ts`'s file
 * header for why `taxMode` still travels, fixed, regardless), and — per `Predocument
 * LineRequestInput`'s own description (D-M7) — there is no dimension column either.
 */
export interface LineRowProps {
  readonly line: EstimateLineDraft;
  readonly index: number;
  readonly accountOptions: readonly ComboboxOption[];
  readonly fieldErrors: Readonly<Record<string, string>>;
  readonly disabled: boolean;
  readonly onChange: (line: EstimateLineDraft) => void;
  readonly onRemove: () => void;
}

export function LineRow({
  line,
  index,
  accountOptions,
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
            value={line.unitAmountMinor}
            disabled={disabled}
            onValueChange={(value) => {
              onChange({ ...line, unitAmountMinor: value });
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
