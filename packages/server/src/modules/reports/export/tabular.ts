import { fromMinorString, toDecimalString } from '@openbooks/shared-types';

/**
 * The canonical intermediate every report export flattens into (OB-220 part 2).
 *
 * `export.service.ts` calls the same report service the JSON route runs and hands
 * the result to one adapter in `adapters.ts`, which reduces whatever shape that
 * report has — sections, groups, a hierarchy, a keyset-paged list — down to this
 * one flat table. `csv.ts` and `toXlsx` (`xlsx.ts`) both serialise *this*, and
 * nothing else, which is what keeps two hand-rolled serialisers from having to
 * know seven report shapes between them.
 */

/** One column's identity, label, and how it prints. `align` is presentation only. */
export interface TabularColumn {
  readonly key: string;
  readonly label: string;
  readonly align?: 'left' | 'right';
}

/**
 * Rows are positional, matching `columns` by index — not by `key` — because a row
 * is a plain tuple of cells, not a record, and every adapter below builds it as
 * an array literal in column order. A `number` cell is a real number (a count, a
 * percentage) and prints right-aligned with no further formatting; `null` is an
 * empty cell, used for a section-heading row's unused columns. Money is
 * deliberately **not** `number` — see `moneyCell`.
 */
export interface TabularReport {
  readonly title: string;
  readonly subtitle?: string;
  readonly columns: readonly TabularColumn[];
  readonly rows: readonly (string | number | null)[][];
}

/**
 * Cents-string to decimal-string, for a money cell.
 *
 * Every report's amounts are already `minorUnitsSchema` strings (D-13) — exact
 * `bigint` arithmetic all the way to this boundary. Converting through
 * `Number` to build a spreadsheet cell would surrender that exactness in the one
 * place D-13 exists to protect (`cents / 100` in floating point is inexact), so
 * this goes through `fromMinorString`/`toDecimalString`, the same string-exact
 * pair `packages/web/src/money/format.ts` uses for display. The result is a
 * **string** cell, not a `number` one, for the same reason the wire format is a
 * string: a spreadsheet's own float column would immediately reintroduce the
 * precision loss this function exists to avoid.
 */
export function moneyCell(cents: string): string {
  return toDecimalString(fromMinorString(cents));
}
