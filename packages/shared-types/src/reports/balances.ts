import { z } from 'zod';

import { ACCOUNT_TYPES } from '../accounts';
import { MAX_DIMENSIONS_PER_ORG } from '../dimensions';
import { calendarDateSchema } from '../wire';

/**
 * The query the report core takes, and therefore the query the P&L, the balance
 * sheet and the general ledger are all asking (OB-041; B2, B3, B4, B6, B7).
 *
 * ## Why this file carries a query and no response
 *
 * `reports.ts` next door defines both halves of the trial balance, because the
 * trial balance is an endpoint. This is not one: OB-041 is the aggregation the
 * three report tickets project from, and each of them publishes its own response
 * shape — a P&L has sections and a net line, a balance sheet has a derived
 * current-year earnings line (D-20), a general ledger has entries. Publishing the
 * core's intermediate shape as well would put a fourth report on the wire that
 * nobody asked for and that every later change to the three would have to keep
 * compatible.
 *
 * The *query* is shared, because those three reports take the same arguments and
 * a client that has learned to filter one has learned to filter all of them. The
 * two shapes below are spread into each report's own query schema the way
 * `pageQueryShape` is spread into each list's:
 *
 * ```ts
 * export const profitAndLossQuerySchema = z.strictObject({
 *   ...reportRangeShape,
 *   ...reportSliceShape,
 * });
 * ```
 *
 * ## Why nothing here carries `.meta({ id })`, still, with the routes built
 *
 * The transform lifts every schema carrying an `id` out of zod's global registry
 * into `components.schemas` whether or not a route references it, and A10 makes
 * drift in `openapi.json` a build failure. OB-045 added the ids to the three
 * reports' *responses* and deliberately added none here, for two reasons that are
 * both permanent rather than sequencing:
 *
 * This file's schemas are queries, and a query reaches an endpoint as individual
 * `parameters` — a component for one would be referenced by nothing. That includes
 * `reportDimensionFilterSchema`, which is the one place it costs something: the
 * filter is structured, so the routes carry it as a JSON-encoded string parameter
 * (`src/transport/routes/reports.ts` argues why), and a generated client therefore
 * gets a string where a named type would have been nicer. The alternative is an
 * unreachable component, which is the thing the rule forbids.
 */

/**
 * The most dimension values one filter may name.
 *
 * The same number as `PAGE_SIZE_MAX`, and for a reason rather than for symmetry: a
 * client filters by values it has listed, one page at a time, so a bound below the
 * page size would make a filter unable to express the page a user just selected
 * from. An axis with more values than this is filtered by listing fewer of them —
 * or by not filtering, since an unfiltered axis costs nothing.
 */
export const REPORT_FILTER_VALUES_MAX = 200;

/**
 * A restriction to part of one dimension axis.
 *
 * `valueIds` is a disjunction: a line matches if it carries any of them on this
 * axis. Two filters naming different axes are a conjunction — department = Sales
 * *and* project = Alpha — which is what makes the axes independent rather than
 * ordered.
 *
 * `includeUnassigned` is the part that is easy to leave out and expensive to add
 * later. A grouped report always has an unassigned bucket (D-18: "the unassigned
 * bucket is not optional"), so a user can always see a total for lines nobody
 * tagged — and the moment they click it, the drill-through needs a filter that
 * says *untagged on this axis*, which no list of value ids can express. It is
 * therefore part of the filter from the start, and a filter naming neither values
 * nor the unassigned bucket is refused rather than silently matching nothing.
 */
export const reportDimensionFilterSchema = z
  .strictObject({
    dimensionId: z.uuid(),
    valueIds: z.array(z.uuid()).max(REPORT_FILTER_VALUES_MAX).optional(),
    includeUnassigned: z.boolean().optional(),
  })
  .refine((filter) => (filter.valueIds?.length ?? 0) > 0 || filter.includeUnassigned === true, {
    error:
      'Name at least one dimension value, or set `includeUnassigned` to filter to the lines ' +
      'carrying no value on this axis. A filter that names neither matches nothing, which is ' +
      'a report of zeros rather than an error.',
  })
  .meta({
    description:
      'Restricts the report to lines carrying one of `valueIds` on this axis. Several filters ' +
      'on different axes all apply.',
  });

