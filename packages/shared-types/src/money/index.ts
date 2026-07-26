/**
 * The money surface. Application code uses these helpers and never raw
 * operators — `openbooks/no-float-money` enforces that (spec §11, §12).
 */

export type { Money } from './money';
export {
  MINOR_UNIT_EXPONENT,
  MoneyParseError,
  MAX_MONEY_MINOR_UNITS,
  MIN_MONEY_MINOR_UNITS,
  ZERO,
  abs,
  add,
  compare,
  equals,
  fromDecimalString,
  fromMajorMinor,
  fromMinorString,
  fromMinorUnits,
  isNegative,
  isPositive,
  isZero,
  negate,
  subtract,
  sum,
  toDecimalString,
  toMinorString,
  toMinorUnits,
} from './money';

export type { Ratio, RoundingMode } from './rounding';
export { DEFAULT_ROUNDING_MODE, ratio, ratioFromDecimalString, scale } from './rounding';

export { allocate, allocateEvenly } from './allocate';
