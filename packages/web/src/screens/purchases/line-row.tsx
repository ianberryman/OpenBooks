import type { ReactElement } from 'react';

import {
  Button,
  Combobox,
  Field,
  MoneyInput,
  Select,
  TextInput,
  formatMinorUnits,
} from '../../components';
import type { ComboboxOption, SelectOption } from '../../components';
import type { EditorLine, LineProblem } from './editor-state';

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
  /** The server's gross for this line, or `null` when the document is not priced. */
  readonly grossAmount: string | null;
  readonly problem: LineProblem | undefined;
  /** A `validation_failed` message the server keyed to this line's index. */
  readonly serverError: string | undefined;
  readonly disabled: boolean;
  readonly readOnly: boolean;
  readonly onChange: (line: EditorLine) => void;
  readonly onRemove: () => void;
}

export function LineRow({
  line,
  index,
  accountOptions,
  taxRateOptions,
  grossAmount,
  problem,
  serverError,
  disabled,
  readOnly,
  onChange,
  onRemove,
}: LineRowProps): ReactElement {
  const position = String(index + 1);
  const message = serverError ?? (problem === undefined ? undefined : PROBLEM_MESSAGES[problem]);

  return (
    <tr className="align-top">
      <td className="p-1">
        {readOnly ? (
          <span className="text-base text-text">{line.description}</span>
        ) : (
          // `Field` rather than a bare control: `TextInput` reads its id and its
          // `aria-describedby` from the field context and throws without one. The label is
          // the `aria-label` here, because a per-row visible label would repeat the column
          // heading on every line.
          <Field error={message}>
            <TextInput
              aria-label={`Description, line ${position}`}
              value={line.description}
              disabled={disabled}
              onChange={(event) => {
                onChange({ ...line, description: event.target.value });
              }}
            />
          </Field>
        )}
      </td>

      <td className="w-20 p-1">
        {readOnly ? (
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
        )}
      </td>

      <td className="min-w-48 p-1">
        {readOnly ? (
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
        )}
      </td>

      <td className="min-w-36 p-1">
        {readOnly ? (
          <span className="text-base text-text">
            {taxRateOptions.find((option) => option.value === (line.taxRateId ?? NO_TAX_RATE))
              ?.label ?? '—'}
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
        )}
      </td>

      <td className="w-32 p-1">
        {readOnly ? (
          <span className="block text-right font-mono text-base tabular-nums text-text">
            {line.unitAmount === null ? '—' : formatMinorUnits(line.unitAmount)}
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
        )}
      </td>

      <td className="w-32 p-1 text-right">
        <span className="font-mono text-base tabular-nums text-text-muted">
          {grossAmount === null ? '—' : formatMinorUnits(grossAmount)}
        </span>
      </td>

      <td className="w-10 p-1">
        {!readOnly && (
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Remove line ${position}`}
            disabled={disabled}
            onClick={onRemove}
          >
            ✕
          </Button>
        )}
      </td>
    </tr>
  );
}

export { NO_TAX_RATE };
