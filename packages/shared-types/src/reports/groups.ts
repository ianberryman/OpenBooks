import { z } from 'zod';

/**
 * The bucket key a grouped report carries, declared once (OB-045).
 *
 * ## Why this file exists
 *
 * OB-042, OB-043 and OB-044 each wrote out the same three fields, because
 * `balances.ts` publishes a query and no response shapes and there was nowhere
 * shared to put them. Three tickets is where a repetition stops being a
 * coincidence: with routes in front of all three, `.meta({ id })` would have
 * published `ProfitAndLossGroupKey`, `BalanceSheetGroupKey` and a third identical
 * object as three unrelated components, and a client that learned to read one
 * slice header would have had to learn it again for the next. One component says
 * the true thing — a bucket is a dimension value, whatever report is bucketed.
 *
 * The core's `ReportGroupKey` in `modules/reports/balances.service.ts` is the same
 * three fields as a TypeScript interface. It is deliberately not replaced by
 * `z.infer` of this: the core has no wire contract by design, and giving it one
 * would publish the intermediate aggregation `balances.ts` argues against
 * publishing.
 *
 * ## Why a shape *and* a schema
 *
 * The two reports that group reference the schema, so the published document
 * carries one `$ref`. The general ledger's tag is these three fields **plus** the
 * axis they belong to — a tag names both halves, where a group key is already
 * qualified by the report's `groupBy` — so it spreads the shape instead, and stays
 * one flat component rather than an allOf composition that says nothing a reader
 * needs.
 */
export const reportGroupKeyShape = {
  dimensionValueId: z.uuid(),
  code: z.string(),
  name: z.string(),
};

/**
 * `null` in place of this object is the unassigned bucket, which is always present
 * (D-18): a slice view that omits untagged lines shows a smaller business than
 * exists, and it does it most on the accounts nobody remembered to tag.
 */
export const reportGroupKeySchema = z.strictObject(reportGroupKeyShape).meta({
  id: 'ReportGroupKey',
  description:
    'The dimension value one slice of a grouped report is for. A report grouped by an axis has ' +
    'one bucket per value plus an unassigned bucket, whose key is null.',
});

export type ReportGroupKey = z.infer<typeof reportGroupKeySchema>;
