import { describe, expect, it } from 'vitest';

import { compareBillsForList, matchesCardFilter } from './ap-document';
import type { ApDocumentSummary } from './ap-document';

/**
 * The bills list's default order and the summary-card filters (OB-069 UI). Both are pure
 * reads over the server's `status`/`settlement`, so they are worth pinning here rather than
 * only through a rendered list.
 */
const AS_OF = '2026-07-31';

function bill(partial: Partial<ApDocumentSummary>): ApDocumentSummary {
  return {
    id: 'b',
    documentNumber: '1',
    reference: null,
    contactId: 'c',
    issueDate: '2026-01-01',
    dueDate: '2026-07-01',
    status: 'approved',
    totals: { net: '1000', tax: '0', gross: '1000' },
    settlement: { allocated: '0', outstanding: '1000' },
    committed: '0',
    ...partial,
  };
}

describe('compareBillsForList', () => {
  it('orders unpaid before settled, then by due date ascending', () => {
    const settled = bill({ id: 'settled', settlement: { allocated: '1000', outstanding: '0' } });
    const dueLater = bill({ id: 'later', dueDate: '2026-08-01' });
    const dueSooner = bill({ id: 'sooner', dueDate: '2026-06-01' });

    const order = [settled, dueLater, dueSooner].sort(compareBillsForList).map((b) => b.id);

    expect(order).toEqual(['sooner', 'later', 'settled']);
  });

  it('sorts a bill with no due date last within the unpaid group', () => {
    const dated = bill({ id: 'dated', dueDate: '2026-06-01' });
    const undated = bill({ id: 'undated', dueDate: null });

    expect([undated, dated].sort(compareBillsForList).map((b) => b.id)).toEqual([
      'dated',
      'undated',
    ]);
  });
});

describe('matchesCardFilter', () => {
  it('unpaid keeps only bills still owing', () => {
    expect(matchesCardFilter(bill({}), 'unpaid', AS_OF)).toBe(true);
    expect(
      matchesCardFilter(
        bill({ settlement: { allocated: '1000', outstanding: '0' } }),
        'unpaid',
        AS_OF,
      ),
    ).toBe(false);
  });

  it('overdue needs an owed balance and a due date before as-of', () => {
    expect(matchesCardFilter(bill({ dueDate: '2026-06-01' }), 'overdue', AS_OF)).toBe(true);
    // Owed but not yet due.
    expect(matchesCardFilter(bill({ dueDate: '2026-08-01' }), 'overdue', AS_OF)).toBe(false);
    // Past due but already settled.
    expect(
      matchesCardFilter(
        bill({ dueDate: '2026-06-01', settlement: { allocated: '1000', outstanding: '0' } }),
        'overdue',
        AS_OF,
      ),
    ).toBe(false);
  });

  it('paid keeps only bills with paid status', () => {
    expect(matchesCardFilter(bill({ status: 'paid' }), 'paid', AS_OF)).toBe(true);
    expect(matchesCardFilter(bill({ status: 'part_paid' }), 'paid', AS_OF)).toBe(false);
  });
});
