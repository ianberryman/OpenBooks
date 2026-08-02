import { useQuery } from '@tanstack/react-query';

import { api, unwrap } from '../api';
import type { components } from '../api';

/**
 * Reporting dimensions, as one shared read the whole app tags lines against.
 *
 * The journal-entry editor grew the first per-line tagging UI; the AR/AP document editors
 * (invoice, credit note, bill, vendor credit) need the identical control, so the axes
 * fetch, the get/set helpers, and the picker are lifted here rather than copied per screen.
 * Unlike the per-screen query keys elsewhere (which stay local so one screen's invalidation
 * is not another's), dimensions are read-only reference data no editor mutates, so a single
 * shared cache entry across all the editors is the point — one fetch, not four.
 */
export type Dimension = components['schemas']['Dimension'];
export type DimensionValue = components['schemas']['DimensionValue'];

export interface DimensionAxis {
  readonly dimension: Dimension;
  readonly values: readonly DimensionValue[];
}

export const dimensionKeys = {
  axes: ['dimensions', 'axes'] as const,
};

interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

/** `PAGE_SIZE_MAX` on the server; over it is refused rather than clamped. */
const PAGE_LIMIT = 200;

/**
 * A hard stop on the paging loop. D-29 bounds an org at eight dimensions and their values
 * are few, so this cap is a tripwire for something upstream going wrong, not a real limit —
 * a loop whose only exit is the server saying `nextCursor: null` hangs the tab when it does.
 */
const MAX_PAGES = 50;

async function collect<T>(load: (cursor: string | undefined) => Promise<Page<T>>): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await load(cursor);
    all.push(...result.items);
    if (result.nextCursor === null) return all;
    cursor = result.nextCursor;
  }

  throw new Error(
    `More than ${String(MAX_PAGES * PAGE_LIMIT)} rows behind one picker. Refusing to keep ` +
      `paging rather than list part of the set as though it were all of it.`,
  );
}

function pageQuery(cursor: string | undefined): { limit: number; cursor?: string } {
  // Spread rather than `cursor: undefined`: `exactOptionalPropertyTypes` makes an absent
  // property and an explicitly-undefined one different types.
  return { limit: PAGE_LIMIT, ...(cursor === undefined ? {} : { cursor }) };
}

/**
 * The axes and their values as one query rather than one plus N.
 *
 * D-18 makes dimensions unlimited and D-29 bounds them at eight per org, so the fan-out
 * is small and bounded. One cache entry means the tagging panel is either fully loaded
 * or not loaded — never some axes still arriving, which in a per-line tag editor reads as
 * tags that vanish and come back.
 */
async function fetchAxes(): Promise<DimensionAxis[]> {
  const dimensions = await collect<Dimension>(async (cursor) =>
    unwrap(await api.GET('/v1/dimensions', { params: { query: pageQuery(cursor) } })),
  );

  return Promise.all(
    dimensions.map(async (dimension) => ({
      dimension,
      values: await collect<DimensionValue>(async (cursor) =>
        unwrap(
          await api.GET('/v1/dimensions/{dimensionId}/values', {
            params: { path: { dimensionId: dimension.id }, query: pageQuery(cursor) },
          }),
        ),
      ),
    })),
  );
}

export interface DimensionAxesResult {
  readonly axes: readonly DimensionAxis[];
  readonly isLoading: boolean;
  readonly isError: boolean;
}

/**
 * The reporting axes for the current org, shared across every line editor.
 *
 * `axes` is `[]` until the fetch settles; consumers gate the picker's empty-state on
 * `isLoading` so a still-loading org does not flash "no dimensions yet".
 */
export function useDimensionAxes(): DimensionAxesResult {
  const query = useQuery({ queryKey: dimensionKeys.axes, queryFn: fetchAxes });
  return {
    axes: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

/**
 * The value this set of tags carries on one axis, or `null`.
 *
 * A dimension value names its own axis, so a line stores a flat list of value ids and the
 * axis is resolved by lookup rather than stored twice (mirrors the journal-entry editor).
 */
export function valueOnAxis(
  dimensionValueIds: readonly string[],
  axis: DimensionAxis,
): string | null {
  const onAxis = new Set(axis.values.map((value) => value.id));
  return dimensionValueIds.find((id) => onAxis.has(id)) ?? null;
}

/** At most one value per axis — the unique key the schema carries, applied as you type. */
export function withAxisValue(
  dimensionValueIds: readonly string[],
  axis: DimensionAxis,
  valueId: string | null,
): readonly string[] {
  const onAxis = new Set(axis.values.map((value) => value.id));
  const others = dimensionValueIds.filter((id) => !onAxis.has(id));
  return valueId === null ? others : [...others, valueId];
}
