import { z } from 'zod';

import { pageQueryShape } from '../wire';

/**
 * Request and response schemas for dimensions — the user-defined reporting axes
 * of ROADMAP D-18 (OB-033, OB-037).
 *
 * ## Why nothing here carries `.meta({ id })`
 *
 * `jsonSchemaTransformObject` copies *every* schema carrying an `id` out of zod's
 * global registry into `components.schemas`, whether or not a route references it,
 * and A10 makes drift in `openapi.json` a build failure. The rule stated at the
 * top of `accounts/accounts.ts` is that an `id` goes on a body or response schema
 * a route references and on nothing else — and OB-037 ends at the service, with
 * the routes arriving in OB-045. So the ids are added in the same diff as the
 * routes that use them, exactly as OB-018 left them off and OB-023 added them.
 *
 * That is also why the two page types below are hand-written rather than built
 * with `pageSchema`: the helper requires an `id`, because the only reason to have
 * a response *schema* rather than a response *type* is to publish it. OB-045
 * replaces both with `pageSchema(dimensionSchema, { id: 'DimensionPage', … })`,
 * which is a change to this file alone — the keys are the shared envelope's keys
 * (D-21), so nothing downstream moves.
 */

/**
 * Column widths, restated from `0002_ledger`.
 *
 * The inequality runs the safe way for the reason `accounts.ts` gives: MySQL's
 * `VARCHAR(n)` counts characters and `String.length` counts UTF-16 code units, so
 * a value this schema accepts cannot be truncated by the column. Silent
 * truncation of a dimension code would give an org two axes that print
 * identically in every sliced report.
 */
export const DIMENSION_CODE_MAX_LENGTH = 32;
export const DIMENSION_NAME_MAX_LENGTH = 120;
export const DIMENSION_DESCRIPTION_MAX_LENGTH = 512;
export const DIMENSION_VALUE_CODE_MAX_LENGTH = 32;
export const DIMENSION_VALUE_NAME_MAX_LENGTH = 120;

/**
 * How many axes one org may define (OB-037).
 *
 * D-18 chose unlimited user-defined axes over QBO's fixed Class + Location and
 * Xero's two tracking categories, said that an org with thirty of them makes the
 * general ledger pathological, and said the bound belongs in the service —
 * "chosen and written down, not left to be found in production". Migration
 * `0002_ledger` repeats that the schema cannot express it: MySQL has no
 * per-partition row cap and a `CHECK` cannot count rows in another table. This is
 * that number.
 *
 * ## Why eight
 *
 * Two costs scale with it, and both are named in D-18. `journal_line_dimensions`
 * is a join table, so a report grouped by *k* axes is a *k*-way join rather than
 * *k* column references; and a fully tagged line costs one tag row per axis, so
 * the tag table grows as lines × axes. At eight, a 100,000-line ledger has at
 * most 800,000 tag rows — an index that still fits in a buffer pool a small
 * business pays for — and the widest sliced report is an eight-way join. At
 * thirty, both numbers are four times worse and no report renders the result in a
 * way anyone reads.
 *
 * Eight rather than two or four because the axes real books name are recognisable
 * and there are more than two: department or cost centre, location or branch,
 * project or job, funding source, program, fund, campaign, vehicle. A charity
 * tracking fund and program alongside department already needs three, which is
 * where Xero's users start encoding the third axis into an account code — the
 * failure D-18 exists to avoid, and the same failure `ACCOUNT_MAX_DEPTH` names
 * from the other direction. Eight covers the recurring ones and leaves the ninth
 * to be the question it should be: whether that axis is really a *value* on one
 * of the eight.
 *
 * ## Why archived axes count against it
 *
 * The bound is on rows, not on active rows. An archived axis whose values journal
 * lines still carry is still a join in every historical sliced report and still
 * occupies its share of the tag table, so excluding it would exclude exactly the
 * axes that cost the most. The escape hatch from a full slate is therefore
 * deletion — which an axis nothing carries permits — and not archiving.
 */
export const MAX_DIMENSIONS_PER_ORG = 8;

/**
 * `.trim()` before the length checks, so they see the stored value.
 *
 * `uq_dimensions_org_code` would otherwise treat `'DEPT '` and `'DEPT'` as two
 * axes, and a report offering both is a report whose totals a user cannot
 * reconcile against either.
 */
const dimensionCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(DIMENSION_CODE_MAX_LENGTH)
  .meta({
    description:
      "Short reference unique within the org, e.g. `DEPT`. Compared under the column's " +
      '`utf8mb4_0900_ai_ci` collation, so it is case- and accent-insensitive. Immutable once ' +
      'created. Leading and trailing whitespace is trimmed.',
  });

const dimensionNameSchema = z.string().trim().min(1).max(DIMENSION_NAME_MAX_LENGTH).meta({
  description: 'Display name, e.g. `Department`.',
});

const dimensionDescriptionSchema = z
  .string()
  .trim()
  .max(DIMENSION_DESCRIPTION_MAX_LENGTH)
  .meta({ description: 'Optional free text. Send `null` to clear it.' });

const dimensionValueCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(DIMENSION_VALUE_CODE_MAX_LENGTH)
  .meta({
    description:
      'Short reference unique within its axis, e.g. `SALES`. Case- and accent-insensitive, and ' +
      'immutable once created.',
  });

const dimensionValueNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(DIMENSION_VALUE_NAME_MAX_LENGTH)
  .meta({ description: 'Display name, e.g. `Sales team`.' });

/**
 * One axis as the API returns it.
 *
 * `orgId` is absent and should stay absent, for the reason `accountSchema` gives:
 * every axis the caller can reach belongs to the context's org, so the field
 * would carry no information and would be one more place a cross-org id could
 * appear in a response.
 */
