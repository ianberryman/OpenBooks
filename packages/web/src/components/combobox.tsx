import type { KeyboardEvent, ReactElement } from 'react';
import { useId, useMemo, useRef, useState } from 'react';

import { cx } from '../lib/cx';
import { CONTROL_CLASSES, useFieldControl } from './field';
import { Popover, PopoverAnchor, PopoverContent } from './popover';

/**
 * A filtering combobox — the account picker, the contact picker.
 *
 * ## Why this is hand-built when the rule was "use Radix"
 *
 * Radix has no combobox primitive. D-24 chose Radix for the behaviour that is hard and not
 * the product, and this is the one item on that list it does not cover, so the choice is
 * between writing the keyboard model here or adding a second component library for one
 * control. The keyboard model is about forty lines and is specified by APG; a second
 * library is a second visual language to suppress and a second set of theme escape hatches
 * for `no-raw-color` to police.
 *
 * What is borrowed rather than rewritten is the *positioning and dismissal* — the parts
 * that are genuinely fiddly (collision flipping, scroll containers, outside-pointer and
 * focus-escape handling) — by rendering the listbox inside a Radix Popover anchored to the
 * input.
 *
 * ## The pattern
 *
 * WAI-ARIA APG, editable combobox with list autocomplete: the `<input>` keeps DOM focus at
 * all times and the active option is communicated with `aria-activedescendant`. Moving real
 * focus into the list instead would take it out of the text field, which breaks typing —
 * the mistake that makes hand-built comboboxes unusable with a keyboard.
 */
export interface ComboboxOption {
  readonly value: string;
  readonly label: string;
  /** Secondary text — an account code, a contact's email. Matched on as well as shown. */
  readonly detail?: string;
  readonly disabled?: boolean;
}

/**
 * The inline "create a new one" action a picker can offer (e.g. a new vendor from the bill
 * form). Rendered as the last row of the listbox and reachable by keyboard like any option;
 * choosing it closes the popover and hands the typed text back so the create form prefills
 * its name. The combobox owns none of the creating — that is the caller's dialog — so this
 * stays a picker, not a mini-CRUD screen.
 */
export interface ComboboxCreateAction {
  /** The row's label; receives the current query so it can read `Create "Acme Roasting"`. */
  readonly label: (query: string) => string;
  /** Chosen by pointer or keyboard; receives what the user had typed, for the form to seed. */
  readonly onSelect: (query: string) => void;
}

export interface ComboboxProps {
  readonly value: string | null;
  readonly onValueChange: (value: string | null) => void;
  readonly options: readonly ComboboxOption[];
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly emptyMessage?: string;
  readonly onCreate?: ComboboxCreateAction | undefined;
  /** Only when there is no `<Field>` above — see `useFieldControl`. */
  readonly 'aria-label'?: string;
  readonly className?: string | undefined;
}

/**
 * Case- and diacritic-insensitive substring matching over label and detail.
 *
 * Substring rather than prefix because the chart of accounts is the primary consumer and
 * people search it by the middle of a name ("payable", not "1-2000 Accounts"). Fuzzy
 * matching was rejected: it reorders results in ways that make an account list feel
 * unstable, and picking the wrong account is the expensive mistake here.
 */
function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

function matches(option: ComboboxOption, query: string): boolean {
  if (query === '') return true;
  const needle = normalize(query);
  return (
    normalize(option.label).includes(needle) ||
    (option.detail !== undefined && normalize(option.detail).includes(needle))
  );
}

