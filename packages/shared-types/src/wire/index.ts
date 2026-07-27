/**
 * Scalar wire formats (OB-023). Read `wire.ts` for why money crosses JSON as a
 * cents-only string and why the schema delegates to `fromMinorString` rather than
 * restating its rules.
 */
export { calendarDateSchema, MINOR_UNITS_WIRE_PATTERN, minorUnitsSchema } from './wire';
/**
 * The list envelope and the page cursor (D-21). Read `pagination.ts` for why the
 * cursor is encoded — a cursor a client can parse makes the ordering columns part
 * of the public contract — and for why the page size is bounded rather than
 * clamped.
 */
export {
  PAGE_CURSOR_MAX_LENGTH,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  pageCursorSchema,
  pageLimitSchema,
  pageQueryShape,
  pageSchema,
} from './pagination';