export type ReportDimensionFilter = z.infer<typeof reportDimensionFilterSchema>;

/**
 * The reporting period, as two inclusive bounds.
 *
 * M1's trial balance took a single `asOf` upper bound, which is one of the three
 * things reports need and not the general one. A P&L is a *range* ("this
 * quarter"), a balance sheet is a *point* ("as at 31 March"), and a general ledger
 * is a range *plus what came before it* — and all three are the same query once
 * the lower bound exists, because the postings before `from` are the opening
 * balance rather than a separate concept.
 *
 * Both bounds are optional and both are inclusive. Omitting `from` means the
 * ledger's beginning, which is the balance-sheet reading: everything up to `to` is
 * movement and the opening balance is zero. Omitting `to` means every posting to
 * date, which is exactly what `asOf` omitted meant.
 */
export const reportRangeShape = {
  from: calendarDateSchema.optional(),
  to: calendarDateSchema.optional(),
};

/**
 * Everything that narrows or divides a report, other than the dates.
 *
 * Separate from the range because the range is the part that means something
 * different in each of the three reports, and this part means the same thing in
 * all of them.
 *
 * `groupBy` names an axis, not a list of them. One axis produces one column per
 * value plus an unassigned column, which is a table a person reads; two axes
 * produce a cross-tabulation, which is a different presentation problem and not
 * one M2 has a screen for. The core can be widened to several axes without
 * changing this shape, so nothing here forecloses it.
 *
 * `types` exists so a P&L does not have to fetch the balance sheet's accounts and
 * discard them. It is safe against B7 for a reason that is a property of the chart
 * rather than of this filter: a parent's type must equal its children's
 * (`hierarchy.ts`), so no subtree spans two types and filtering by type therefore
 * removes whole trees rather than severing any.
 */
export const reportSliceShape = {
  types: z.array(z.enum(ACCOUNT_TYPES)).max(ACCOUNT_TYPES.length).optional(),
  contactId: z.uuid().optional(),
  dimensions: z.array(reportDimensionFilterSchema).max(MAX_DIMENSIONS_PER_ORG).optional(),
  groupBy: z.uuid().optional(),
};

/**
 * The core's own query: the range and the slice, and nothing else.
 *
 * The two refinements are both cases where the schema can say "this is a mistake"
 * and the aggregation can only say "here are your zeros".
 *
 * An inverted range is the obvious one. A repeated axis is the one worth
 * explaining: two filters on the same axis are conjoined like any other pair, and
 * because a line carries at most one value per axis
 * (`uq`/`PRIMARY KEY (org_id, journal_line_id, dimension_id)` in `0002_ledger`),
 * conjoining two of them matches nothing at all unless they name the same value.
 * A client that meant "Sales or Operations" writes one filter with two values, so
 * the repeated form is always the mistake and never the shorthand.
 */
export const accountBalancesQuerySchema = z
  .strictObject({ ...reportRangeShape, ...reportSliceShape })
  .refine((query) => query.from === undefined || query.to === undefined || query.from <= query.to, {
    error: 'The range ends before it starts.',
    path: ['to'],
  })
  .refine((query) => !hasRepeatedAxis(query.dimensions), {
    error:
      'Two filters name the same dimension. A line carries at most one value per axis, so ' +
      'filtering the same axis twice matches nothing — send one filter listing every value ' +
      'that should be included.',
    path: ['dimensions'],
  })
  .meta({
    description:
      'Inclusive date bounds, optional account-type, contact and dimension filters, and an ' +
      'optional axis to group by. Omitting `from` starts at the ledger’s beginning; omitting ' +
      '`to` includes every posting to date.',
  });

export type AccountBalancesQueryParams = z.infer<typeof accountBalancesQuerySchema>;

function hasRepeatedAxis(filters: readonly ReportDimensionFilter[] | undefined): boolean {
  if (filters === undefined) return false;
  return new Set(filters.map((filter) => filter.dimensionId)).size !== filters.length;
}
