/**
 * The dimensions wire contract (OB-033, OB-037; ROADMAP D-18).
 *
 * Read `dimensions.ts` for the axis bound and how it was chosen, for why a
 * dimension's `code` is immutable while its `name` is not, for why a tag names a
 * value and never an axis, and for why nothing here carries a `.meta({ id })`
 * until OB-045 puts a route in front of it.
 */

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
} from './dimensions';
export {
  createDimensionRequestSchema,
  createDimensionValueRequestSchema,
  DIMENSION_CODE_MAX_LENGTH,
  DIMENSION_DESCRIPTION_MAX_LENGTH,
  DIMENSION_NAME_MAX_LENGTH,
  DIMENSION_VALUE_CODE_MAX_LENGTH,
  DIMENSION_VALUE_NAME_MAX_LENGTH,
  dimensionSchema,
  dimensionValueSchema,
  journalLineDimensionSchema,
  listDimensionValuesQuerySchema,
  listDimensionsQuerySchema,
  MAX_DIMENSIONS_PER_ORG,
  setJournalLineDimensionsRequestSchema,
  updateDimensionRequestSchema,
  updateDimensionValueRequestSchema,
} from './dimensions';
