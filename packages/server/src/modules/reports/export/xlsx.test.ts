import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { TabularReport } from './tabular';
import { crc32, toXlsx } from './xlsx';

/**
 * `toXlsx`'s ZIP container (OB-220 part 2), pure and colocated — nothing here
 * reads a row, matching `payment-terms/compute-term.test.ts`'s own reason.
 *
 * There is no zip/xlsx library in this repo to check the output against, so this
 * file is its own decoder: it walks the end-of-central-directory record and the
 * central directory `toXlsx` writes, byte-for-byte per `xlsx.ts`'s own layout
 * comment, and asserts the container is internally consistent — the entry count
 * the directory claims, the offsets it points at, and the CRC-32 each entry's
 * recovered bytes actually hash to.
 */

const TEXT_DECODER = new TextDecoder();

function u16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function u32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

interface DecodedEntry {
  readonly name: string;
  readonly crc32: number;
  readonly size: number;
  readonly localHeaderOffset: number;
}

/** The end-of-central-directory record: fixed 22 bytes, since this writer emits no comment. */
function readEndOfCentralDirectory(bytes: Uint8Array): {
  totalEntries: number;
  centralDirectorySize: number;
  centralDirectoryOffset: number;
} {
  const eocd = bytes.slice(bytes.length - 22);
  expect(u32(eocd, 0)).toBe(0x06054b50);
  return {
    totalEntries: u16(eocd, 10),
    centralDirectorySize: u32(eocd, 12),
    centralDirectoryOffset: u32(eocd, 16),
  };
}

/** Walks the central directory, `xlsx.ts`'s 46-byte-fixed-header-plus-name layout. */
function readCentralDirectory(
  bytes: Uint8Array,
  offset: number,
  size: number,
): readonly DecodedEntry[] {
  const entries: DecodedEntry[] = [];
  let cursor = offset;
  const end = offset + size;

  while (cursor < end) {
    expect(u32(bytes, cursor)).toBe(0x02014b50);
    const crc = u32(bytes, cursor + 16);
    const uncompressedSize = u32(bytes, cursor + 24);
    const nameLength = u16(bytes, cursor + 28);
    const extraLength = u16(bytes, cursor + 30);
    const commentLength = u16(bytes, cursor + 32);
    const localHeaderOffset = u32(bytes, cursor + 42);
    const nameBytes = bytes.slice(cursor + 46, cursor + 46 + nameLength);

    entries.push({
      name: TEXT_DECODER.decode(nameBytes),
      crc32: crc,
      size: uncompressedSize,
      localHeaderOffset,
    });

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/** Recovers one entry's raw bytes from its local file header — store method, so no inflate. */
function extractEntryData(bytes: Uint8Array, entry: DecodedEntry): Uint8Array {
  const offset = entry.localHeaderOffset;
  expect(u32(bytes, offset)).toBe(0x04034b50);
  const nameLength = u16(bytes, offset + 26);
  const extraLength = u16(bytes, offset + 28);
  const dataStart = offset + 30 + nameLength + extraLength;
  return bytes.slice(dataStart, dataStart + entry.size);
}

const REPORT: TabularReport = {
  title: 'Trial Balance',
  subtitle: 'As of 2026-06-30',
  columns: [
    { key: 'code', label: 'Account code' },
    { key: 'name', label: 'Account name' },
    { key: 'debit', label: 'Debit', align: 'right' },
  ],
  rows: [
    ['1000', 'Cash', '1500.00'],
    ['4000', 'Revenue', null],
    ['9999', 'Count', 3],
  ],
};

describe('toXlsx', () => {
  const bytes = toXlsx(REPORT);

  it('starts with the local-file-header signature (PK\\x03\\x04)', () => {
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it('contains the end-of-central-directory signature (PK\\x05\\x06)', () => {
    const { totalEntries } = readEndOfCentralDirectory(bytes);
    expect(totalEntries).toBeGreaterThan(0);
  });

  it('the central directory lists exactly the five OOXML parts written', () => {
    const eocd = readEndOfCentralDirectory(bytes);
    const entries = readCentralDirectory(
      bytes,
      eocd.centralDirectoryOffset,
      eocd.centralDirectorySize,
    );
    expect(eocd.totalEntries).toBe(5);
    expect(entries.map((entry) => entry.name)).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/worksheets/sheet1.xml',
    ]);
  });

  it('every entry round-trips: its recovered bytes hash to the stored CRC-32', () => {
    const eocd = readEndOfCentralDirectory(bytes);
    const entries = readCentralDirectory(
      bytes,
      eocd.centralDirectoryOffset,
      eocd.centralDirectorySize,
    );
    for (const entry of entries) {
      const data = extractEntryData(bytes, entry);
      expect(data.length).toBe(entry.size);
      expect(crc32(data)).toBe(entry.crc32);
    }
  });

  it('the worksheet part contains the report’s cell values', () => {
    const eocd = readEndOfCentralDirectory(bytes);
    const entries = readCentralDirectory(
      bytes,
      eocd.centralDirectoryOffset,
      eocd.centralDirectorySize,
    );
    const sheet = entries.find((entry) => entry.name === 'xl/worksheets/sheet1.xml');
    expect(sheet).toBeDefined();
    const xml = TEXT_DECODER.decode(extractEntryData(bytes, sheet as DecodedEntry));

    expect(xml).toContain('<t xml:space="preserve">Trial Balance</t>');
    expect(xml).toContain('<t xml:space="preserve">As of 2026-06-30</t>');
    expect(xml).toContain('<t xml:space="preserve">Account code</t>');
    expect(xml).toContain('<t xml:space="preserve">1500.00</t>');
    // A `number`-typed cell (`3`) is a numeric cell, not text. Row 7: title(1) + subtitle(2) +
    // blank divider(3) + header(4) + three data rows(5,6,7), column C is the third column.
    expect(xml).toContain('<c r="C7" t="n"><v>3</v></c>');
  });

  it('the workbook part names the sheet from the report title', () => {
    const eocd = readEndOfCentralDirectory(bytes);
    const entries = readCentralDirectory(
      bytes,
      eocd.centralDirectoryOffset,
      eocd.centralDirectorySize,
    );
    const workbook = entries.find((entry) => entry.name === 'xl/workbook.xml');
    const xml = TEXT_DECODER.decode(extractEntryData(bytes, workbook as DecodedEntry));
    expect(xml).toContain('name="Trial Balance"');
  });

  it('escapes XML special characters in a cell', () => {
    const escaped = toXlsx({
      title: 'Escaping',
      columns: [{ key: 'a', label: 'A' }],
      rows: [['<Tom & "Jerry">']],
    });
    const eocd = readEndOfCentralDirectory(escaped);
    const entries = readCentralDirectory(
      escaped,
      eocd.centralDirectoryOffset,
      eocd.centralDirectorySize,
    );
    const sheet = entries.find((entry) => entry.name === 'xl/worksheets/sheet1.xml');
    const xml = TEXT_DECODER.decode(extractEntryData(escaped, sheet as DecodedEntry));
    expect(xml).toContain('&lt;Tom &amp; &quot;Jerry&quot;&gt;');
    expect(xml).not.toContain('<Tom & "Jerry">');
  });

  it('truncates a sheet name over 31 characters and strips characters Excel forbids', () => {
    const longTitle = toXlsx({
      title: 'A Report Title That Is Deliberately Much Too Long: For Real',
      columns: [{ key: 'a', label: 'A' }],
      rows: [],
    });
    const eocd = readEndOfCentralDirectory(longTitle);
    const entries = readCentralDirectory(
      longTitle,
      eocd.centralDirectoryOffset,
      eocd.centralDirectorySize,
    );
    const workbook = entries.find((entry) => entry.name === 'xl/workbook.xml');
    const xml = TEXT_DECODER.decode(extractEntryData(longTitle, workbook as DecodedEntry));
    const nameMatch = /name="([^"]*)"/.exec(xml);
    expect(nameMatch).not.toBeNull();
    const sheetName = nameMatch?.[1] ?? '';
    expect(sheetName.length).toBeLessThanOrEqual(31);
    expect(sheetName).not.toContain(':');
  });
});

