import type { ChangeEvent, ReactElement } from 'react';
import { useState } from 'react';

import {
  Button,
  CONTROL_CLASSES,
  Field,
  FieldLabel,
  MoneyInput,
  TextInput,
  useFieldControl,
} from '../../components';
import { cx } from '../../lib/cx';
import { blankStage } from './stage-state';
import type { StageDraft } from './stage-state';

/**
 * The repeatable stage ladder — one row per rung, in the order the engine walks them.
 *
 * ## Why a row has no `stageNumber` field
 *
 * The array's own order is the ladder's order (`stage-state.ts`), so the row exposes
 * "move up" / "move down" instead of a number to type — a typed number is a second way to
 * say the same thing the position already says, and the two could disagree (two rows
 * sharing a number, or a gap) in a way array order cannot.
 *
 * ## Why "days relative to the due date" gets a worked example
 *
 * `offsetDays` accepts negative, zero and positive with no unit in the value itself, and a
 * bare number field invites the same ambiguity a bare "Unit price" would on a tax-inclusive
 * line (`sales/line-row.tsx`'s reason for putting the meaning in the header). The hint below
 * each row's offset field states which direction is which rather than leaving it to the
 * `-3650..3650` range alone to imply.
 */
export interface StageEditorProps {
  readonly stages: readonly StageDraft[];
  /** Keyed by `stages.<index>.<field>` — the dotted path `presentApiError` reports a
   * `validation_failed` issue under (`sales/line-row.tsx`'s `path` pattern). */
  readonly fieldErrors: Readonly<Record<string, string>>;
  readonly disabled: boolean;
  readonly onChange: (stages: readonly StageDraft[]) => void;
}

