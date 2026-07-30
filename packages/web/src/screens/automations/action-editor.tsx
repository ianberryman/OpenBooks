import type { ChangeEvent, ReactElement } from 'react';

import {
  Button,
  CONTROL_CLASSES,
  Field,
  FieldLabel,
  TextInput,
  useFieldControl,
} from '../../components';
import { cx } from '../../lib/cx';
import { blankAgentTaskAction, blankAnnotateAction } from './automation-state';
import type { ActionDraft } from './automation-state';

/**
 * The repeatable action list — one row per step, in the order the engine runs them
 * (`AutomationActions`' own words: "Actions run in list order"). `dunning/stage-editor.tsx`'s
 * shape: no numbering field on a row, because the array's own position is the ordering, and
 * "move up" / "move down" instead of a typed number rules out the duplicate-or-gap a number
 * field could produce.
 *
 * Unlike a dunning stage, an action is a discriminated union with two distinct shapes, so
 * there is no single "Add" button — one per type (`annotate`, `agent_task`), each seeding
 * the blank row its own wire shape needs. A row's type is fixed once added; there is no
 * control to convert an existing `annotate` row into an `agent_task` one, because the two
 * carry no field in common for a conversion to preserve.
 */
export interface ActionEditorProps {
  readonly actions: readonly ActionDraft[];
  /** Keyed by `actions.<index>.<field>` — the dotted path `presentApiError` reports a
   * `validation_failed` issue under (`sales/line-row.tsx`'s `path` pattern). */
  readonly fieldErrors: Readonly<Record<string, string>>;
  readonly disabled: boolean;
  readonly onChange: (actions: readonly ActionDraft[]) => void;
}

export function ActionEditor({
  actions,
  fieldErrors,
  disabled,
  onChange,
}: ActionEditorProps): ReactElement {
  function update(index: number, next: ActionDraft): void {
    onChange(actions.map((action, i) => (i === index ? next : action)));
  }

  function remove(index: number): void {
    onChange(actions.filter((_action, i) => i !== index));
  }

  function move(index: number, delta: 1 | -1): void {
    const target = index + delta;
    if (target < 0 || target >= actions.length) return;
    const next = [...actions];
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
            labels, and this heading names the list of action rows below it, not a single
            control — `dunning/stage-editor.tsx`'s same reasoning. */}
        <h3 className="text-sm font-medium text-text">Actions</h3>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            disabled={disabled}
            onClick={() => {
              onChange([...actions, blankAnnotateAction()]);
            }}
          >
            Add annotate
          </Button>
          <Button
            size="sm"
            disabled={disabled}
            onClick={() => {
              onChange([...actions, blankAgentTaskAction()]);
            }}
          >
            Add agent task
          </Button>
        </div>
      </div>

      {actions.length === 0 && (
        <p className="rounded-lg border border-border bg-surface-sunken p-3 text-sm text-text-muted">
          No actions yet. An automation needs at least one — nothing runs without a step to run.
        </p>
      )}

      <ol className="flex flex-col gap-3">
        {actions.map((action, index) => (
          <li
            key={action.key}
            className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-text-subtle">
                {index + 1}. {action.type === 'annotate' ? 'Annotate' : 'Agent task'}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled || index === 0}
                  aria-label={`Move action ${index + 1} up`}
                  onClick={() => {
                    move(index, -1);
                  }}
                >
                  ↑
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled || index === actions.length - 1}
                  aria-label={`Move action ${index + 1} down`}
                  onClick={() => {
                    move(index, 1);
                  }}
                >
                  ↓
                </Button>
                {/* `ghost`, not `danger` — `dunning/stage-editor.tsx`'s "Remove stage" is
                    the same case: this row has never been saved, so removing it from an
                    automation still being drafted destroys nothing the way deleting a
                    persisted one does (`button.tsx`'s reason `danger` is reserved). */}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  aria-label={`Remove action ${index + 1}`}
                  onClick={() => {
                    remove(index);
                  }}
                >
                  Remove
                </Button>
              </div>
            </div>

            {action.type === 'annotate' ? (
              <Field error={fieldErrors[`actions.${String(index)}.note`]}>
                <FieldLabel>Note</FieldLabel>
                <TextInput
                  value={action.note}
                  disabled={disabled}
                  placeholder="What this firing records"
                  onChange={(event) => {
                    update(index, { ...action, note: event.target.value });
                  }}
                />
              </Field>
            ) : (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                <Field
                  className="min-w-64 flex-1"
                  error={fieldErrors[`actions.${String(index)}.prompt`]}
                >
                  <FieldLabel>Prompt</FieldLabel>
                  <AgentTaskPromptTextArea
                    value={action.prompt}
                    disabled={disabled}
                    onChange={(event) => {
                      update(index, { ...action, prompt: event.target.value });
                    }}
                  />
                </Field>
                <Field
                  className="w-48"
                  error={fieldErrors[`actions.${String(index)}.sourceKind`]}
                  hint="Carried onto the work item."
                >
                  <FieldLabel>Source kind</FieldLabel>
                  <TextInput
                    value={action.sourceKind}
                    disabled={disabled}
                    onChange={(event) => {
                      update(index, { ...action, sourceKind: event.target.value });
                    }}
                  />
                </Field>
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** `src/components` has no textarea (D-24 — a component arrives with the screen that needs
 * it), so this is the same small wrapper `dunning/stage-editor.tsx`'s `StageBodyTextArea`
 * writes: wired through `useFieldControl` rather than a bare `<textarea>`, so a `Field`
 * above it behaves exactly as it does around `TextInput`. */
function AgentTaskPromptTextArea({
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
      rows={3}
      className={cx(CONTROL_CLASSES, 'h-auto border-border py-1.5')}
      onChange={onChange}
    />
  );
}
