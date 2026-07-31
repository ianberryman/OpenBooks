import type { KeyboardEvent, ReactElement } from 'react';
import { useId, useMemo, useRef, useState } from 'react';

import type { components } from '../api';
import { cx } from '../lib/cx';
import { CONTROL_CLASSES, useFieldControl } from './field';
import { Popover, PopoverAnchor, PopoverContent } from './popover';

type CatalogItem = components['schemas']['CatalogItem'];

/**
 * A line-description field that offers catalog items as suggestions (initiative Catalog,
 * D-CAT-2).
 *
 * ## Why this is not `Combobox`
 *
 * `Combobox` is a *closed-list* control: its input shows the selected option's label, and
 * committing an option replaces the text. Four hundred tests and every account/tax picker
 * rest on those semantics, so this is a separate component rather than a flag on that one.
 *
 * A line description is the opposite. The input **is** the description — free text the user
 * types — and a catalog item is a convenience that seeds the description, price, account and
 * tax without binding the line to it (D-CAT-2). So there is no "selected label" state here:
 * `value` is always what the input shows, typing is free-text (`onValueChange`), and
 * choosing a suggestion is a *separate* signal (`onItemSelect`) the parent turns into an
 * autofill — it never routes through `onValueChange`.
 *
 * The keyboard model is `combobox.tsx`'s, for the reason that file gives: WAI-ARIA APG's
 * editable combobox with list autocomplete keeps DOM focus on the `<input>` and names the
 * active row with `aria-activedescendant`. The one deliberate difference is Enter: with no
 * open list — or an open list with nothing highlighted — Enter is left to the surrounding
 * form, because a line grid is saved from the keyboard and a free-text field that ate every
 * Enter would strand the user in the field they are most likely standing in.
 */
export interface LineItemComboboxProps {
  /** The line description, controlled. The input always shows exactly this. */
  readonly value: string;
  /** Free-text typing. A suggestion being chosen does **not** call this. */
  readonly onValueChange: (text: string) => void;
  /** The active items of this line's direction, provided by the parent editor. */
  readonly items: readonly CatalogItem[];
  /** A suggestion was chosen; the parent applies its defaults to the line. */
  readonly onItemSelect: (item: CatalogItem) => void;
  /** Offers a trailing "Create …" row that hands back the typed text to seed a new item. */
  readonly onCreate?: ((typed: string) => void) | undefined;
  readonly disabled?: boolean;
  readonly placeholder?: string;
  readonly emptyMessage?: string;
  /** Only when there is no `<Field>` above — see `useFieldControl`. */
  readonly 'aria-label'?: string;
  readonly className?: string | undefined;
}

/**
 * Case- and diacritic-insensitive substring matching — `combobox.tsx`'s `normalize`, for
 * the same reason: people search a catalog by the middle of a name, not its prefix.
 */
function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

function matches(item: CatalogItem, query: string): boolean {
  if (query === '') return true;
  const needle = normalize(query);
  return (
    normalize(item.name).includes(needle) ||
    (item.code !== null && normalize(item.code).includes(needle))
  );
}

