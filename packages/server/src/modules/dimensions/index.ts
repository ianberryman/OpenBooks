/**
 * Dimensions — the user-defined reporting axes and their values (OB-037; spec
 * §2.5, ROADMAP D-18).
 *
 * An axis is a way of dividing the business that the chart of accounts should not
 * be asked to carry: department, location, project, funding source. Values are the
 * divisions on it, and a *journal line* carries at most one value per axis — the
 * line and not the header, because a single entry legitimately splits rent across
 * three departments and header tagging would push the user into posting three
 * journals for one event (D-18).
 *
 * ## Surface
 *
 * | Operation                                         | Permission         |
 * | ------------------------------------------------- | ------------------ |
 * | `createDimension(input, ctx)`                     | `dimensions.write` |
 * | `getDimension(id, ctx)`                           | `dimensions.read`  |
 * | `listDimensions(query, ctx)`                      | `dimensions.read`  |
 * | `updateDimension(id, input, ctx)`                 | `dimensions.write` |
 * | `archiveDimension(id, ctx)`                       | `dimensions.write` |
 * | `unarchiveDimension(id, ctx)`                     | `dimensions.write` |
 * | `deleteDimension(id, ctx)`                        | `dimensions.write` |
 * | `createDimensionValue(dimensionId, input, ctx)`   | `dimensions.write` |
 * | `getDimensionValue(valueId, ctx)`                 | `dimensions.read`  |
 * | `listDimensionValues(dimensionId, query, ctx)`    | `dimensions.read`  |
 * | `updateDimensionValue(valueId, input, ctx)`       | `dimensions.write` |
 * | `archiveDimensionValue(valueId, ctx)`             | `dimensions.write` |
 * | `unarchiveDimensionValue(valueId, ctx)`           | `dimensions.write` |
 * | `deleteDimensionValue(valueId, ctx)`              | `dimensions.write` |
 * | `getJournalLineDimensions(lineId, ctx)`           | `dimensions.read`  |
 * | `setJournalLineDimensions(lineId, input, ctx)`    | `dimensions.write` |
 *
 * Both lists return one bounded page and an opaque cursor (D-21), keyed on
 * `(code, id)` — which is only safe because both codes are immutable, the same
 * dependency D-27 created for the chart of accounts.
 *
 * `(input, ctx)` and `ctx` as the source of the org follow the rest of the service
 * layer: spec §4 forbids an org as a loose parameter, so there is no signature here
 * into which another org's id could be passed. Nothing takes a transaction —
 * `src/db/transaction-scope.ts` propagates one ambiently.
 *
 * There are no routes. Transport is OB-045.
 *
 * ## Three decisions worth reading before changing anything here
 *
 * **An org may define at most `MAX_DIMENSIONS_PER_ORG` axes, and the number is
 * eight.** D-18 chose unlimited axes, said thirty of them make the general ledger
 * pathological, and said the bound belongs in this service — the schema cannot
 * express it, because MySQL has no per-partition row cap and a `CHECK` cannot count
 * rows in another table. The argument for eight, and for counting archived axes
 * against it, is on the constant in `shared-types/src/dimensions/dimensions.ts`.
 * `createDimension` takes the count under a lock, so the bound holds against two
 * concurrent creates rather than merely appearing to.
 *
 * **Archive is for what is in use; delete is for what never was.** A value journal
 * lines carry cannot be deleted — `fk_jld_value` is `ON DELETE RESTRICT`, so the
 * database is the guarantee and not this service's care — and the service turns the
 * refusal into a `precondition_failed` naming the reason rather than a 500.
 * Deleting an in-use value would restate every sliced report ever run without
 * moving a single amount, which is D-16's argument one level down and is dangerous
 * precisely because the trial balance would not change. A value nothing carries
 * deletes freely, matching `deleteAccount`; the same applies to an axis with no
 * values, via `fk_dimension_values_dimension`.
 *
 * **Retagging a posted line lives here, not in the posting path.** The argument is
 * on `tagging.service.ts` and in `0004_app_grants`: a tag is an analysis dimension
 * laid over the ledger rather than a term of the entry, which is why the tag table
 * is mutable while the line it tags is not, and why `openbooks/no-journal-writes`
 * names `journals` and `journal_lines` and deliberately not this table. Retagging
 * cannot change an amount — nothing in this module writes one — and the test suite
 * asserts that against a real trial balance rather than against the reading.
 *
 * One question is deliberately left open: **whether a line in a closed period may
 * be retagged.** There is an argument each way, and it belongs with the sliced
 * reports that would be restated (OB-053). Today the period is not consulted.
 */

export { MAX_DIMENSIONS_PER_ORG } from '@openbooks/shared-types';
export type {
  CreateDimensionRequest,
  CreateDimensionValueRequest,
  Dimension,
  DimensionPage,
  DimensionValue,
  DimensionValuePage,
  JournalLineDimension,
  ListDimensionValuesQuery,
  ListDimensionsQuery,
  SetJournalLineDimensionsRequest,
  UpdateDimensionRequest,
  UpdateDimensionValueRequest,
} from '@openbooks/shared-types';

export {
  archiveDimension,
  archiveDimensionValue,
  createDimension,
  createDimensionValue,
  deleteDimension,
  deleteDimensionValue,
  getDimension,
  getDimensionValue,
  listDimensions,
  listDimensionValues,
  unarchiveDimension,
  unarchiveDimensionValue,
  updateDimension,
  updateDimensionValue,
} from './dimensions.service';
export { getJournalLineDimensions, setJournalLineDimensions } from './tagging.service';
