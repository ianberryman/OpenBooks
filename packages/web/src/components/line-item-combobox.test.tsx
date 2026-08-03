import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { useState } from 'react';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { components } from '../api';
import { LineItemCombobox } from './line-item-combobox';

type CatalogItem = components['schemas']['CatalogItem'];

/**
 * The one control in `src/components` whose semantics deliberately invert `Combobox`'s: the
 * input is the *description* (free text), and choosing a catalog item is a separate signal
 * the parent turns into an autofill — it must never be routed as typed text. The three
 * things worth pinning are exactly those two channels staying distinct, and Enter falling
 * through to the surrounding form so a line grid stays keyboard-savable.
 */
function item(overrides: Partial<CatalogItem> & { id: string; name: string }): CatalogItem {
  return {
    direction: 'sales',
    itemType: 'non_inventory',
    code: null,
    defaultAccountId: null,
    defaultUnitAmount: null,
    defaultTaxRateId: null,
    inventoryAssetAccountId: null,
    cogsAccountId: null,
    costingMethod: null,
    defaultCost: null,
    reorderPoint: null,
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const ITEMS: readonly CatalogItem[] = [
  item({ id: 'i-consult', name: 'Consulting hour', code: 'CONSULT' }),
  item({ id: 'i-license', name: 'Annual license', code: 'LIC' }),
  item({ id: 'i-support', name: 'Support retainer', code: 'SUP' }),
];

interface HarnessProps {
  readonly items?: readonly CatalogItem[];
  readonly initialValue?: string;
  readonly onValueChange?: (text: string) => void;
  readonly onItemSelect?: (item: CatalogItem) => void;
  readonly onCreate?: (typed: string) => void;
  readonly onSubmit?: () => void;
}

function Harness({
  items = ITEMS,
  initialValue = '',
  onValueChange,
  onItemSelect,
  onCreate,
  onSubmit,
}: HarnessProps): ReactElement {
  const [value, setValue] = useState(initialValue);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit?.();
      }}
    >
      <LineItemCombobox
        aria-label="Description, line 1"
        value={value}
        items={items}
        onValueChange={(text) => {
          setValue(text);
          onValueChange?.(text);
        }}
        onItemSelect={(chosen) => {
          onItemSelect?.(chosen);
        }}
        {...(onCreate === undefined ? {} : { onCreate })}
      />
    </form>
  );
}

function combobox(): HTMLElement {
  return screen.getByRole('combobox');
}

function recordPreventedKeys(keys: readonly string[]): string[] {
  const prevented: string[] = [];
  const listener = (event: KeyboardEvent): void => {
    if (keys.includes(event.key) && event.defaultPrevented) prevented.push(event.key);
  };
  document.addEventListener('keydown', listener);
  onTestFinished(() => {
    document.removeEventListener('keydown', listener);
  });
  return prevented;
}

describe('LineItemCombobox — the input is the description', () => {
  it('reports free-text typing through onValueChange, never as a selection', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn<(text: string) => void>();
    const onItemSelect = vi.fn();
    render(<Harness onValueChange={onValueChange} onItemSelect={onItemSelect} />);

    await user.type(combobox(), 'Bespoke work');

    expect(combobox()).toHaveValue('Bespoke work');
    expect(onValueChange).toHaveBeenLastCalledWith('Bespoke work');
    expect(onItemSelect).not.toHaveBeenCalled();
  });

  it('filters suggestions by name and by code as the description is typed', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(combobox());
    expect(screen.getAllByRole('option')).toHaveLength(ITEMS.length);

    await user.type(combobox(), 'LIC');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Annual licenseLIC']);
  });
});

describe('LineItemCombobox — choosing a suggestion', () => {
  it('calls onItemSelect with the item and not onValueChange, by pointer', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn<(text: string) => void>();
    const onItemSelect = vi.fn<(item: CatalogItem) => void>();
    render(<Harness onValueChange={onValueChange} onItemSelect={onItemSelect} />);

    await user.click(combobox());
    await user.click(screen.getByRole('option', { name: /Support retainer/ }));

    expect(onItemSelect).toHaveBeenCalledExactlyOnceWith(ITEMS[2]);
    expect(onValueChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('calls onItemSelect on a deliberate Arrow-then-Enter', async () => {
    const user = userEvent.setup();
    const onItemSelect = vi.fn<(item: CatalogItem) => void>();
    render(<Harness onItemSelect={onItemSelect} />);

    await user.click(combobox());
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');

    expect(onItemSelect).toHaveBeenCalledExactlyOnceWith(ITEMS[1]);
  });
});

describe('LineItemCombobox — the create row', () => {
  it('hands the typed description back to onCreate', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn<(typed: string) => void>();
    render(<Harness onCreate={onCreate} />);

    await user.type(combobox(), 'New widget');
    await user.click(screen.getByRole('option', { name: 'Create “New widget”' }));

    expect(onCreate).toHaveBeenCalledExactlyOnceWith('New widget');
  });

  it('offers no create row until something has been typed', async () => {
    const user = userEvent.setup();
    render(<Harness onCreate={vi.fn()} />);

    await user.click(combobox());
    expect(screen.queryByRole('option', { name: /Create/ })).not.toBeInTheDocument();
  });
});

describe('LineItemCombobox — Enter belongs to the form', () => {
  it('submits the form on Enter when the popup is closed and when nothing is highlighted', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    const prevented = recordPreventedKeys(['Enter']);

    await user.click(combobox());
    // A closed list (before any keystroke) and an open list with nothing arrowed onto both
    // leave Enter to the form.
    await user.type(combobox(), 'Anything');
    await user.keyboard('{Enter}');

    expect(prevented).toEqual([]);
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('closes on Escape and keeps the description already typed', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn<(text: string) => void>();
    render(<Harness onValueChange={onValueChange} />);

    await user.type(combobox(), 'Consult');
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(combobox()).toHaveValue('Consult');
  });
});
