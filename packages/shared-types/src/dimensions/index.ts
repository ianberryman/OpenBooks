/**
 * The dimensions wire contract (OB-033, OB-037; ROADMAP D-18).
 *
 * Read `dimensions.ts` for the axis bound and how it was chosen, for why a
 * dimension's `code` is immutable while its `name` is not, for why a tag names a
 * value and never an axis, and for the rule that decides which schemas carry a
 * `.meta({ id })` — bodies and responses do, the two list queries do not.
 */

export type {
  CreateDimensionRequest,
  CreateDimensionValueRequest,
  Dimension,
  DimensionPage,
  DimensionValue,
  DimensionValuePage,
  JournalLineDimension,
  JournalLineDimensionList,
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
  dimensionPageSchema,
  dimensionSchema,
  dimensionValuePageSchema,
  dimensionValueSchema,
  journalLineDimensionListSchema,
  journalLineDimensionSchema,
  listDimensionValuesQuerySchema,
  listDimensionsQuerySchema,
  MAX_DIMENSIONS_PER_ORG,
  setJournalLineDimensionsRequestSchema,
  updateDimensionRequestSchema,
  updateDimensionValueRequestSchema,
} from './dimensions';
