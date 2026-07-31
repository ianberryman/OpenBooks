import type { ReactElement } from 'react';

import type { components } from '../../api';
import {
  Button,
  Combobox,
  Field,
  LineItemCombobox,
  MoneyInput,
  TextInput,
  formatMoney,
} from '../../components';
import type { ComboboxOption } from '../../components';
import { cx } from '../../lib/cx';
import type { EditorLine } from './document-state';

type CatalogItem = components['schemas']['CatalogItem'];

/**
 * One document line: what the user enters, and — read-only, in the last three columns —
 * what the server made of it.
 *
 * ## The three amount columns are outputs, never inputs
 *
 * Net, tax and gross come off the response and are never computed here. Tax is rounded
 * per line, twice, and the document's totals are the sums of those rounded lines rather
 * than the rate applied to a sum (D-35); a browser-side copy of that would be a second
 * implementation whose first disagreement would be a cent on a printed invoice. So the
 * columns are stale between an edit and a save, and the editor says so rather than
 * recomputing them — `stale` dims them and the note above the table explains why.
 *
 * ## `unitAmount` has no fixed meaning
 *
 * It is a net price under `exclusive` and a gross one under `inclusive`, and the document
 * decides which (D-35). The column header carries whichever it currently is, because a
 * bare "Unit price" is exactly the ambiguity that makes an inclusive invoice look wrong by
 * the tax amount.
 */
export interface LineRowProps {
  readonly line: EditorLine;
  readonly index: number;
  readonly accountOptions: readonly ComboboxOption[];
  readonly taxRateOptions: readonly ComboboxOption[];
  /** The active sales items this line's description picker suggests (D-CAT-2). */
  readonly catalogItems: readonly CatalogItem[];
  readonly fieldErrors: Readonly<Record<string, string>>;
  readonly stale: boolean;
  readonly disabled: boolean;
  readonly onChange: (line: EditorLine) => void;
  /** Opens the inline create-item dialog, seeded with the typed description. */
  readonly onCreateItem: (typed: string) => void;
  readonly onRemove: () => void;
}

/**
 * A catalog item's defaults applied to a line (D-CAT-2). Each default falls back to what the
 * line already holds, so an item that carries no price or account leaves the ones the user
 * had. `catalogItemId` records the provenance and nothing rereads it.
 */
export function applyCatalogItem(line: EditorLine, item: CatalogItem): EditorLine {
  return {
    ...line,
    description: item.name,
    unitAmount: item.defaultUnitAmount ?? line.unitAmount,
    accountId: item.defaultAccountId ?? line.accountId,
    taxRateId: item.defaultTaxRateId ?? line.taxRateId,
    catalogItemId: item.id,
  };
}

/**
 * The value that means "no selection".
 *
 * `Combobox` commits an option and never the absence of one, so clearing a tax rate needs
 * a row to click. `''` is never a real id and is mapped back to `null` the moment it is
 * committed, so the sentinel does not leave this file.
 */
const NONE = '';

/** Absent or null means *no tax* — never a default rate (D-35). */
export const NO_TAX_RATE: ComboboxOption = { value: NONE, label: 'No tax' };

function optionValue(value: string | null): string | null {
  return value === null || value === NONE ? null : value;
}

function Computed({
  value,
  stale,
}: {
  readonly value: string | null;
  readonly stale: boolean;
}): ReactElement {
  if (value === null) {
    return (
      <span className="font-mono text-sm text-text-subtle" title="Priced when the draft is saved.">
        —
      </span>
    );
  }
  return (
    <span
      className={cx('font-mono text-sm tabular-nums', stale ? 'text-text-subtle' : 'text-text')}
    >
      {formatMoney(value)}
    </span>
  );
}

export function LineRow({
  line,
  index,
  accountOptions,
  taxRateOptions,
  catalogItems,
  fieldErrors,
  stale,
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
            /**
             * `type="text"` with `inputMode="decimal"`, for `MoneyInput`'s reason applied
             * to a multiplier: a number input silently discards what it cannot parse, and
             * a quantity is multiplied by a price before anyone sees the result.
             */
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

      <td className="p-1 pt-3 text-right">
        <Computed value={line.priced?.netAmount ?? null} stale={stale} />
      </td>

      <td className="p-1 pt-3 text-right">
        <Computed value={line.priced?.taxAmount ?? null} stale={stale} />
      </td>

      <td className="p-1 pt-3 text-right">
        <Computed value={line.priced?.grossAmount ?? null} stale={stale} />
      </td>

      <td className="p-1">
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
