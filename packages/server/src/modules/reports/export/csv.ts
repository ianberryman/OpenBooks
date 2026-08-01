import type { TabularReport } from './tabular';

/**
 * RFC 4180 CSV, hand-rolled — the repo carries no csv dependency and OB-220 adds
 * none (`enableScripts: false`, and the narrowest-surface rule `providers/*`
 * follows for the same reason).
 *
 * ## Shape: header + rows, no title line
 *
 * `TabularReport.title`/`subtitle` are dropped rather than emitted as a leading
 * line. CSV has no concept of a "meta" row the way a worksheet has rows Excel
 * simply never asks about — every consumer of a `.csv` (a spreadsheet's *Import*
 * dialog, a `pandas.read_csv`, a re-upload into this API's own importer) assumes
 * row one is the header and row two is the first record, and a title line would
 * be a row that import silently mis-shapes into a data row with the wrong number
 * of fields. `toXlsx` (`xlsx.ts`) is the format that can afford a heading, because
 * a worksheet cell has no such contract with its reader.
 *
 * ## No BOM
 *
 * A UTF-8 byte-order mark is sometimes added so older Excel builds on Windows
 * detect the encoding rather than guessing Latin-1. It is left out here: this
 * project's money and text fields are already validated to be sane UTF-8, this
 * export has no legacy-Excel target to accommodate, and a BOM is one more byte a
 * test asserting "starts with the header row" would otherwise have to know about.
 */

/** RFC 4180 §2.6: a field is quoted if it contains a comma, a quote, or a line break. */
const NEEDS_QUOTING = /[",\r\n]/;

function escapeCsvField(field: string): string {
  if (!NEEDS_QUOTING.test(field)) return field;
  return `"${field.replace(/"/g, '""')}"`;
}

function formatCell(cell: string | number | null): string {
  if (cell === null) return '';
  return typeof cell === 'number' ? String(cell) : cell;
}

/** RFC 4180 §2.1: lines are terminated by CRLF, including the last one's separator from the next. */
export function toCsv(report: TabularReport): string {
  const lines = [
    report.columns.map((column) => escapeCsvField(column.label)).join(','),
    ...report.rows.map((row) => row.map((cell) => escapeCsvField(formatCell(cell))).join(',')),
  ];
  return lines.join('\r\n');
}
