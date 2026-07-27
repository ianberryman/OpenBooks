import type { components } from '../../api';

/**
 * The state behind the shared report controls, and the encoding that turns it into
 * querystring parameters (OB-052).
 *
 * One state object for all four viewers rather than one per report. A bookkeeper reads
 * a period, not a report: the P&L for March and the balance sheet at 31 March are the
 * same enquiry, and controls that reset between tabs would make the reader re-enter the
 * period to check one figure against another — which is exactly the cross-check D-20's
 * measurement note describes ("checking each line against the trial balance at both ends
 * of the year").
 *
 * The four endpoints take different subsets of it, so the parts each report cannot use
 * are reported to the reader rather than silently dropped. See `unusedFilterNotice`.
 */

export type ReportGroupKey = components['schemas']['ReportGroupKey'];

/**
 * One axis's restriction, in the form the checkbox panel holds it.
 *
 * `includeUnassigned` sits beside the value ids rather than being one of them because it
 * is not a value: it selects the lines carrying *nothing* on this axis, which no list of
 * ids can express (`shared-types/reports/balances.ts`). It is also the drill-through from
 * a grouped report's unassigned bucket, which is why it exists on the wire at all.
 */
export interface AxisFilterState {
  readonly dimensionId: string;
  readonly valueIds: readonly string[];
  readonly includeUnassigned: boolean;
}

export interface ReportFilterState {
  /** Inclusive lower bound. `''` is the ledger's beginning, which the reports report back. */
  readonly from: string;
  /** Inclusive upper bound, and the "as at" date of the two point-in-time reports. */
  readonly to: string;
  /** The dimension axis to slice by, or `null` for one undivided report. */
  readonly groupBy: string | null;
  readonly axes: readonly AxisFilterState[];
  /**
   * Zero rows are included by the server on purpose — an empty bank account is how
   * someone notices the month's receipts were posted somewhere else — so hiding them is
   * offered and never applied by default.
   */
  readonly hideZeroRows: boolean;
}

/**
 * `YYYY-MM-DD` in the reader's own timezone.
 *
 * Not `toISOString().slice(0, 10)`. `calendarDateSchema` is a calendar date and not an
 * instant precisely so that which period an entry lands in does not depend on the
 * reader's clock; slicing a UTC instant would reintroduce that, putting a reader west of
 * UTC on tomorrow's date every evening.
 */
export function todayCalendarDate(now: Date = new Date()): string {
  const year = String(now.getFullYear()).padStart(4, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function initialFilterState(today: string = todayCalendarDate()): ReportFilterState {
  /**
   * `to` defaults to today and `from` to the ledger's beginning. A default `from` would
   * have to guess a fiscal-year start, which is a per-org setting (D-17) the screen has
   * not read — and a P&L run over the wrong year boundary is wrong in a way that still
   * foots. An unbounded range is instead reported back by every response, so what the
   * reader sees is what was applied.
   */
  return { from: '', to: today, groupBy: null, axes: [], hideZeroRows: false };
}

export function isAxisFilterActive(axis: AxisFilterState): boolean {
  return axis.valueIds.length > 0 || axis.includeUnassigned;
}

export function activeAxisFilters(state: ReportFilterState): readonly AxisFilterState[] {
  return state.axes.filter(isAxisFilterActive);
}

export function axisFilterFor(
  state: ReportFilterState,
  dimensionId: string,
): AxisFilterState | undefined {
  return state.axes.find((axis) => axis.dimensionId === dimensionId);
}

/**
 * Replaces one axis's restriction, keeping at most one entry per axis.
 *
 * The uniqueness is the point rather than tidiness: two filters naming the same axis is
 * refused by the server, because a line carries at most one value per axis and conjoining
 * two such filters matches nothing. Holding the state this way makes the refused request
 * unrepresentable instead of reporting it after the round trip.
 */
export function withAxisFilter(state: ReportFilterState, axis: AxisFilterState): ReportFilterState {
  const others = state.axes.filter((existing) => existing.dimensionId !== axis.dimensionId);
  return { ...state, axes: isAxisFilterActive(axis) ? [...others, axis] : others };
}

/** The bucket a drilled-through figure came from. `key` of `null` is the unassigned bucket. */
export interface DrillGroup {
  readonly dimensionId: string;
  readonly key: ReportGroupKey | null;
}

export interface DrillTarget {
  readonly accountId: string;
  /** Absent when the report was not sliced. */
  readonly group: DrillGroup | null;
}

/**
 * Narrows the filters to the one bucket a figure came from, so the ledger behind a sliced
 * line is the same lines that produced it.
 *
 * The unassigned bucket becomes `includeUnassigned`, which is the case that would
 * otherwise be undrillable: its lines are defined by carrying no value on the axis, and
 * `valueIds` cannot say that (D-18, and the note on `generalLedgerQuerySchema`).
 */
export function pinGroupFilter(state: ReportFilterState, group: DrillGroup): ReportFilterState {
  return withAxisFilter(state, {
    dimensionId: group.dimensionId,
    valueIds: group.key === null ? [] : [group.key.dimensionValueId],
    includeUnassigned: group.key === null,
  });
}

/** The wire form of one filter: `valueIds` and `includeUnassigned` are both optional. */
interface DimensionFilterWire {
  dimensionId: string;
  valueIds?: string[];
  includeUnassigned?: boolean;
}

/**
 * The `dimensions` parameter: a JSON array in one querystring value.
 *
 * The routes argue the encoding at length (`transport/routes/reports.ts`) — a structured
 * argument has to cross a `GET`, and JSON in one parameter is the option that keeps every
 * report cacheable and linkable and keeps the parser out of the transport layer. This
 * function is the client half of it, and it emits neither an empty `valueIds` nor an
 * `includeUnassigned: false`, because a filter naming neither is refused rather than
 * silently matching nothing.
 */
export function encodeDimensionFilters(state: ReportFilterState): string | undefined {
  const active = activeAxisFilters(state);
  if (active.length === 0) return undefined;

  return JSON.stringify(
    active.map((axis): DimensionFilterWire => {
      const filter: DimensionFilterWire = { dimensionId: axis.dimensionId };
      if (axis.valueIds.length > 0) filter.valueIds = [...axis.valueIds];
      if (axis.includeUnassigned) filter.includeUnassigned = true;
      return filter;
    }),
  );
}

/**
 * The optional slice parameters the three M2 reports share, spread into a query object.
 *
 * Spread rather than assigned because `exactOptionalPropertyTypes` makes an absent
 * property and one explicitly set to `undefined` different types, and the generated
 * parameter types do not admit the second.
 */
export function sliceQuery(state: ReportFilterState): {
  dimensions?: string;
  groupBy?: string;
} {
  const dimensions = encodeDimensionFilters(state);
  return {
    ...(dimensions === undefined ? {} : { dimensions }),
    ...(state.groupBy === null ? {} : { groupBy: state.groupBy }),
  };
}

export function rangeQuery(state: ReportFilterState): { from?: string; to?: string } {
  return {
    ...(state.from === '' ? {} : { from: state.from }),
    ...(state.to === '' ? {} : { to: state.to }),
  };
}
