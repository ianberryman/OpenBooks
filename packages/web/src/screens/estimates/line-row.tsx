import type { ReactElement } from 'react';

import type { components } from '../../api';
import { Button, Combobox, Field, LineItemCombobox, MoneyInput, TextInput } from '../../components';
import type { ComboboxOption } from '../../components';
import type { EstimateLineDraft } from './estimate-state';

type CatalogItem = components['schemas']['CatalogItem'];

/**
 * A catalog item's defaults applied to an estimate line (D-CAT-2). Each default falls back to
 * what the line already holds; `catalogItemId` records the provenance and nothing rereads it.
 * The estimate line holds its price as `unitAmountMinor`.
 */
export function applyCatalogItem(line: EstimateLineDraft, item: CatalogItem): EstimateLineDraft {
  return {
    ...line,
    description: item.name,
    unitAmountMinor: item.defaultUnitAmount ?? line.unitAmountMinor,
    accountId: item.defaultAccountId ?? line.accountId,
    catalogItemId: item.id,
  };
}

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
  /** The active sales items this line's description picker suggests (D-CAT-2). */
  readonly catalogItems: readonly CatalogItem[];
  readonly fieldErrors: Readonly<Record<string, string>>;
  readonly disabled: boolean;
  readonly onChange: (line: EstimateLineDraft) => void;
  /** Opens the inline create-item dialog, seeded with the typed description. */
  readonly onCreateItem: (typed: string) => void;
  readonly onRemove: () => void;
}

export function LineRow({
  line,
  index,
  accountOptions,
  catalogItems,
  fieldErrors,
  disabled,
  onChange,
  onCreateItem,
  onRemove,
}: LineRowProps): ReactElement {
  const path = `lines.${String(index)}`;
  const number = String(index + 1);

  return (
    <tr className="align-top">
      <td className="p-1">
        <Field error={fieldErrors[`${path}.description`]}>
          <LineItemCombobox
            aria-label={`Description, line ${number}`}
            value={line.description}
            items={catalogItems}
            disabled={disabled}
            onValueChange={(text) => {
              onChange({ ...line, description: text });
            }}
            onItemSelect={(item) => {
              onChange(applyCatalogItem(line, item));
            }}
            onCreate={onCreateItem}
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
