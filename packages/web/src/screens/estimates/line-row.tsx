import type { ReactElement, ReactNode } from 'react';

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

/** One field of the compact card: a visible label above the control the table left to a `th`. */
function CardField({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-text-subtle">{label}</span>
      {children}
    </div>
  );
}

/**
 * The compact (`< md`) presentation of one line: a stacked card, so the four-column entry
 * row `LineRow` renders becomes full-width fields instead (mirrors `sales/line-row.tsx`'s
 * `LineCard`, minus the tax-rate field and the computed net/tax/gross line that estimate
 * lines have neither of — see this file's header). It takes the identical `LineRowProps`
 * `LineRow` does, so the two presentations cannot drift on a handler or an `aria-label`.
 */
export function LineCard({
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
    <li className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-text-subtle">Line {number}</span>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Remove line ${number}`}
          disabled={disabled}
          onClick={onRemove}
        >
          ×
        </Button>
      </div>

      <CardField label="Description">
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
      </CardField>

      <div className="flex gap-2">
        <div className="w-24">
          <CardField label="Qty">
            <Field error={fieldErrors[`${path}.quantity`]}>
              <TextInput
                aria-label={`Quantity, line ${number}`}
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
          </CardField>
        </div>
        <div className="flex-1">
          <CardField label="Unit price">
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
          </CardField>
        </div>
      </div>

      <CardField label="Account">
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
      </CardField>
    </li>
  );
}
