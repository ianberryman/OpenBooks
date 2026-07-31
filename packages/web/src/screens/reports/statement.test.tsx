import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { StatementSection } from './statement';
import type { StatementRow } from './statement';

/**
 * The double-count trap (B7).
 *
 * `amount` is an account's own postings; `subtotal` is that plus every descendant's
 * `amount`; a section `total` is the sum of the **amounts**. Summing the subtotals instead
 * counts each parent's subtree once per level of the hierarchy — which on the two-level
 * chart below is a statement 60% too large, and on a flat chart is identical to correct.
 * That is the shape of mistake M1's property suite was written for: a wrong renderer that
 * every simple example agrees with.
 *
 * These fixtures therefore have a parent that holds postings of its own, which is the only
 * arrangement where `amount` and `subtotal` differ on a row that also has children.
 */
function row(overrides: Partial<StatementRow> & Pick<StatementRow, 'accountId'>): StatementRow {
  return {
    parentAccountId: null,
    code: '0000',
    name: 'Account',
    isActive: true,
    amount: '0',
    subtotal: '0',
    ...overrides,
  };
}

/** Premises 100.00 holds 100.00 of its own postings and a child holding 150.00. */
const ROWS: readonly StatementRow[] = [
  row({
    accountId: 'premises',
    code: '6000',
    name: 'Premises',
    amount: '10000',
    subtotal: '25000',
  }),
  row({
    accountId: 'rent',
    parentAccountId: 'premises',
    code: '6100',
    name: 'Rent',
    amount: '15000',
    subtotal: '15000',
  }),
];

function rowFor(name: RegExp): HTMLElement {
  const header = screen.getByRole('rowheader', { name });
  const line = header.closest('tr');
  if (line === null) throw new Error(`No row carried the header matching ${String(name)}.`);
  return line;
}

function amountsIn(name: RegExp): readonly string[] {
  return within(rowFor(name))
    .getAllByRole('cell')
    .map((cell) => cell.textContent ?? '');
}

describe('StatementSection — subtotals against the section total', () => {
  it('prints a parent’s own amount beside its subtree’s subtotal', () => {
    render(
      <StatementSection
        title="Expenses"
        rows={ROWS}
        total="25000"
        totalLabel="Total expenses"
        hideZeroRows={false}
        onDrillThrough={() => {}}
      />,
    );

    // The parent's own postings in the Amount column, the subtree in the Subtotal column.
    // Printing 250.00 against the parent's name beside its children is the double count.
    expect(amountsIn(/Premises/)).toEqual(['$100.00', '$250.00']);
  });

  it('leaves a leaf’s subtotal column empty rather than repeating its amount', () => {
    render(
      <StatementSection
        title="Expenses"
        rows={ROWS}
        total="25000"
        totalLabel="Total expenses"
        hideZeroRows={false}
        onDrillThrough={() => {}}
      />,
    );

    const [amount, subtotal] = amountsIn(/Rent/);
    expect(amount).toBe('$150.00');
    expect(subtotal).toBe('—');
  });

  it('prints the section total from the server and never the sum of the subtotals', () => {
    render(
      <StatementSection
        title="Expenses"
        rows={ROWS}
        total="25000"
        totalLabel="Total expenses"
        hideZeroRows={false}
        onDrillThrough={() => {}}
      />,
    );

    expect(amountsIn(/Total expenses/)).toEqual(['$250.00', '']);
    // 25000 + 15000 is what summing the Subtotal column gives. It must appear nowhere.
    expect(screen.queryByText('$400.00')).toBeNull();
  });
});

describe('StatementSection — the hierarchy', () => {
  it('nests a child under its parent and indents it', () => {
    render(
      <StatementSection
        title="Expenses"
        rows={ROWS}
        total="25000"
        totalLabel="Total expenses"
        hideZeroRows={false}
        onDrillThrough={() => {}}
      />,
    );

    const rows = within(screen.getByRole('table', { name: 'Expenses' })).getAllByRole('rowheader');
    expect(rows.map((header) => header.textContent)).toEqual([
      expect.stringContaining('Premises'),
      expect.stringContaining('Rent'),
      expect.stringContaining('Total expenses'),
    ]);
  });

  /**
   * Rows arriving in any order still nest: the flat shape carries a pointer, not an
   * ordering, and a renderer that assumed a parent precedes its children would drop the
   * child — a row the section total was summed from.
   */
  it('emits every row exactly once whatever order they arrive in', () => {
    const [premises, rent] = ROWS;
    if (premises === undefined || rent === undefined) throw new Error('fixture');

    render(
      <StatementSection
        title="Expenses"
        rows={[rent, premises]}
        total="25000"
        totalLabel="Total expenses"
        hideZeroRows={false}
        onDrillThrough={() => {}}
      />,
    );

    expect(screen.getAllByRole('rowheader')).toHaveLength(3);
    expect(amountsIn(/Rent/)).toEqual(['$150.00', '—']);
  });
});

describe('StatementSection — zero rows', () => {
  const WITH_ZERO: readonly StatementRow[] = [
    ...ROWS,
    row({ accountId: 'unused', code: '6900', name: 'Sundry' }),
  ];

  it('shows zero rows by default, because an empty account is a fact about the books', () => {
    render(
      <StatementSection
        title="Expenses"
        rows={WITH_ZERO}
        total="25000"
        totalLabel="Total expenses"
        hideZeroRows={false}
        onDrillThrough={() => {}}
      />,
    );

    expect(screen.getByRole('rowheader', { name: /Sundry/ })).toBeInTheDocument();
  });

  it('hides them on request without hiding an ancestor of a row that survives', () => {
    const withZeroParent: readonly StatementRow[] = [
      row({ accountId: 'premises', code: '6000', name: 'Premises', amount: '0', subtotal: '0' }),
      row({
        accountId: 'up',
        parentAccountId: 'premises',
        code: '6100',
        name: 'Service charge',
        amount: '10000',
        subtotal: '10000',
      }),
      row({
        accountId: 'down',
        parentAccountId: 'premises',
        code: '6200',
        name: 'Rebate',
        amount: '-10000',
        subtotal: '-10000',
      }),
      row({ accountId: 'unused', code: '6900', name: 'Sundry' }),
    ];

    render(
      <StatementSection
        title="Expenses"
        rows={withZeroParent}
        total="0"
        totalLabel="Total expenses"
        hideZeroRows
        onDrillThrough={() => {}}
      />,
    );

    // The parent's own amount and its subtotal are both zero — the subtree nets off — and
    // it must still appear, or the two rows beneath it hang under nothing.
    expect(screen.getByRole('rowheader', { name: /Premises/ })).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: /Service charge/ })).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: /Rebate/ })).toBeInTheDocument();
    expect(screen.queryByRole('rowheader', { name: /Sundry/ })).toBeNull();
  });
});

describe('StatementSection — drill-through', () => {
  it('opens the account behind the line that was clicked', async () => {
    const user = userEvent.setup();
    const onDrillThrough = vi.fn<(accountId: string) => void>();
    render(
      <StatementSection
        title="Expenses"
        rows={ROWS}
        total="25000"
        totalLabel="Total expenses"
        hideZeroRows={false}
        onDrillThrough={onDrillThrough}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Rent' }));

    expect(onDrillThrough).toHaveBeenCalledExactlyOnceWith('rent');
  });
});
