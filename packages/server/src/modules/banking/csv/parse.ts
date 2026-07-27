import type { BankDateOrder } from '@openbooks/shared-types';
import type { Money } from '@openbooks/shared-types/money';
import {
  MoneyParseError,
  ZERO,
  fromDecimalString,
  negate,
  subtract,
  toMinorUnits,
} from '@openbooks/shared-types/money';

import { ValidationError } from '../../../errors';
import type { ParsedStatement, ParsedStatementRow, StatementParser } from '../parser';

import type { CsvOptions } from './options';
import { tokenizeCsv, type CsvRecord } from './tokenize';

/**
 * The CSV `StatementParser` (OB-076; the seam in `../parser.ts`, ROADMAP D-41/D-42,
 * acceptance E1).
 *
 * Bytes and a mapping in, bank facts out. Two things in the contract it exists to
 * get right, both written down where they are decided rather than here:
 *
 *  - **The sign.** The amount comes out as signed minor units — positive money-in,
 *    negative money-out — resolved from whichever of the three conventions the file
 *    used (`resolveAmount`). Everything downstream then reads one convention (E4).
 *  - **The date order.** It is stated by the mapping and never inferred
 *    (`parseDate`). `01/02/2026` is a different month under `dmy` and `mdy`, and a
 *    detector that guesses is wrong on exactly the files where no day exceeds 12
 *    (`imports.ts`, `0006_banking`).
 *
 * There is no partial parse: a row this parser cannot read is a `ValidationError`
 * naming the row, thrown before any row is returned (`imports.ts`). And it does
 * **not** dedupe — occurrence index, fingerprint and the collapsing of identical
 * rows are OB-078's, because each needs lines this parser cannot see (`../parser.ts`).
 * So two byte-identical transactions produce two rows here, on purpose.
 */

/** The parser as the format registry consumes it. */
export const csvStatementParser: StatementParser<CsvOptions> = {
  parse: parseCsvStatement,
};

export function parseCsvStatement(raw: Uint8Array, opts: CsvOptions): ParsedStatement {
  const records = tokenizeCsv(decode(raw), opts.delimiter);
  const dataRecords = opts.hasHeaderRow ? records.slice(1) : records;

  const rows: ParsedStatementRow[] = dataRecords.map((record, index) =>
    toRow(record, index + 1, opts),
  );

  // Both null, and neither invented: a bare CSV states no closing balance and no
  // account identifier, so a format that cannot state one says so (D-46,
  // `../parser.ts`). OFX supplies both; that is OB-077's.
  return { rows, closingBalance: null, externalAccountId: null };
}

/**
 * A UTF-8 decode that drops a leading BOM.
 *
 * A byte-order mark on the first field would otherwise become part of the first
 * column's text — usually the posted date — and turn every first row into a date
 * that will not parse. Windows spreadsheet exports write one routinely.
 */