export function StageEditor({
  stages,
  fieldErrors,
  disabled,
  onChange,
}: StageEditorProps): ReactElement {
  function update(index: number, next: StageDraft): void {
    onChange(stages.map((stage, i) => (i === index ? next : stage)));
  }

  function remove(index: number): void {
    onChange(stages.filter((_stage, i) => i !== index));
  }

  function move(index: number, delta: 1 | -1): void {
    const target = index + delta;
    if (target < 0 || target >= stages.length) return;
    const next = [...stages];
    const moved = next[index];
    const displaced = next[target];
    if (moved === undefined || displaced === undefined) return;
    next[index] = displaced;
    next[target] = moved;
    onChange(next);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        {/* Not `FieldLabel`: that component demands a `Field` ancestor to mint the id it
            labels, and this heading is not attached to a single control — it names the
            list of stage rows below it. */}
        <h3 className="text-sm font-medium text-text">Stages</h3>
        <Button
          size="sm"
          disabled={disabled}
          onClick={() => {
            const last = stages[stages.length - 1];
            onChange([...stages, blankStage(last === undefined ? 7 : last.offsetDays + 7)]);
          }}
        >
          Add stage
        </Button>
      </div>

      {stages.length === 0 && (
        <p className="rounded-lg border border-border bg-surface-sunken p-3 text-sm text-text-muted">
          No stages yet. A policy needs at least one — the engine sends nothing without a rung to
          send from.
        </p>
      )}

      <ol className="flex flex-col gap-3">
        {stages.map((stage, index) => (
          <li
            key={stage.key}
            className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-text-subtle">Stage {index + 1}</span>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled || index === 0}
                  aria-label={`Move stage ${index + 1} up`}
                  onClick={() => {
                    move(index, -1);
                  }}
                >
                  ↑
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled || index === stages.length - 1}
                  aria-label={`Move stage ${index + 1} down`}
                  onClick={() => {
                    move(index, 1);
                  }}
                >
                  ↓
                </Button>
                {/* `ghost`, not `danger` — `sales/line-row.tsx`'s "Remove line" button is
                    the same case: this row has never been saved, so removing it from a
                    ladder still being drafted destroys nothing the way deleting a persisted
                    axis or value does (`button.tsx`'s reason `danger` is reserved). */}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  aria-label={`Remove stage ${index + 1}`}
                  onClick={() => {
                    remove(index);
                  }}
                >
                  Remove
                </Button>
              </div>
            </div>

            <div className="flex flex-wrap gap-3">
              <Field
                className="w-40"
                hint="Days from the due date. Negative is before it, 0 is on it, positive is after."
                error={fieldErrors[`stages.${String(index)}.offsetDays`]}
              >
                <FieldLabel>Send offset</FieldLabel>
                <OffsetDaysInput
                  value={stage.offsetDays}
                  disabled={disabled}
                  onValueChange={(offsetDays) => {
                    update(index, { ...stage, offsetDays });
                  }}
                />
              </Field>

              <Field
                className="w-40"
                hint="Optional. Not yet posted by the engine."
                error={fieldErrors[`stages.${String(index)}.lateFeeMinor`]}
              >
                <FieldLabel>Late fee</FieldLabel>
                <MoneyInput
                  value={stage.lateFeeMinor}
                  disabled={disabled}
                  onValueChange={(lateFeeMinor) => {
                    update(index, { ...stage, lateFeeMinor });
                  }}
                />
              </Field>

              <Field
                className="min-w-64 flex-1"
                error={fieldErrors[`stages.${String(index)}.subject`]}
              >
                <FieldLabel>Subject</FieldLabel>
                <TextInput
                  value={stage.subject}
                  disabled={disabled}
                  onChange={(event) => {
                    update(index, { ...stage, subject: event.target.value });
                  }}
                />
              </Field>
            </div>

            <Field error={fieldErrors[`stages.${String(index)}.body`]}>
              <FieldLabel>Body</FieldLabel>
              <StageBodyTextArea
                value={stage.body}
                disabled={disabled}
                onChange={(event) => {
                  update(index, { ...stage, body: event.target.value });
                }}
              />
            </Field>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * `offsetDays` as a text field with its own draft, for the reason `MoneyInput` keeps one:
 * the canonical form is not a fixed point of typing. A plain controlled `type="number"`
 * input snaps back to the last valid value on every keystroke, which makes typing `"-7"`
 * impossible — the field never has a chance to hold a bare `"-"` — so the draft is
 * committed on blur instead, exactly when the user is done.
 */
function OffsetDaysInput({
  value,
  disabled,
  onValueChange,
}: {
  readonly value: number;
  readonly disabled: boolean;
  readonly onValueChange: (value: number) => void;
}): ReactElement {
  const control = useFieldControl();
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? String(value);

  function parsed(candidate: string): number | null {
    if (!/^-?\d+$/.test(candidate)) return null;
    const asNumber = Number(candidate);
    return asNumber >= -3650 && asNumber <= 3650 ? asNumber : null;
  }

  return (
    <input
      {...control}
      type="text"
      inputMode="numeric"
      autoComplete="off"
      disabled={disabled}
      value={text}
      className={cx(CONTROL_CLASSES, 'border-border text-right font-mono tabular-nums')}
      onChange={(event) => {
        const next = event.target.value;
        setDraft(next);
        const number = parsed(next);
        if (number !== null) onValueChange(number);
      }}
      onBlur={() => {
        setDraft(null);
      }}
    />
  );
}

/** `src/components` has no textarea (D-24 — a component arrives with the screen that needs
 * it), so this is the same small wrapper `contacts/contact-form.tsx` wrote for its notes
 * field: wired through `useFieldControl` rather than a bare `<textarea>`, so a `Field`
 * above it behaves exactly as it does around `TextInput`. */
function StageBodyTextArea({
  value,
  disabled,
  onChange,
}: {
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
}): ReactElement {
  const control = useFieldControl();
  return (
    <textarea
      {...control}
      value={value}
      disabled={disabled}
      rows={4}
      className={cx(CONTROL_CLASSES, 'h-auto border-border py-1.5')}
      onChange={onChange}
    />
  );
}
