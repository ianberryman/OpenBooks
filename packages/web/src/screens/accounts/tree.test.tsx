import { describe, expect, it } from 'vitest';

import { account } from './fixtures';
import { buildAccountTree } from './tree';

/**
 * The tree is built from a *prefix* of a keyset-paged list (D-21), so "the parent has not
 * arrived yet" is an ordinary state rather than a corrupt one — and the property that
 * matters most is that no loaded account is ever missing from the screen, whatever the
 * shape of what arrived.
 */
const ASSETS = account({ id: 'a', code: '1000', name: 'Assets' });
const CASH = account({ id: 'b', code: '1100', name: 'Cash', parentAccountId: 'a' });
const BANK = account({ id: 'c', code: '1110', name: 'Bank', parentAccountId: 'b' });
const SALES = account({ id: 'd', code: '4000', name: 'Sales', type: 'revenue' });

describe('buildAccountTree', () => {
  it('nests children under their parent and counts the generations', () => {
    const rows = buildAccountTree([ASSETS, CASH, BANK, SALES]);

    expect(rows.map((row) => [row.account.code, row.depth])).toStrictEqual([
      ['1000', 0],
      ['1100', 1],
      ['1110', 2],
      ['4000', 0],
    ]);
    expect(rows.map((row) => row.parent?.code ?? null)).toStrictEqual([null, '1000', '1100', null]);
  });

  it('preserves the code ordering among siblings', () => {
    const later = account({ id: 'e', code: '1200', name: 'Receivables', parentAccountId: 'a' });
    const rows = buildAccountTree([ASSETS, CASH, later]);

    expect(rows.map((row) => row.account.code)).toStrictEqual(['1000', '1100', '1200']);
  });

  it('renders an account whose parent is on a later page at the top level, marked', () => {
    const rows = buildAccountTree([CASH, BANK]);

    expect(rows.map((row) => [row.account.code, row.depth, row.detached])).toStrictEqual([
      ['1100', 0, true],
      ['1110', 1, false],
    ]);
  });

  it('marks nothing detached when the account is genuinely top-level', () => {
    const rows = buildAccountTree([ASSETS]);
    expect(rows[0]?.detached).toBe(false);
  });

  it('emits every loaded account exactly once even if the parents form a cycle', () => {
    // The server refuses this (`account_parent_cycle`), which is an argument for it never
    // arriving and not an argument for a chart that can silently drop a row.
    const left = account({ id: 'x', code: '5000', parentAccountId: 'y' });
    const right = account({ id: 'y', code: '5100', parentAccountId: 'x' });

    const rows = buildAccountTree([left, right, SALES]);

    expect(rows.map((row) => row.account.id).sort()).toStrictEqual(['d', 'x', 'y']);
    expect(new Set(rows.map((row) => row.account.id)).size).toBe(rows.length);
  });

  it('is empty for an empty chart', () => {
    expect(buildAccountTree([])).toStrictEqual([]);
  });
});