export function LineItemCombobox({
  value,
  onValueChange,
  items,
  onItemSelect,
  onCreate,
  disabled,
  placeholder,
  emptyMessage = 'No matching items.',
  className,
  ...rest
}: LineItemComboboxProps): ReactElement {
  const listboxId = useId();
  const optionIdPrefix = useId();
  const control = useFieldControl();
  const inputRef = useRef<HTMLInputElement>(null);

  const [open, setOpen] = useState(false);
  /**
   * `-1` means "nothing highlighted", which is the resting state after every keystroke — so
   * Enter falls through to the form until the user has actually arrowed onto a row. A real
   * index is only set by ArrowUp/ArrowDown or a pointer hover.
   */
  const [activeIndex, setActiveIndex] = useState(-1);

  const trimmed = value.trim();
  const createVisible = onCreate !== undefined && trimmed !== '';

  // The query is the description itself — there is no separate typing state, because the
  // input is never showing anything other than `value`.
  const visible = useMemo(() => items.filter((item) => matches(item, value)), [items, value]);

  const createIndex = createVisible ? visible.length : -1;
  const navCount = visible.length + (createVisible ? 1 : 0);
  const activeIndexInView =
    activeIndex < 0 || navCount === 0 ? -1 : Math.min(activeIndex, navCount - 1);
  const onCreateRow = createIndex !== -1 && activeIndexInView === createIndex;
  const activeItem =
    onCreateRow || activeIndexInView === -1 ? undefined : visible[activeIndexInView];

  function select(item: CatalogItem): void {
    onItemSelect(item);
    setActiveIndex(-1);
    setOpen(false);
  }

  function triggerCreate(): void {
    if (onCreate === undefined) return;
    setActiveIndex(-1);
    setOpen(false);
    onCreate(value);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        if (!open) {
          setOpen(true);
          setActiveIndex(navCount === 0 ? -1 : 0);
          return;
        }
        if (navCount === 0) return;
        setActiveIndex((current) => (current < 0 ? 0 : (current + 1) % navCount));
        return;
      }
      case 'ArrowUp': {
        event.preventDefault();
        if (!open) {
          setOpen(true);
          setActiveIndex(navCount === 0 ? -1 : navCount - 1);
          return;
        }
        if (navCount === 0) return;
        setActiveIndex((current) =>
          current < 0 ? navCount - 1 : (current - 1 + navCount) % navCount,
        );
        return;
      }
      case 'Enter': {
        // Left to the surrounding form when the popup is closed, when nothing is highlighted,
        // and when the highlight is a real suggestion the user has not confirmed — only a
        // deliberate Arrow-then-Enter chooses one. This is what keeps a line grid keyboard-savable.
        if (!open) return;
        if (onCreateRow) {
          event.preventDefault();
          triggerCreate();
          return;
        }
        if (activeItem === undefined) return;
        event.preventDefault();
        select(activeItem);
        return;
      }
      case 'Escape': {
        if (!open) return;
        event.preventDefault();
        setActiveIndex(-1);
        setOpen(false);
        return;
      }
      case 'Tab': {
        // Tab chooses nothing — the description the user typed stands, and the highlight is
        // discarded exactly as `Combobox`'s is. No `preventDefault`: focus must still leave.
        setActiveIndex(-1);
        setOpen(false);
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
        if (!next) {
          setActiveIndex(-1);
          setOpen(false);
        }
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
                  : activeItem !== undefined
                    ? `${optionIdPrefix}-${activeItem.id}`
                    : undefined
            }
            disabled={disabled}
            placeholder={placeholder}
            value={value}
            onChange={(event) => {
              onValueChange(event.target.value);
              setActiveIndex(-1);
              setOpen(true);
            }}
            onKeyDown={onKeyDown}
            onClick={() => {
              if (!disabled) setOpen(true);
            }}
            className={cx(CONTROL_CLASSES, 'border-border')}
          />
        </div>
      </PopoverAnchor>

      <PopoverContent
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
          {visible.length === 0 && !createVisible && (
            <li className="px-2 py-1.5 text-sm text-text-subtle">{emptyMessage}</li>
          )}
          {visible.map((item, index) => (
            <li
              key={item.id}
              id={`${optionIdPrefix}-${item.id}`}
              role="option"
              aria-selected={index === activeIndexInView}
              className={cx(
                'flex cursor-default items-baseline justify-between gap-2 rounded-sm px-2 py-1.5',
                'text-base text-text',
                index === activeIndexInView && 'bg-surface-hover',
              )}
              onPointerDown={(event) => {
                // `onPointerDown` with `preventDefault`, not `onClick`: a click's mousedown
                // blurs the input and dismisses the popup before the click lands.
                event.preventDefault();
                select(item);
              }}
              onPointerMove={() => {
                setActiveIndex(index);
              }}
            >
              <span>{item.name}</span>
              {item.code !== null && (
                <span className="font-mono text-xs text-text-subtle">{item.code}</span>
              )}
            </li>
          ))}
          {createVisible && (
            <li
              id={`${optionIdPrefix}-create`}
              role="option"
              aria-selected={onCreateRow}
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
              <span>Create &ldquo;{trimmed}&rdquo;</span>
            </li>
          )}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
