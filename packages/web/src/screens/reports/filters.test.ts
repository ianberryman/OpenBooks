import { describe, expect, it } from 'vitest';

import type { ReportFilterState } from './filters';
import {
  encodeDimensionFilters,
  initialFilterState,
  pinGroupFilter,
  todayCalendarDate,
  withAxisFilter,
} from './filters';

/**
 * The dimension filter as it reaches the wire (D-18, and the argument on
 * `reportDimensionFilterSchema`).
 *
 * Three things the server refuses, which this encoding must therefore never produce: a
 * filter naming neither values nor the unassigned bucket, two filters on one axis, and —
 * the one that would be silent rather than refused — an unassigned bucket expressed as an
 * empty value list.
 */

const DEPT = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';

function state(overrides: Partial<ReportFilterState> = {}): ReportFilterState {
  return { ...initialFilterState('2026-06-30'), ...overrides };
}

describe('encodeDimensionFilters', () => {
  it('sends nothing at all when no axis is restricted', () => {
    expect(encodeDimensionFilters(state())).toBeUndefined();
    expect(
      encodeDimensionFilters(
        state({ axes: [{ dimensionId: DEPT, valueIds: [], includeUnassigned: false }] }),
      ),
    ).toBeUndefined();
  });

  it('omits an empty value list rather than sending one', () => {
    const encoded = encodeDimensionFilters(
      state({ axes: [{ dimensionId: DEPT, valueIds: [], includeUnassigned: true }] }),
    );

    expect(JSON.parse(encoded ?? '[]')).toEqual([{ dimensionId: DEPT, includeUnassigned: true }]);
  });

  it('omits `includeUnassigned` when it is false', () => {
    const encoded = encodeDimensionFilters(
      state({ axes: [{ dimensionId: DEPT, valueIds: ['a', 'b'], includeUnassigned: false }] }),
    );

    expect(JSON.parse(encoded ?? '[]')).toEqual([{ dimensionId: DEPT, valueIds: ['a', 'b'] }]);
  });

  it('carries one filter per axis, conjoined across axes', () => {
    const encoded = encodeDimensionFilters(
      state({
        axes: [
          { dimensionId: DEPT, valueIds: ['a'], includeUnassigned: false },
          { dimensionId: PROJECT, valueIds: ['x'], includeUnassigned: false },
        ],
      }),
    );

    expect(JSON.parse(encoded ?? '[]')).toHaveLength(2);
  });
});

describe('withAxisFilter', () => {
  /**
   * Two filters naming the same axis is refused by the server, because a line carries at
   * most one value per axis and conjoining two of them matches nothing. Holding the state
   * this way makes that request unrepresentable rather than reporting it after a round trip.
   */
  it('replaces an axis rather than appending a second filter for it', () => {
    const first = withAxisFilter(state(), {
      dimensionId: DEPT,
      valueIds: ['a'],
      includeUnassigned: false,
    });
    const second = withAxisFilter(first, {
      dimensionId: DEPT,
      valueIds: ['b'],
      includeUnassigned: false,
    });

    expect(second.axes).toEqual([{ dimensionId: DEPT, valueIds: ['b'], includeUnassigned: false }]);
  });

  it('drops an axis that has been emptied', () => {
    const applied = withAxisFilter(state(), {
      dimensionId: DEPT,
      valueIds: ['a'],
      includeUnassigned: false,
    });
    const cleared = withAxisFilter(applied, {
      dimensionId: DEPT,
      valueIds: [],
      includeUnassigned: false,
    });

    expect(cleared.axes).toEqual([]);
  });
});

describe('pinGroupFilter — the drill-through from a bucket', () => {
  it('pins a named bucket to its own value', () => {
    const pinned = pinGroupFilter(state(), {
      dimensionId: DEPT,
      key: { dimensionValueId: 'sales', code: 'SALES', name: 'Sales team' },
    });

    expect(JSON.parse(encodeDimensionFilters(pinned) ?? '[]')).toEqual([
      { dimensionId: DEPT, valueIds: ['sales'] },
    ]);
  });

  /** The case no list of value ids can express, which is why the field exists at all. */
  it('pins the unassigned bucket as `includeUnassigned`', () => {
    const pinned = pinGroupFilter(state(), { dimensionId: DEPT, key: null });

    expect(JSON.parse(encodeDimensionFilters(pinned) ?? '[]')).toEqual([
      { dimensionId: DEPT, includeUnassigned: true },
    ]);
  });

  it('replaces whatever the axis already carried', () => {
    const filtered = withAxisFilter(state(), {
      dimensionId: DEPT,
      valueIds: ['other'],
      includeUnassigned: true,
    });
    const pinned = pinGroupFilter(filtered, { dimensionId: DEPT, key: null });

    expect(pinned.axes).toEqual([{ dimensionId: DEPT, valueIds: [], includeUnassigned: true }]);
  });
});

describe('todayCalendarDate', () => {
  /**
   * An accounting date carries no timezone, so it must not be derived from a UTC instant:
   * `toISOString().slice(0, 10)` puts a reader west of UTC on tomorrow's date every evening.
   */
  it('is the reader’s own calendar date, not a sliced UTC instant', () => {
    const lateEvening = new Date(2026, 5, 30, 23, 30);
    expect(todayCalendarDate(lateEvening)).toBe('2026-06-30');
  });

  it('defaults the upper bound and leaves the lower one at the ledger’s beginning', () => {
    const initial = initialFilterState('2026-06-30');
    expect(initial.to).toBe('2026-06-30');
    expect(initial.from).toBe('');
    expect(initial.hideZeroRows).toBe(false);
  });
});