function decode(raw: Uint8Array): string {
  const text = new TextDecoder('utf-8').decode(raw);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function toRow(record: CsvRecord, dataRowNumber: number, opts: CsvOptions): ParsedStatementRow {
  const label = `row ${String(dataRowNumber)} (line ${String(record.line)})`;
  const columns = opts.columns;

  const postedDate = parseDate(
    requireCell(record, columns.postedDate, 'postedDate', label),
    opts.dateOrder,
    'postedDate',
    label,
  );

  const valueDate =
    columns.valueDate === null
      ? null
      : optionalDate(record, columns.valueDate, opts.dateOrder, label);

  return {
    postedDate,
    valueDate,
    amount: resolveAmount(record, opts, label),
    // Description is verbatim — not trimmed, not normalised of the bank's own noise
    // (`statement-lines.ts`). An empty description is a valid line.
    description: requireCell(record, columns.description, 'description', label),
    counterparty: columns.counterparty === null ? null : nullableCell(record, columns.counterparty),
    bankReference:
      columns.bankReference === null ? null : nullableCell(record, columns.bankReference),
  };
}

// ---------------------------------------------------------------------------
// Amounts — signed minor units, through the money module, never through a float
// ---------------------------------------------------------------------------

/**
 * The line's signed amount in minor units, per the file's convention.
 *
 * `debit_credit_columns`: the credit column is money **in** and the debit column is
 * money **out**, because the labels are the *bank's* accounting — your account is
 * their liability, so a deposit is a credit on their statement (`imports.ts`,
 * `0006_banking`). The amount is therefore `credit - debit`, which reads a
 * credit-only row as positive, a debit-only row as negative, and a bank that fills
 * the unused column with `0.00` correctly either way.
 *
 * `signed_reversed` is the credit-card convention, where a purchase is published as
 * positive; negating it puts money-out back to negative. `signed` is stored as-is.
 */
function resolveAmount(record: CsvRecord, opts: CsvOptions, label: string): bigint {
  const columns = opts.columns;

  if (opts.amountConvention === 'debit_credit_columns') {
    if (columns.credit === null || columns.debit === null) {
      throw mappingInconsistent('debit_credit_columns names both a debit and a credit column');
    }
    const credit = amountCell(record, columns.credit, 'credit', label);
    const debit = amountCell(record, columns.debit, 'debit', label);
    return toMinorUnits(subtract(credit, debit));
  }

  if (columns.amount === null) {
    throw mappingInconsistent(`${opts.amountConvention} names a single amount column`);
  }
  const money = decimalToMoney(
    requireCell(record, columns.amount, 'amount', label),
    'amount',
    label,
  );
  return toMinorUnits(opts.amountConvention === 'signed_reversed' ? negate(money) : money);
}

/** A debit/credit cell: empty (or an omitted trailing column) is zero, not a refusal. */
function amountCell(record: CsvRecord, index: number, field: string, label: string): Money {
  const raw = record.fields[index];
  if (raw === undefined || raw.trim() === '') return ZERO;
  return decimalToMoney(raw, field, label);
}

/**
 * A decimal cell to `Money`, through `fromDecimalString`.
 *
 * The money module is the authority on the format (D-13) and applies the storable
 * range, so the whole job here is to normalise the human presentation a bank prints
 * — thousands separators, a parenthesised negative — into the canonical decimal
 * that module accepts, as **string surgery before it**. Never `parseFloat(x) * 100`:
 * `4.55 * 100` is `454.999…`, and `openbooks/no-float-money` fails the build on it.
 */
function decimalToMoney(raw: string, field: string, label: string): Money {
  const normalised = normaliseDecimal(raw);
  try {
    return fromDecimalString(normalised);
  } catch (error) {
    if (error instanceof MoneyParseError) throw badAmount(raw, field, label);
    throw error;
  }
}

/**
 * Human decimal to the canonical form `fromDecimalString` accepts.
 *
 * Handles the three presentations a bank actually prints: a parenthesised negative
 * (`(4.50)` → `-4.50`), thousands separators (`1,234.50` → `1234.50`, including a
 * space as the separator), and a leading `+`. The decimal point is never touched,
 * and nothing here does arithmetic — the sign is carried as a character.
 */
function normaliseDecimal(raw: string): string {
  let value = raw.trim();
  let negative = false;

  const parenthesised = /^\((.*)\)$/.exec(value);
  if (parenthesised !== null) {
    negative = true;
    value = (parenthesised[1] ?? '').trim();
  }

  value = value.replace(/^\+/, '').replace(/[,\s]/g, '');
  if (negative && !value.startsWith('-')) value = `-${value}`;

  return value;
}

// ---------------------------------------------------------------------------
// Dates — strictly per the stated order, ISO YYYY-MM-DD out
// ---------------------------------------------------------------------------

/** Three runs of digits separated by any single non-digit (`/`, `-`, `.`). */
const DATE_PARTS = /^(\d+)\D(\d+)\D(\d+)$/;

/**
 * A date cell to ISO `YYYY-MM-DD`, read strictly in the stated `order`.
 *
 * A value that is not a valid date under that order — the wrong number of parts, a
 * month past 12, a day past the month's length — is a thrown `ValidationError`
 * naming the row, never a silent reinterpretation under a different order. The year
 * must be four digits: a two-digit year is ambiguous (`26` is 1926 or 2026) and
 * guessing a century is the same class of silent mis-dating the stated order exists
 * to refuse.
 */
function parseDate(value: string, order: BankDateOrder, field: string, label: string): string {
  const match = DATE_PARTS.exec(value.trim());
  if (match === null) throw badDate(value, order, field, label);

  const [, first = '', second = '', third = ''] = match;
  const parts = orderParts(order, first, second, third);

  if (parts.year.length !== 4) throw badDate(value, order, field, label);
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);

  if (month < 1 || month > 12) throw badDate(value, order, field, label);
  if (day < 1 || day > daysInMonth(year, month)) throw badDate(value, order, field, label);

  return `${parts.year}-${pad(month)}-${pad(day)}`;
}

