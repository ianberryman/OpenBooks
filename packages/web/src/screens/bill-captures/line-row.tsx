import type { ReactElement } from 'react';

import { Button, Combobox, Field, MoneyInput, Select, TextInput } from '../../components';
import type { ComboboxOption, SelectOption } from '../../components';
import type { LineProblem, ReviewLine } from './review-state';

/**
 * One line of the draft bill being reviewed — what extraction read off the document
 * (description, quantity, amount), plus the two fields extraction cannot supply: the
 * expense account and, optionally, the tax rate (`review-state.ts`'s
 * `stateFromCapture`).
 *
 * Modelled on `purchases/line-row.tsx`, minus its read-only, priced-server-total column:
 * this row belongs to a form that has not been saved yet, so there is no server figure to
 * show beside it.
 */
const NO_TAX_RATE = 'none';

const PROBLEM_MESSAGES: Readonly<Record<LineProblem, string>> = {
  description: 'This line needs a description — it is what prints on the bill.',
  account: 'This line needs an expense account to post to.',
  unitAmount: 'This line needs a unit price.',
  quantity: 'This line needs a quantity.',
};

export interface LineRowProps {
  readonly line: ReviewLine;
  readonly index: number;
  readonly accountOptions: readonly ComboboxOption[];
  readonly taxRateOptions: readonly SelectOption[];
  readonly problem: LineProblem | undefined;
  /** A `validation_failed` message the server keyed to this line's index. */
  readonly serverError: string | undefined;
  readonly disabled: boolean;
  readonly onChange: (line: ReviewLine) => void;
  readonly onRemove: () => void;
}

export function LineRow({
  line,
  index,
  accountOptions,
  taxRateOptions,
  problem,
  serverError,
  disabled,
  onChange,
  onRemove,
}: LineRowProps): ReactElement {
  const position = String(index + 1);
  const message = serverError ?? (problem === undefined ? undefined : PROBLEM_MESSAGES[problem]);

  return (
    <tr className="align-top">
      <td className="p-1">
        {/* `Field` rather than a bare control: `TextInput` reads its id and its
            `aria-describedby` from the field context and throws without one. The label is
            the `aria-label` here, because a per-row visible label would repeat the column
            heading on every line. */}
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
      </td>

      <td className="w-20 p-1">
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
      </td>

      <td className="min-w-48 p-1">
        <Combobox
          aria-label={`Expense account, line ${position}`}
          value={line.accountId}
          options={accountOptions}
          disabled={disabled}
          onValueChange={(accountId) => {
            onChange({ ...line, accountId });
          }}
        />
      </td>

      <td className="min-w-36 p-1">
        <Select
          aria-label={`Tax rate, line ${position}`}
          value={line.taxRateId ?? NO_TAX_RATE}
          options={taxRateOptions}
          disabled={disabled}
          onValueChange={(value) => {
            // The sentinel maps back to `null`, which D-35 makes meaningful: no rate at
            // all is not the same as a zero-rated one.
            onChange({ ...line, taxRateId: value === NO_TAX_RATE ? null : value });
          }}
        />
      </td>

      <td className="w-32 p-1">
        <MoneyInput
          aria-label={`Unit price, line ${position}`}
          value={line.unitAmount}
          disabled={disabled}
          onValueChange={(unitAmount) => {
            onChange({ ...line, unitAmount });
          }}
        />
      </td>

      <td className="w-10 p-1">
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Remove line ${position}`}
          disabled={disabled}
          onClick={onRemove}
        >
          ✕
        </Button>
      </td>
    </tr>
  );
}

export { NO_TAX_RATE };
