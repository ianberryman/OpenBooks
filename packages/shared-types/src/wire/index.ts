/**
 * Scalar wire formats (OB-023). Read `wire.ts` for why money crosses JSON as a
 * cents-only string and why the schema delegates to `fromMinorString` rather than
 * restating its rules.
 */
export { calendarDateSchema, MINOR_UNITS_WIRE_PATTERN, minorUnitsSchema } from './wire';
