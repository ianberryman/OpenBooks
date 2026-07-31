import type { ReactElement, ReactNode } from 'react';

import type { components } from '../../api';
import {
  Button,
  Combobox,
  Field,
  LineItemCombobox,
  MoneyInput,
  Select,
  TextInput,
  formatMoney,
} from '../../components';
import type { ComboboxOption, SelectOption } from '../../components';
import type { EditorLine, LineProblem } from './editor-state';

type CatalogItem = components['schemas']['CatalogItem'];

/**
 * A catalog item's defaults applied to a purchase line (D-CAT-2). Each default falls back to
 * what the line already holds; `catalogItemId` records the provenance and nothing rereads it.
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
 * One document line: what was typed, and what the server made of it.
 *
 * The left half is entry — description, quantity, account, rate, unit price. The right
 * half is the **server's** arithmetic for that line, shown read-only and blanked the
 * moment the document is edited. That blanking is the point of the column: net, tax and
 * gross are computed per line and rounded per line by one implementation (D-35), and a
 * figure recomputed in the browser would be a second one. A stale figure sitting beside an
 * edited price is the same failure wearing a better disguise, so an unpriced line shows a
 * dash rather than the number it used to be.
 *
 * `unitAmount` means different things under the two tax modes and the document decides
 * which (D-35) — the header states it; the row cannot, because the answer is not a
 * property of any one line.
 */
const NO_TAX_RATE = 'none';

const PROBLEM_MESSAGES: Readonly<Record<LineProblem, string>> = {
  description: 'This line needs a description — it is what prints on the document.',
  account: 'This line needs an account to post to.',
  unitAmount: 'This line needs a unit price.',
  quantity: 'This line needs a quantity.',
};

export interface LineRowProps {
  readonly line: EditorLine;
  readonly index: number;
  readonly accountOptions: readonly ComboboxOption[];
  readonly taxRateOptions: readonly SelectOption[];
  /** The active purchase items this line's description picker suggests (D-CAT-2). */
  readonly catalogItems: readonly CatalogItem[];
  /** The server's gross for this line, or `null` when the document is not priced. */
  readonly grossAmount: string | null;
  readonly problem: LineProblem | undefined;
  /** A `validation_failed` message the server keyed to this line's index. */
  readonly serverError: string | undefined;
  readonly disabled: boolean;
  readonly readOnly: boolean;
  readonly onChange: (line: EditorLine) => void;
  /** Opens the inline create-item dialog, seeded with the typed description. */
  readonly onCreateItem: (typed: string) => void;
  readonly onRemove: () => void;
}

/**
 * The controls of one line, produced once and placed either in table cells (`LineRow`,
 * desktop) or in a stacked card (`LineCard`, compact — D-123). Sharing the source is the
 * point: the two presentations cannot drift on an `aria-label`, a handler, or the readOnly
 * blanking, which would be two bugs waiting on which viewport a reader tested.
 */
interface LineControls {
  readonly description: ReactElement;
  readonly quantity: ReactElement;
  readonly account: ReactElement;
  readonly taxRate: ReactElement;
  readonly unitPrice: ReactElement;
  readonly total: ReactElement;
  readonly remove: ReactElement | null;
}

