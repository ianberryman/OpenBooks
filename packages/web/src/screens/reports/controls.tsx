import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useState } from 'react';

import { api, unwrap } from '../../api';
import type { components } from '../../api';
import { Button, Select } from '../../components';
import { cx } from '../../lib/cx';
import type { AxisFilterState, ReportFilterState } from './filters';
import { axisFilterFor, isAxisFilterActive, withAxisFilter } from './filters';

/**
 * The shared controls: one date range, one dimension-filter panel, one slice axis
 * (OB-052).
 *
 * Four viewers, one implementation. The alternative is four toolbars that drift — and the
 * drift that matters is not visual: the dimension filter is a JSON document assembled by
 * hand (`filters.ts`), so a second assembly of it is a second chance to emit an empty
 * `valueIds` or two filters on one axis, both of which the server refuses.
 *
 * ## Capabilities rather than four copies with pieces removed
 *
 * The endpoints take different subsets of this state. The trial balance is M1's and takes
 * only an upper bound; the balance sheet takes a required `asOf` and no range; the general
 * ledger takes a range and filters but no `groupBy`, because dividing a list of individual
 * lines into columns is a cross-tabulation and not a ledger. So each report declares what
 * it accepts, the controls it cannot use are not offered, and anything the reader has set
 * that this report will ignore is **said out loud** — a filter that appears to be applied
 * and is not is a wrong report that looks right.
 */

export type Dimension = components['schemas']['Dimension'];
export type DimensionValue = components['schemas']['DimensionValue'];

export interface ReportCapabilities {
  /** `range` shows both bounds; `asOf` shows only the upper one, and names it as at. */
  readonly dates: 'range' | 'asOf';
  readonly dimensions: boolean;
  readonly groupBy: boolean;
}

const DIMENSIONS_KEY = ['reports', 'controls', 'dimensions'] as const;

/**
 * Every axis, and every value of an axis, in one query each.
 *
 * The list endpoints are keyset-paged (D-21) and these are pick-from-all controls, so the
 * fetcher follows `nextCursor` to the end rather than showing the first page and quietly
 * omitting the rest. An org is bounded at eight axes (D-29); the values are not bounded,
 * which is why the loop is a loop and not two requests.
 */
export function useDimensions(): readonly Dimension[] {
  const query = useQuery({
    queryKey: DIMENSIONS_KEY,
    queryFn: async (): Promise<readonly Dimension[]> => {
      const items: Dimension[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = unwrap(
          await api.GET('/v1/dimensions', {
            params: {
              query: { isActive: 'true', limit: 200, ...(cursor === undefined ? {} : { cursor }) },
            },
          }),
        );
        items.push(...page.items);
        if (page.nextCursor === null) return items;
        cursor = page.nextCursor;
      }
    },
  });

  return query.data ?? [];
}

function useDimensionValues(dimensionId: string): readonly DimensionValue[] {
  const query = useQuery({
    queryKey: ['reports', 'controls', 'dimension-values', dimensionId],
    queryFn: async (): Promise<readonly DimensionValue[]> => {
      const items: DimensionValue[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = unwrap(
          await api.GET('/v1/dimensions/{dimensionId}/values', {
            params: {
              path: { dimensionId },
              query: { limit: 200, ...(cursor === undefined ? {} : { cursor }) },
            },
          }),
        );
        items.push(...page.items);
        if (page.nextCursor === null) return items;
        cursor = page.nextCursor;
      }
    },
  });

  return query.data ?? [];
}

export interface ReportControlsProps {
  readonly state: ReportFilterState;
  readonly onChange: (next: ReportFilterState) => void;
  readonly capabilities: ReportCapabilities;
  readonly dimensions: readonly Dimension[];
}

/**
 * Radix models "no selection" as the absence of a value and warns on `''`, so the
 * not-sliced option needs a real one. A sentinel that cannot collide with a uuid.
 */
const NO_GROUP = 'none';

