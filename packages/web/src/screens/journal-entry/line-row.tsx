import type { ReactElement } from 'react';

import { Button, Combobox, Field, FieldLabel, MoneyInput, TextInput } from '../../components';
import type { ComboboxOption } from '../../components';
import { cx } from '../../lib/cx';
import type { EditorLine } from './draft-state';
import { valueOnAxis, withAmount, withAxisValue } from './draft-state';
import type { DimensionAxis, ReferenceData } from './queries';

/**
 * One journal line, and — behind a disclosure — the memo, the contact's tags, and the
 * dimension values it carries.
 *
 * ## Two amount columns, one `side`
 *
 * The model stores a side and one non-negative amount, because the side carries the
 * sign and a negative credit is a caller that has confused the two models
 * (`JournalLineRequest`). The *form* is the debit/credit pair every bookkeeper reads,
 * so typing into one column moves the line to that side rather than giving it two
 * amounts — `withAmount` in `draft-state.ts`.
 *
 * ## Why the pickers are `Combobox` and the tag pickers are too
 *
 * A chart of accounts is a list the user must filter to use; that is a combobox, and
 * this application has exactly one (`src/components/combobox.tsx`, hand-built because
 * Radix has no primitive for it). The tag pickers are the same control for the same
 * reason — a project axis with two hundred values is not a `Select` — and they sit
 * inline in an expanded row rather than inside a dialog, so no popup is ever opened
 * from inside another one.
 */
export interface LineRowProps {
  readonly line: EditorLine;
  readonly index: number;
  readonly reference: ReferenceData;
  readonly accountOptions: readonly ComboboxOption[];
  readonly contactOptions: readonly ComboboxOption[];
  readonly fieldErrors: Readonly<Record<string, string>>;
  readonly expanded: boolean;
  readonly disabled: boolean;
  readonly onToggleDetail: () => void;
  readonly onChange: (line: EditorLine) => void;
  readonly onRemove: () => void;
}

/**
 * The value that means "no selection".
 *
 * `Combobox` commits an option, never the absence of one — Escape restores what was
 * already chosen and Tab commits nothing — so clearing a contact or a tag needs a row
 * to click. `''` is never a real id, and it is mapped back to `null` the moment it is
 * committed, so the sentinel does not leave this file.
 */
const NONE = '';

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

function TagPicker({
  axis,
  line,
  index,
  disabled,
  onChange,
}: {
  readonly axis: DimensionAxis;
  readonly line: EditorLine;
  readonly index: number;
  readonly disabled: boolean;
  readonly onChange: (line: EditorLine) => void;
}): ReactElement {
  const selected = valueOnAxis(line, axis);

  const options: ComboboxOption[] = [
    { value: NONE, label: 'Not tagged' },
    ...axis.values.map((value) => ({
      value: value.id,
      label: value.name,
      detail: value.code,
      // An archived value keeps every line already tagged with it and is not offered for
      // a new tag (OB-037). Offered-but-disabled rather than absent, so a line that
      // already carries one still shows what it is tagged with.
      disabled: !value.isActive && value.id !== selected,
    })),
  ];

  return (
    <Field className="min-w-48 flex-1">
      <FieldLabel>{axis.dimension.name}</FieldLabel>
      <Combobox
        aria-label={`${axis.dimension.name}, line ${String(index + 1)}`}
        options={options}
        value={selected}
        disabled={disabled}
        placeholder="Not tagged"
        onValueChange={(value) => {
          onChange(withAxisValue(line, axis, value === null ? null : optionValue(value)));
        }}
      />
    </Field>
  );
}

export function LineRow({
  line,
  index,
  reference,
  accountOptions,
  contactOptions,
  fieldErrors,
  expanded,
  disabled,
  onToggleDetail,
  onChange,
  onRemove,
}: LineRowProps): ReactElement {
  const path = `lines.${String(index)}`;
  const amountError = fieldErrors[`${path}.amount`] ?? fieldErrors[`${path}.side`];
  // On the side the amount is on, so the message sits under the box that holds the
  // value it is about; a line with no side yet has nothing but the debit box to point at.
  const amountSide = line.side ?? 'debit';

  /**
   * An archived axis is not offered for new tags, but a line already carrying one of its
   * values must still show it — otherwise retiring an axis silently drops the tag from
   * the line on the next save, which is the one thing D-18's mutable tags must not do.
   */
  const axes = reference.axes.filter(
    (axis) => axis.dimension.isActive || valueOnAxis(line, axis) !== null,
  );

  const tagCount = line.dimensionValueIds.length;

  return (
    <>
      <tr className="align-top">
        <td className="p-1">
          <Field error={fieldErrors[`${path}.accountId`]}>
            <Combobox
              aria-label={`Account, line ${String(index + 1)}`}
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

        <td className="p-1">
          <Field error={fieldErrors[`${path}.contactId`]}>
            <Combobox
              aria-label={`Contact, line ${String(index + 1)}`}
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

        <td className="p-1">
          <MoneyInput
            aria-label={`Debit, line ${String(index + 1)}`}
            value={line.side === 'debit' ? line.amount : null}
            disabled={disabled}
            onValueChange={(value) => {
              onChange(withAmount(line, 'debit', value));
            }}
          />
          {amountSide === 'debit' && <CellError message={amountError} />}
        </td>

        <td className="p-1">
          <MoneyInput
            aria-label={`Credit, line ${String(index + 1)}`}
            value={line.side === 'credit' ? line.amount : null}
            disabled={disabled}
            onValueChange={(value) => {
              onChange(withAmount(line, 'credit', value));
            }}
          />
          {amountSide === 'credit' && <CellError message={amountError} />}
        </td>

        <td className="p-1">
          <Button
            size="sm"
            aria-expanded={expanded}
            aria-label={`Details, line ${String(index + 1)}`}
            onClick={onToggleDetail}
            className="whitespace-nowrap"
          >
            {tagCount === 0 ? 'Details' : `Details (${String(tagCount)})`}
          </Button>
        </td>

        <td className="p-1">
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Remove line ${String(index + 1)}`}
            disabled={disabled}
            onClick={onRemove}
          >
            ×
          </Button>
        </td>
      </tr>

      {expanded && (
        <tr>
          <td colSpan={6} className={cx('p-1 pb-4')}>
            <div className="flex flex-wrap gap-3 rounded-lg border border-border bg-surface-sunken p-3">
              <Field className="min-w-64 flex-1" error={fieldErrors[`${path}.memo`]}>
                <FieldLabel>Line description</FieldLabel>
                <TextInput
                  aria-label={`Description, line ${String(index + 1)}`}
                  value={line.memo}
                  disabled={disabled}
                  onChange={(event) => {
                    onChange({ ...line, memo: event.target.value });
                  }}
                />
              </Field>

              {axes.map((axis) => (
                <TagPicker
                  key={axis.dimension.id}
                  axis={axis}
                  line={line}
                  index={index}
                  disabled={disabled}
                  onChange={onChange}
                />
              ))}

              {axes.length === 0 && (
                <p className="self-center text-sm text-text-subtle">
                  This organization has no reporting dimensions yet.
                </p>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