function lineControls({
  line,
  index,
  accountOptions,
  taxRateOptions,
  catalogItems,
  grossAmount,
  problem,
  serverError,
  disabled,
  readOnly,
  onChange,
  onCreateItem,
  onRemove,
}: LineRowProps): LineControls {
  const position = String(index + 1);
  const message = serverError ?? (problem === undefined ? undefined : PROBLEM_MESSAGES[problem]);

  return {
    description: readOnly ? (
      <span className="text-base text-text">{line.description}</span>
    ) : (
      // `Field` rather than a bare control: `TextInput` reads its id and its
      // `aria-describedby` from the field context and throws without one. The label is
      // the `aria-label` here, because a per-row visible label would repeat the column
      // heading on every line.
      <Field error={message}>
        <LineItemCombobox
          aria-label={`Description, line ${position}`}
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
    ),
    quantity: readOnly ? (
      <span className="font-mono text-base text-text">{line.quantity}</span>
    ) : (
      <Field>
        <TextInput
          aria-label={`Quantity, line ${position}`}
          inputMode="decimal"
          className="text-right font-mono tabular-nums"
          value={line.quantity}
          disabled={disabled}
          onChange={(event) => {
            onChange({ ...line, quantity: event.target.value });
          }}
        />
      </Field>
    ),
    account: readOnly ? (
      <span className="text-base text-text">
        {accountOptions.find((option) => option.value === line.accountId)?.label ?? '—'}
      </span>
    ) : (
      <Combobox
        aria-label={`Account, line ${position}`}
        value={line.accountId}
        options={accountOptions}
        disabled={disabled}
        onValueChange={(accountId) => {
          onChange({ ...line, accountId });
        }}
      />
    ),
    taxRate: readOnly ? (
      <span className="text-base text-text">
        {taxRateOptions.find((option) => option.value === (line.taxRateId ?? NO_TAX_RATE))?.label ??
          '—'}
      </span>
    ) : (
      <Select
        aria-label={`Tax rate, line ${position}`}
        value={line.taxRateId ?? NO_TAX_RATE}
        options={taxRateOptions}
        disabled={disabled}
        onValueChange={(value) => {
          // The sentinel maps back to `null`, which D-35 makes meaningful: no rate at
          // all is not the same as a zero-rated one, and a VAT return reports the two
          // separately. Radix has no representation for "no value" in an option, hence
          // the sentinel rather than an empty string, which it warns about.
          onChange({ ...line, taxRateId: value === NO_TAX_RATE ? null : value });
        }}
      />
    ),
    unitPrice: readOnly ? (
      <span className="block text-right font-mono text-base tabular-nums text-text">
        {line.unitAmount === null ? '—' : formatMoney(line.unitAmount)}
      </span>
    ) : (
      <MoneyInput
        aria-label={`Unit price, line ${position}`}
        value={line.unitAmount}
        disabled={disabled}
        onValueChange={(unitAmount) => {
          onChange({ ...line, unitAmount });
        }}
      />
    ),
    total: (
      <span className="font-mono text-base tabular-nums text-text-muted">
        {grossAmount === null ? '—' : formatMoney(grossAmount)}
      </span>
    ),
    remove: readOnly ? null : (
      <Button
        size="sm"
        variant="ghost"
        aria-label={`Remove line ${position}`}
        disabled={disabled}
        onClick={onRemove}
      >
        ✕
      </Button>
    ),
  };
}

export function LineRow(props: LineRowProps): ReactElement {
  const c = lineControls(props);

  return (
    <tr className="align-top">
      <td className="p-1">{c.description}</td>
      <td className="w-20 p-1">{c.quantity}</td>
      <td className="min-w-48 p-1">{c.account}</td>
      <td className="min-w-36 p-1">{c.taxRate}</td>
      <td className="w-32 p-1">{c.unitPrice}</td>
      <td className="w-32 p-1 text-right">{c.total}</td>
      <td className="w-10 p-1">{c.remove}</td>
    </tr>
  );
}

/** One field of the compact card: a visible label above the control the table left to a th. */
function CardField({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-text-subtle">{label}</span>
      {children}
    </div>
  );
}

/**
 * The compact (`< md`) presentation of a line: a stacked card, so a seven-column entry grid
 * that only fits by scrolling sideways on a phone (D-123) becomes full-width fields that
 * fit. Same controls as `LineRow` via `lineControls`, so the two cannot drift.
 */
export function LineCard(props: LineRowProps): ReactElement {
  const c = lineControls(props);
  const position = String(props.index + 1);

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-text-subtle">Line {position}</span>
        {c.remove}
      </div>
      <CardField label="Description">{c.description}</CardField>
      <div className="flex gap-2">
        <div className="w-24">
          <CardField label="Quantity">{c.quantity}</CardField>
        </div>
        <div className="flex-1">
          <CardField label="Unit price">{c.unitPrice}</CardField>
        </div>
      </div>
      <CardField label="Account">{c.account}</CardField>
      <CardField label="Tax rate">{c.taxRate}</CardField>
      <div className="flex items-center justify-between border-t border-border pt-2">
        <span className="text-xs font-medium text-text-subtle">Line total</span>
        {c.total}
      </div>
    </li>
  );
}

export { NO_TAX_RATE };
