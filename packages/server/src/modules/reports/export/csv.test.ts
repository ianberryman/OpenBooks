import { describe, expect, it } from 'vitest';

import type { TabularReport } from './tabular';
import { toCsv } from './csv';

/**
 * `toCsv`'s RFC 4180 shape (OB-220 part 2), pure and colocated — nothing here
 * reads a row, matching `payment-terms/compute-term.test.ts`'s own reason.
 */

const REPORT: TabularReport = {
  title: 'Test Report',
  subtitle: 'For the year',
  columns: [
    { key: 'name', label: 'Name' },
    { key: 'note', label: 'Note' },
    { key: 'amount', label: 'Amount', align: 'right' },
  ],
  rows: [
    ['Acme, Inc.', 'Says "hello"', '1500.00'],
    ['Multi\nline', 'plain', null],
    ['Ok', 'plain', 42],
  ],
};

describe('toCsv', () => {
  it('emits the column labels as the header row', () => {
    const lines = toCsv(REPORT).split('\r\n');
    expect(lines[0]).toBe('Name,Note,Amount');
  });

  it('quotes a field containing a comma', () => {
    const lines = toCsv(REPORT).split('\r\n');
    expect(lines[1]).toBe('"Acme, Inc.","Says ""hello""",1500.00');
  });

  it('doubles an embedded quote', () => {
    expect(toCsv(REPORT)).toContain('"Says ""hello"""');
  });

  it('quotes a field containing a line break, and leaves the break intact inside the quotes', () => {
    const lines = toCsv(REPORT).split('\r\n');
    // The embedded break is a lone `\n`, so splitting the whole document on `\r\n` does not
    // fall inside it — this is the same row as the source array, not two.
    expect(lines[2]).toBe('"Multi\nline",plain,');
  });

  it('renders a null cell as empty and a number cell as plain text', () => {
    const lines = toCsv(REPORT).split('\r\n');
    expect(lines[3]).toBe('Ok,plain,42');
  });

  it('joins every line with CRLF, including between the header and the first row', () => {
    const csv = toCsv(REPORT);
    expect(csv.split('\r\n')).toHaveLength(4);

    // Strip the one deliberately-embedded bare `\n` (inside the quoted field), then every
    // `\r\n` terminator: nothing should be left, i.e. no line is joined by a bare `\n` or `\r`.
    const withoutTerminators = csv.replace('Multi\nline', 'Multiline').replaceAll('\r\n', '');
    expect(withoutTerminators).not.toContain('\n');
    expect(withoutTerminators).not.toContain('\r');
  });

  it('carries no title line and no BOM — the document starts with the header row', () => {
    const csv = toCsv(REPORT);
    expect(csv.startsWith('Name,Note,Amount')).toBe(true);
    expect(csv.charCodeAt(0)).not.toBe(0xfeff);
  });

  it('is just the header for a report with no rows', () => {
    const empty: TabularReport = { ...REPORT, rows: [] };
    expect(toCsv(empty)).toBe('Name,Note,Amount');
  });

  it('does not quote a field with no special characters', () => {
    const plain: TabularReport = {
      title: 'Plain',
      columns: [{ key: 'a', label: 'A' }],
      rows: [['hello']],
    };
    expect(toCsv(plain)).toBe('A\r\nhello');
  });
});