export function Combobox({
  value,
  onValueChange,
  options,
  placeholder = 'Search…',
  disabled,
  emptyMessage = 'No matches.',
  onCreate,
  className,
  ...rest
}: ComboboxProps): ReactElement {
  const listboxId = useId();
  const optionIdPrefix = useId();
  const control = useFieldControl();
  const inputRef = useRef<HTMLInputElement>(null);

  const [open, setOpen] = useState(false);
  /**
   * `null` means "show the selected option's label"; a string means the user is typing.
   * Two states rather than one, because clearing the box to type must not clear the
   * selection — a user who opens the picker, types, then presses Escape gets the account
   * they already had.
   */
  const [query, setQuery] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const selected = useMemo(
    () => options.find((option) => option.value === value) ?? null,
    [options, value],
  );

  const visible = useMemo(
    () => (query === null ? options : options.filter((option) => matches(option, query))),
    [options, query],
  );

  /**
   * The highlight, clamped once and read by both the `aria-activedescendant` and the
   * row styling below.
   *
   * Clamped because `options` is a prop: OB-051 loads the chart of accounts, so the list
   * can shrink under a highlight that was in range when it was set. Read from one place
   * because the two consumers disagreeing is the failure this component cannot afford —
   * a visible highlight on one row and an announced one on another, differing only for
   * the users who cannot see the first.
   */
  // The create row, when offered, is the last navigable item after the filtered options —
  // reachable by ArrowDown past the list, and always reachable when nothing matches.
  const createIndex = onCreate !== undefined ? visible.length : -1;
  const navCount = visible.length + (onCreate !== undefined ? 1 : 0);
  const activeIndexInView = navCount === 0 ? -1 : Math.min(activeIndex, navCount - 1);
  const onCreateRow = createIndex !== -1 && activeIndexInView === createIndex;
  const activeOption = onCreateRow ? undefined : visible[activeIndexInView];

  function openWith(nextQuery: string | null): void {
    setQuery(nextQuery);
    /**
     * Opening lands on the option already selected; typing lands on the first match.
     *
     * Opening on the first option regardless would make Enter — the reflex at the end of
     * "open the picker, look at it, change my mind" — replace the chosen account with
     * whichever one sorts first in the chart, with the correct label still sitting in the
     * box. Filtering is the other case and wants the top match: the user has just
     * described what they want and the first result is the answer to it.
     */
    const selectedIndex = nextQuery === null && selected !== null ? options.indexOf(selected) : -1;
    setActiveIndex(selectedIndex === -1 ? 0 : selectedIndex);
    setOpen(true);
  }

  function commit(option: ComboboxOption): void {
    if (option.disabled === true) return;
    onValueChange(option.value);
    setQuery(null);
    setOpen(false);
  }

  function triggerCreate(): void {
    if (onCreate === undefined) return;
    const typed = query ?? '';
    setQuery(null);
    setOpen(false);
    onCreate.onSelect(typed);
  }

  function cancel(): void {
    setQuery(null);
    setOpen(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault();
        if (!open) {
          openWith(query);
          return;
        }
        if (navCount === 0) return;
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        // Wrapping, so a long chart of accounts reaches its last entry with one ArrowUp;
        // the create row (when present) is the last stop before it wraps.
        setActiveIndex((current) => (current + delta + navCount) % navCount);
        return;
      }
      case 'Enter': {
        if (!open) return;
        // Only when the listbox is open, so Enter still submits the surrounding form when
        // it is not — a journal-entry form is saved from the keyboard.
        if (onCreateRow) {
          event.preventDefault();
          triggerCreate();
          return;
        }
        if (activeOption === undefined) return;
        event.preventDefault();
        commit(activeOption);
        return;
      }
      case 'Escape': {
        if (!open) return;
        event.preventDefault();
        cancel();
        return;
      }
      case 'Tab': {
        // Tab commits nothing. An unconfirmed highlight is not a choice, and silently
        // selecting one on the way out of the field posts an entry against an account the
        // user never looked at.
        cancel();
        return;
      }
      default:
        return;
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) cancel();
      }}
    >
      <PopoverAnchor asChild>
        <div className={cx('relative', className)}>
          <input
            {...control}
            {...rest}
            ref={inputRef}
            role="combobox"
            type="text"
            autoComplete="off"
            spellCheck={false}
            aria-expanded={open}
            aria-controls={open ? listboxId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={
              !open
                ? undefined
                : onCreateRow
                  ? `${optionIdPrefix}-create`
                  : activeOption !== undefined
                    ? `${optionIdPrefix}-${activeOption.value}`
                    : undefined
            }
            disabled={disabled}
            placeholder={placeholder}
            value={query ?? selected?.label ?? ''}
            onChange={(event) => {
              openWith(event.target.value);
            }}
            onKeyDown={onKeyDown}
            /**
             * Opening on click rather than on focus. Focus arrives from Tab as well, and a
             * listbox that unfurls while the user is tabbing past a field covers the one
             * they are heading for.
             */
            onClick={() => {
              if (!disabled) openWith(query);
            }}
            className={cx(CONTROL_CLASSES, 'border-border')}
          />
        </div>
      </PopoverAnchor>

      <PopoverContent
        /**
         * Focus stays in the input: this is the `aria-activedescendant` pattern, and
         * letting Radix move focus into the panel would take it out of the text field.
         */
        onOpenAutoFocus={(event) => {
          event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
        className="w-[var(--radix-popper-anchor-width)] p-1"
      >
        <ul id={listboxId} role="listbox" className="flex flex-col">
          {visible.length === 0 && onCreate === undefined && (
            <li className="px-2 py-1.5 text-sm text-text-subtle">{emptyMessage}</li>
          )}
          {visible.map((option, index) => (
            <li
              key={option.value}
              id={`${optionIdPrefix}-${option.value}`}
              role="option"
              aria-selected={option.value === value}
              aria-disabled={option.disabled}
              className={cx(
                'flex cursor-default items-baseline justify-between gap-2 rounded-sm px-2 py-1.5',
                'text-base text-text',
                index === activeIndexInView && 'bg-surface-hover',
                option.value === value && 'bg-surface-selected',
                option.disabled === true && 'text-text-subtle',
              )}
              /**
               * `onPointerDown` with `preventDefault`, not `onClick`: a click begins with
               * a mousedown that blurs the input, which closes the popover before the
               * click lands and makes the option unselectable with a mouse.
               */
              onPointerDown={(event) => {
                event.preventDefault();
                commit(option);
              }}
              onPointerMove={() => {
                setActiveIndex(index);
              }}
            >
              <span>{option.label}</span>
              {option.detail !== undefined && (
                <span className="font-mono text-xs text-text-subtle">{option.detail}</span>
              )}
            </li>
          ))}
          {onCreate !== undefined && (
            <li
              id={`${optionIdPrefix}-create`}
              role="option"
              aria-selected={false}
              className={cx(
                'flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5',
                'text-base text-accent',
                visible.length > 0 && 'mt-1 border-t border-border pt-2',
                onCreateRow && 'bg-surface-hover',
              )}
              onPointerDown={(event) => {
                event.preventDefault();
                triggerCreate();
              }}
              onPointerMove={() => {
                setActiveIndex(createIndex);
              }}
            >
              <span aria-hidden>+</span>
              <span>{onCreate.label(query ?? '')}</span>
            </li>
          )}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