export const dimensionSchema = z.strictObject({
  id: z.uuid(),
  code: dimensionCodeSchema,
  name: dimensionNameSchema,
  description: dimensionDescriptionSchema.nullable(),
  isActive: z.boolean().meta({
    description:
      'An archived axis keeps every tag its values carry and every report they slice; it is ' +
      'simply not offered for new values or new tags. This is the only form of removal ' +
      'available to an axis whose values are in use.',
  }),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type Dimension = z.infer<typeof dimensionSchema>;

/**
 * One value on one axis.
 *
 * `dimensionId` is returned even though a value is always fetched in the context
 * of its axis: a tag names an axis and a value together (the three-column foreign
 * key in `0002_ledger` is what makes the pair a single fact), so a client holding
 * a value without its axis holds half a tag.
 */
export const dimensionValueSchema = z.strictObject({
  id: z.uuid(),
  dimensionId: z.uuid(),
  code: dimensionValueCodeSchema,
  name: dimensionValueNameSchema,
  isActive: z.boolean().meta({
    description:
      'An archived value keeps every journal line already tagged with it and cannot be chosen ' +
      'for a new tag.',
  }),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type DimensionValue = z.infer<typeof dimensionValueSchema>;

/**
 * `code` is required at creation and appears in no update schema.
 *
 * The same decision D-27 reached for account codes, reached the same way. The
 * mechanical half: the axis list is ordered by `code`, keyset pagination orders
 * by the column it sorts on, and a keyset over a *mutable* column silently drops
 * rows — rename the code and the row moves behind a cursor that has already
 * passed it. The accounting half: a code is the reference other things cite, and
 * `name` is the label. Renaming `DEPT` from "Department" to "Cost centre" is a
 * relabelling; renumbering `DEPT` to `CC` is a different axis wearing the old
 * one's tags.
 */
export const createDimensionRequestSchema = z.strictObject({
  code: dimensionCodeSchema,
  name: dimensionNameSchema,
  description: dimensionDescriptionSchema.nullish(),
});

export type CreateDimensionRequest = z.infer<typeof createDimensionRequestSchema>;

/**
 * Rename, and nothing else.
 *
 * `isActive` is deliberately absent: archiving is what the delete path's error
 * tells a caller to do instead, and a state change that decides whether an axis
 * is offered for new tagging should not be expressible as a side effect of
 * renaming it. `code` is absent because it is immutable — this is a
 * `strictObject`, so sending either is a `validation_failed` naming the field
 * rather than a silent drop.
 */
export const updateDimensionRequestSchema = z
  .strictObject({
    name: dimensionNameSchema.optional(),
    description: dimensionDescriptionSchema.nullish(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: 'Supply at least one field to change.',
  });

export type UpdateDimensionRequest = z.infer<typeof updateDimensionRequestSchema>;

export const createDimensionValueRequestSchema = z.strictObject({
  code: dimensionValueCodeSchema,
  name: dimensionValueNameSchema,
});

export type CreateDimensionValueRequest = z.infer<typeof createDimensionValueRequestSchema>;

/**
 * `name` is required rather than optional, because it is the only mutable field a
 * value has: an update with it absent would be an empty request, which the axis
 * schema has to spell as a `.refine()` and this one does not.
 */
export const updateDimensionValueRequestSchema = z.strictObject({
  name: dimensionValueNameSchema,
});

export type UpdateDimensionValueRequest = z.infer<typeof updateDimensionValueRequestSchema>;

/**
 * `isActive` is a real boolean and not a query-string flag, for the reason
 * `listAccountsQuerySchema` gives: a shared schema that accepted `'false'` would
 * accept it from a JSON body too, and `'false'` is truthy in every language an
 * integrator might use. Coercion is the route's job (OB-045), because the route
 * is the only layer that knows the value arrived as text.
 */
export const listDimensionsQuerySchema = z.strictObject({
  ...pageQueryShape,
  isActive: z.boolean().optional(),
});

/** The *input* type: `limit` carries a `.default()`, so parsed output is a different type. */
export type ListDimensionsQuery = z.input<typeof listDimensionsQuerySchema>;

export const listDimensionValuesQuerySchema = z.strictObject({
  ...pageQueryShape,
  isActive: z.boolean().optional(),
});

export type ListDimensionValuesQuery = z.input<typeof listDimensionValuesQuerySchema>;

/**
 * The complete set of values a journal line carries, named by value id alone.
 *
 * ## Why the axis is not in the request
 *
 * A tag is `(dimension, value)` and the two must agree — that is what the
 * three-column foreign key `fk_jld_value` exists to guarantee, because a tag
 * filed under the wrong axis silently moves money between slices. Accepting the
 * axis from the caller would make disagreement expressible and then refusable,
 * which is a worse version of the same guarantee: deriving the axis from the
 * value makes the mistake unrepresentable at the API too.
 *
 * ## Why a whole set rather than an add and a remove
 *
 * A line carries at most one value per axis (`PRIMARY KEY (org_id,
 * journal_line_id, dimension_id)`, which is what makes acceptance B6 true), so
 * "tag this line" is always a replacement on some axis and never an append. A
 * complete set makes that explicit, makes a retry of the same request a no-op
 * rather than a conflict, and gives clearing a tag a spelling — omit it — instead
 * of a second operation.
 *
 * Bounded by `MAX_DIMENSIONS_PER_ORG` because a line cannot carry more tags than
 * the org has axes; over that, at least two of them are duplicates on one axis.
 */
export const setJournalLineDimensionsRequestSchema = z.strictObject({
  valueIds: z
    .array(z.uuid())
    .max(MAX_DIMENSIONS_PER_ORG)
    .meta({
      description:
        'Every dimension value this line carries, after the call. An axis absent from the list ' +
        'is untagged; an empty list clears every tag. Two values on one axis is a ' +
        '`precondition_failed`, not a last-one-wins.',
    }),
});

export type SetJournalLineDimensionsRequest = z.infer<typeof setJournalLineDimensionsRequestSchema>;

/**
 * One tag, as read back from the table rather than echoed from the request.
 *
 * `lineId` is a string for the reason `postedJournalLineSchema` gives:
 * `journal_lines.id` is a `BIGINT` and a JSON number cannot carry it past 2^53.
 */
export const journalLineDimensionSchema = z.strictObject({
  lineId: z.string(),
  dimensionId: z.uuid(),
  dimensionValueId: z.uuid(),
});

export type JournalLineDimension = z.infer<typeof journalLineDimensionSchema>;

/**
 * The list envelope's shape without its `id`, for the reason given at the top of
 * this file. `items` and `nextCursor` are the keys `pageSchema` produces (D-21),
 * so a client written against this page reads the next one unchanged.
 */
export interface DimensionPage {
  readonly items: readonly Dimension[];
  readonly nextCursor: string | null;
}

export interface DimensionValuePage {
  readonly items: readonly DimensionValue[];
  readonly nextCursor: string | null;
}
