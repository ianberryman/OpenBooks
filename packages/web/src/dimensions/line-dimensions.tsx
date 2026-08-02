import type { ReactElement } from 'react';

import { Combobox, Field, FieldLabel } from '../components';
import type { ComboboxOption } from '../components';
import type { DimensionAxis } from './axes';
import { valueOnAxis, withAxisValue } from './axes';

/**
 * The per-line dimension tagging panel — the AR/AP editors' equivalent of the journal-entry
 * editor's "Details" expander body, lifted so invoice, credit note, bill and vendor credit
 * share one implementation.
 *
 * Each editor owns the disclosure trigger (a "Dimensions (N)" button, `N =
 * line.dimensionValueIds.length`) and the row/section it expands into, because the table
 * width and card layout differ per screen; this component is only the contents — one
 * `Combobox` per active axis — so the pickers themselves cannot drift across the four
 * documents.
 */

/**
 * The value that means "no selection".
 *
 * `Combobox` commits an option and never the absence of one — Escape restores the current
 * choice and Tab commits nothing — so clearing a tag needs a row to click. `''` is never a
 * real id and is mapped back to `null` the moment it is committed, so the sentinel does not
 * leave this file.
 */
const NONE = '';

function optionValue(value: string): string | null {
  return value === NONE ? null : value;
}

function AxisPicker({
  axis,
  dimensionValueIds,
  index,
  disabled,
  onChange,
}: {
  readonly axis: DimensionAxis;
  readonly dimensionValueIds: readonly string[];
  readonly index: number;
  readonly disabled: boolean;
  readonly onChange: (dimensionValueIds: readonly string[]) => void;
}): ReactElement {
  const selected = valueOnAxis(dimensionValueIds, axis);

  const options: ComboboxOption[] = [
    { value: NONE, label: 'Not tagged' },
    ...axis.values.map((value) => ({
      value: value.id,
      label: value.name,
      detail: value.code,
      // An archived value keeps every line already tagged with it and is not offered for a
      // new tag (OB-037). Offered-but-disabled rather than absent, so a line that already
      // carries one still shows what it is tagged with.
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
          onChange(
            withAxisValue(dimensionValueIds, axis, value === null ? null : optionValue(value)),
          );
        }}
      />
    </Field>
  );
}

export interface LineDimensionFieldsProps {
  readonly axes: readonly DimensionAxis[];
  readonly dimensionValueIds: readonly string[];
  /** One-based line position, for the pickers' `aria-label`s. */
  readonly index: number;
  readonly disabled: boolean;
  /** True while the axes are still loading, to suppress the premature "no dimensions" note. */
  readonly isLoading?: boolean;
  readonly onChange: (dimensionValueIds: readonly string[]) => void;
}

export function LineDimensionFields({
  axes,
  dimensionValueIds,
  index,
  disabled,
  isLoading = false,
  onChange,
}: LineDimensionFieldsProps): ReactElement {
  // An archived axis is hidden unless this line already carries a value on it, so retiring a
  // dimension never silently drops an existing tag (mirrors the journal-entry editor).
  const active = axes.filter(
    (axis) => axis.dimension.isActive || valueOnAxis(dimensionValueIds, axis) !== null,
  );

  return (
    <div className="flex flex-wrap gap-3 rounded-lg border border-border bg-surface-sunken p-3">
      {active.map((axis) => (
        <AxisPicker
          key={axis.dimension.id}
          axis={axis}
          dimensionValueIds={dimensionValueIds}
          index={index}
          disabled={disabled}
          onChange={onChange}
        />
      ))}

      {active.length === 0 && (
        <p className="self-center text-sm text-text-subtle">
          {isLoading ? 'Loading dimensions…' : 'This organization has no reporting dimensions yet.'}
        </p>
      )}
    </div>
  );
}