export function ReportControls({
  state,
  onChange,
  capabilities,
  dimensions,
}: ReportControlsProps): ReactElement {
  const [panelOpen, setPanelOpen] = useState(false);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-3">
      <div className="flex flex-wrap items-end gap-3">
        {capabilities.dates === 'range' && (
          <DateControl
            label="From"
            value={state.from}
            hint="Empty runs from the ledger's beginning."
            onChange={(from) => {
              onChange({ ...state, from });
            }}
          />
        )}
        <DateControl
          label={capabilities.dates === 'range' ? 'To' : 'As at'}
          value={state.to}
          hint={
            capabilities.dates === 'range'
              ? 'Empty includes every posting to date.'
              : 'A position at a point in time.'
          }
          onChange={(to) => {
            onChange({ ...state, to });
          }}
        />

        {capabilities.groupBy && (
          // A `<div>` and an `aria-label` rather than a `<label>`: the select's trigger is a
          // button, which `<label>` cannot be associated with, and the name has to reach it.
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium text-text">Slice by</span>
            <Select
              aria-label="Slice by"
              value={state.groupBy}
              placeholder="Not sliced"
              options={[
                { value: NO_GROUP, label: 'Not sliced' },
                ...dimensions.map((dimension) => ({
                  value: dimension.id,
                  label: `${dimension.code} — ${dimension.name}`,
                })),
              ]}
              onValueChange={(value) => {
                onChange({ ...state, groupBy: value === NO_GROUP ? null : value });
              }}
              className="w-56"
            />
          </div>
        )}

        {capabilities.dimensions && dimensions.length > 0 && (
          <Button
            aria-expanded={panelOpen}
            onClick={() => {
              setPanelOpen(!panelOpen);
            }}
          >
            {panelOpen ? 'Hide filters' : 'Filters'}
          </Button>
        )}

        <label className="ml-auto flex items-center gap-2 text-base text-text-muted">
          <input
            type="checkbox"
            className="size-4"
            checked={state.hideZeroRows}
            onChange={(event) => {
              onChange({ ...state, hideZeroRows: event.target.checked });
            }}
          />
          {/* Off by default: the server sends zero rows on purpose, and an account standing
              at zero is how someone notices the month was posted somewhere else. */}
          Hide rows standing at zero
        </label>
      </div>

      <ActiveFilterSummary state={state} dimensions={dimensions} onChange={onChange} />

      {panelOpen && capabilities.dimensions && (
        <div className="flex flex-wrap gap-4 border-t border-border pt-3">
          {dimensions.map((dimension) => (
            <AxisFilter
              key={dimension.id}
              dimension={dimension}
              value={axisFilterFor(state, dimension.id)}
              onChange={(axis) => {
                onChange(withAxisFilter(state, axis));
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DateControl({
  label,
  value,
  hint,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint: string;
  readonly onChange: (value: string) => void;
}): ReactElement {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-medium text-text">{label}</span>
      <input
        type="date"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className={cx(
          'h-9 rounded-md border border-border bg-surface px-2 text-base text-text',
          'font-mono tabular-nums',
        )}
      />
      <span className="text-xs text-text-subtle">{hint}</span>
    </label>
  );
}

/**
 * One axis's values as checkboxes, plus the unassigned bucket.
 *
 * Unassigned is offered on the *filter* and not only on a grouped view, because it is the
 * only way to ask for the lines nobody tagged — and those lines are exactly the ones a
 * slice view would otherwise lose (D-18).
 */
function AxisFilter({
  dimension,
  value,
  onChange,
}: {
  readonly dimension: Dimension;
  readonly value: AxisFilterState | undefined;
  readonly onChange: (axis: AxisFilterState) => void;
}): ReactElement {
  const values = useDimensionValues(dimension.id);
  const current: AxisFilterState = value ?? {
    dimensionId: dimension.id,
    valueIds: [],
    includeUnassigned: false,
  };

  function toggleValue(valueId: string, checked: boolean): void {
    const valueIds = checked
      ? [...current.valueIds, valueId]
      : current.valueIds.filter((id) => id !== valueId);
    onChange({ ...current, valueIds });
  }

  return (
    <fieldset className="flex min-w-48 flex-col gap-1">
      <legend className="text-sm font-medium text-text">{dimension.name}</legend>
      {values.map((dimensionValue) => (
        <label
          key={dimensionValue.id}
          className="flex items-center gap-2 text-base text-text-muted"
        >
          <input
            type="checkbox"
            className="size-4"
            checked={current.valueIds.includes(dimensionValue.id)}
            onChange={(event) => {
              toggleValue(dimensionValue.id, event.target.checked);
            }}
          />
          <span className="font-mono text-xs text-text-subtle">{dimensionValue.code}</span>
          {dimensionValue.name}
        </label>
      ))}
      <label className="flex items-center gap-2 text-base text-text-muted">
        <input
          type="checkbox"
          className="size-4"
          checked={current.includeUnassigned}
          onChange={(event) => {
            onChange({ ...current, includeUnassigned: event.target.checked });
          }}
        />
        Unassigned
      </label>
    </fieldset>
  );
}

/**
 * What is currently narrowing the report, stated whether or not the panel is open.
 *
 * A filter a reader cannot see is a report they will misread — and after a drill-through
 * the filters were set by a click on a figure rather than by the panel, so this line is
 * the only place the pinned axis appears.
 */
function ActiveFilterSummary({
  state,
  dimensions,
  onChange,
}: {
  readonly state: ReportFilterState;
  readonly dimensions: readonly Dimension[];
  readonly onChange: (next: ReportFilterState) => void;
}): ReactElement | null {
  const active = state.axes.filter(isAxisFilterActive);
  if (active.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-text-muted">
      <span>Filtered by</span>
      {active.map((axis) => {
        const dimension = dimensions.find((candidate) => candidate.id === axis.dimensionId);
        const parts: string[] = [];
        if (axis.valueIds.length > 0) parts.push(`${String(axis.valueIds.length)} value(s)`);
        if (axis.includeUnassigned) parts.push('unassigned');
        return (
          <span
            key={axis.dimensionId}
            className="flex items-center gap-1 rounded-full border border-border px-2 py-0.5"
          >
            {dimension?.name ?? 'Axis'}: {parts.join(' + ')}
            <button
              type="button"
              aria-label={`Clear the ${dimension?.name ?? 'axis'} filter`}
              className="text-text-subtle hover:text-text"
              onClick={() => {
                onChange(
                  withAxisFilter(state, {
                    dimensionId: axis.dimensionId,
                    valueIds: [],
                    includeUnassigned: false,
                  }),
                );
              }}
            >
              ×
            </button>
          </span>
        );
      })}
    </div>
  );
}

/**
 * The notice that a control the reader has set does not reach this report.
 *
 * Silently dropping it is the failure this exists to prevent: the trial balance takes no
 * dimension filter at all (it is M1's endpoint, and the oracle every other report is
 * checked against), so a reader who filtered by department and then switched to it would
 * otherwise be comparing a slice against the whole.
 */
export function UnusedControlNotice({
  state,
  capabilities,
}: {
  readonly state: ReportFilterState;
  readonly capabilities: ReportCapabilities;
}): ReactElement | null {
  const ignored: string[] = [];
  if (!capabilities.dimensions && state.axes.some(isAxisFilterActive)) {
    ignored.push('the dimension filters');
  }
  if (!capabilities.groupBy && state.groupBy !== null) ignored.push('the slice axis');
  if (capabilities.dates === 'asOf' && state.from !== '') ignored.push('the start date');
  if (ignored.length === 0) return null;

  return (
    <p className="rounded-md border border-warning-border bg-warning-soft px-3 py-2 text-sm text-warning-text">
      This report does not take {ignored.join(' or ')}. The figures below are unfiltered in that
      respect.
    </p>
  );
}