/** A value-date cell: absent, an omitted trailing column, or empty is null; else parsed. */
function optionalDate(
  record: CsvRecord,
  index: number,
  order: BankDateOrder,
  label: string,
): string | null {
  const raw = record.fields[index];
  if (raw === undefined || raw.trim() === '') return null;
  return parseDate(raw, order, 'valueDate', label);
}

function orderParts(
  order: BankDateOrder,
  first: string,
  second: string,
  third: string,
): { readonly year: string; readonly month: string; readonly day: string } {
  switch (order) {
    case 'ymd':
      return { year: first, month: second, day: third };
    case 'dmy':
      return { day: first, month: second, year: third };
    case 'mdy':
      return { month: first, day: second, year: third };
  }
}

function daysInMonth(year: number, month: number): number {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return lengths[month - 1] ?? 0;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

// ---------------------------------------------------------------------------
// Cells and refusals
// ---------------------------------------------------------------------------

/** A required column's raw value, or a `ValidationError` when the row is too short. */
function requireCell(record: CsvRecord, index: number, field: string, label: string): string {
  const value = record.fields[index];
  if (value === undefined) {
    throw new ValidationError(`Statement ${label} is missing a column.`, [
      {
        path: field,
        message: `The mapping reads \`${field}\` from column ${String(index)}, and ${label} has ${String(record.fields.length)} column(s).`,
      },
    ]);
  }
  return value;
}

/** An optional column's value, with empty (or an omitted trailing column) as null. */
function nullableCell(record: CsvRecord, index: number): string | null {
  const value = record.fields[index];
  if (value === undefined || value.trim() === '') return null;
  return value;
}

function badDate(
  value: string,
  order: BankDateOrder,
  field: string,
  label: string,
): ValidationError {
  return new ValidationError(`Statement ${label} has an unreadable date.`, [
    {
      path: field,
      message: `${JSON.stringify(value)} is not a valid date in ${order} order. The order is stated by the mapping and never guessed (D-42).`,
    },
  ]);
}

function badAmount(value: string, field: string, label: string): ValidationError {
  return new ValidationError(`Statement ${label} has an unreadable amount.`, [
    {
      path: field,
      message: `${JSON.stringify(value)} is not an amount. Expected a decimal such as "1234.50", "-4.50" or "(4.50)".`,
    },
  ]);
}

/**
 * A mapping whose convention and columns disagree — a `debit_credit_columns`
 * mapping with no credit column, say. `bankImportMappingDefinitionSchema`'s
 * refinement and `chk_bim_convention` both refuse this, so it can only reach here
 * from a caller that bypassed both; it is a `ValidationError` about the mapping
 * rather than about any one row.
 */
function mappingInconsistent(expectation: string): ValidationError {
  return new ValidationError('The mapping is inconsistent with its amount convention.', [
    { path: 'mapping', message: `Expected that ${expectation}.` },
  ]);
}