describe('crc32', () => {
  it('matches the well-known "123456789" check value (0xCBF43926)', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('is zero for empty input', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('toXlsx (property)', () => {
  const cellArb = fc.oneof(
    fc.string(),
    fc.integer({ min: -1_000_000, max: 1_000_000 }),
    fc.constant(null),
  );

  const reportArb = fc
    .record({
      title: fc.string({ minLength: 1, maxLength: 40 }),
      columnLabels: fc.array(fc.string({ minLength: 1, maxLength: 10 }), {
        minLength: 1,
        maxLength: 4,
      }),
    })
    .chain(({ title, columnLabels }) =>
      fc
        .array(
          fc.array(cellArb, { minLength: columnLabels.length, maxLength: columnLabels.length }),
          {
            maxLength: 5,
          },
        )
        .map((rows): TabularReport => ({
          title,
          columns: columnLabels.map((label, index) => ({ key: `c${String(index)}`, label })),
          rows,
        })),
    );

  it('every entry the ZIP claims decodes to bytes matching its own CRC-32, over arbitrary small tables', () => {
    fc.assert(
      fc.property(reportArb, (report) => {
        const bytes = toXlsx(report);
        const eocd = readEndOfCentralDirectory(bytes);
        expect(eocd.totalEntries).toBe(5);

        const entries = readCentralDirectory(
          bytes,
          eocd.centralDirectoryOffset,
          eocd.centralDirectorySize,
        );
        for (const entry of entries) {
          const data = extractEntryData(bytes, entry);
          expect(crc32(data)).toBe(entry.crc32);
        }
      }),
    );
  });
});
