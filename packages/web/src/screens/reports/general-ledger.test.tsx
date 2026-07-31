import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { components } from '../../api';
import { GeneralLedgerPage } from './general-ledger';

/**
 * A page of the general ledger (OB-044; B4, D-21).
 *
 * The header is recomputed on every page, and this file's central assertion is that the
 * screen *reports* the consequence rather than hiding it: when a back-dated entry lands
 * between two fetches the closing balance moves, and a client holding page one's totals
 * over page nine's lines would have no sign of it. The schema made the totals per-page so
 * that a client could see it happen, so seeing it is what the renderer must do.
 */

type GeneralLedger = components['schemas']['GeneralLedger'];
type GeneralLedgerEntry = components['schemas']['GeneralLedgerEntry'];

function entry(overrides: Partial<GeneralLedgerEntry> = {}): GeneralLedgerEntry {
  return {
    lineId: '1',
    journalId: '33333333-3333-4333-8333-333333333333',
    sequenceNumber: '17',
    lineNumber: 1,
    date: '2026-03-01',
    journalMemo: 'March rent',
    lineMemo: null,
    contact: null,
    debit: '150000',
    credit: '0',
    runningBalance: '150000',
    counterparty: {
      accounts: [{ accountId: 'bank', code: '1000', name: 'Bank' }],
      accountCount: 1,
    },
    tags: [],
    ...overrides,
  };
}

function page(overrides: Partial<GeneralLedger> = {}): GeneralLedger {
  return {
    accountId: 'rent',
    code: '6100',
    name: 'Rent',
    type: 'expense',
    normalBalance: 'debit',
    from: '2026-01-01',
    to: '2026-03-31',
    opening: { debits: '0', credits: '0', balance: '0' },
    movement: { debits: '150000', credits: '0', balance: '150000' },
    closing: { debits: '150000', credits: '0', balance: '150000' },
    entries: [entry()],
    nextCursor: null,
    ...overrides,
  };
}

describe('GeneralLedgerPage — the header', () => {
  it('prints opening, movement and closing for the page that was read', () => {
    render(<GeneralLedgerPage page={page()} closingLeftBehind={null} />);

    const balances = within(screen.getByRole('table', { name: 'Balances' }));
    expect(balances.getByRole('rowheader', { name: 'Opening' })).toBeInTheDocument();
    expect(balances.getByRole('rowheader', { name: 'Movement' })).toBeInTheDocument();
    expect(balances.getByRole('rowheader', { name: 'Closing' })).toBeInTheDocument();
  });

  it('says nothing about movement when the ledger has not moved', () => {
    render(<GeneralLedgerPage page={page()} closingLeftBehind="150000" />);

    expect(screen.queryByRole('status')).toBeNull();
  });

  /**
   * The deliberate, visible failure. Not smoothed over, not reconciled: both figures are
   * shown, because each is a true statement about the ledger at the moment its page was
   * read, and only the reader can decide whether to re-run the report.
   */
  it('reports a closing balance that moved between two page fetches', () => {
    render(<GeneralLedgerPage page={page()} closingLeftBehind="120000" />);

    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('$1,200.00');
    expect(notice).toHaveTextContent('$1,500.00');
    expect(notice).toHaveTextContent('The ledger moved while this was being read.');
  });
});

describe('GeneralLedgerPage — the entries', () => {
  it('names the single account on the opposite side', () => {
    render(<GeneralLedgerPage page={page()} closingLeftBehind={null} />);

    expect(screen.getByText('1000 Bank')).toBeInTheDocument();
  });

  /**
   * No amount is apportioned to any counterparty, and none can be: a journal records that
   * its debits equal its credits, not which debit paid for which credit.
   */
  it('shows a split entry as a split, and says when the list was truncated', () => {
    render(
      <GeneralLedgerPage
        page={page({
          entries: [
            entry({
              counterparty: {
                accounts: [
                  { accountId: 'a', code: '1000', name: 'Bank' },
                  { accountId: 'b', code: '2000', name: 'Payables' },
                ],
                accountCount: 5,
              },
            }),
          ],
        })}
        closingLeftBehind={null}
      />,
    );

    expect(screen.getByText('— Split — 1000, 2000 +3 more')).toBeInTheDocument();
  });

  it('carries each line’s dimension tags, qualified by their axis', () => {
    render(
      <GeneralLedgerPage
        page={page({
          entries: [
            entry({
              tags: [
                {
                  dimensionId: 'dept',
                  dimensionCode: 'DEPT',
                  dimensionValueId: 'sales',
                  code: 'SALES',
                  name: 'Sales team',
                },
              ],
            }),
          ],
        })}
        closingLeftBehind={null}
      />,
    );

    expect(screen.getByText('DEPT: Sales team')).toBeInTheDocument();
  });

  it('runs the balance down the page as debits less credits', () => {
    render(<GeneralLedgerPage page={page()} closingLeftBehind={null} />);

    const entries = within(screen.getByRole('table', { name: 'Entries' }));
    const cells = entries.getAllByRole('cell');
    // date, entry, memo, other side, debit, credit, running balance
    expect(cells.at(-1)?.textContent).toBe('$1,500.00');
  });

  it('says so rather than showing an empty table when the range holds nothing', () => {
    render(<GeneralLedgerPage page={page({ entries: [] })} closingLeftBehind={null} />);

    expect(screen.getByText('No entries in this range.')).toBeInTheDocument();
  });
});
