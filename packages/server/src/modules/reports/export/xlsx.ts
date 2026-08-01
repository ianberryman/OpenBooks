import type { TabularReport } from './tabular';

/**
 * A minimal, valid `.xlsx` workbook, hand-rolled — the repo carries no xlsx or zip
 * dependency and OB-220 adds none (`enableScripts: false`, and the
 * narrowest-surface rule `providers/*` follows for the same reason). An `.xlsx`
 * is a ZIP of five small XML parts; this file writes both layers itself rather
 * than reaching for a vendored one.
 *
 * ## Why inline strings, and no `sharedStrings.xml`
 *
 * A "real" Excel writer de-duplicates text into `xl/sharedStrings.xml` and has
 * every cell reference it by index. That is an optimisation for a workbook with
 * a lot of repeated text; a report export has none of that, and building the
 * dictionary is a second bookkeeping structure this file does not need to carry
 * to be a valid workbook. `t="inlineStr"` cells (`<is><t>…</t></is>`) are just as
 * legal a workbook part and let every cell be self-contained.
 *
 * ## Why store-only (no compression)
 *
 * The DEFLATE codec is the one part of the ZIP format Node's `zlib` would supply
 * for free, and it is deliberately not used: this file's job is the *container*
 * format, and adding a compressor would trade a few kilobytes on a report-sized
 * file for a second subsystem (with its own edge cases) this ticket does not need.
 * Store (compression method `0`) means "compressed size" and "uncompressed size"
 * are the same field twice, which is also what keeps the byte layout below simple
 * enough to verify by eye against the ZIP spec.
 *
 * ## Byte layout, verified against APPNOTE.TXT §4.3
 *
 * Three structures, all little-endian, all fixed at version 20 ("2.0", the
 * baseline that predates every extension this file does not use):
 *
 *  - **Local file header** (§4.3.7), immediately before each entry's bytes:
 *    signature `50 4B 03 04`, version(2), flags(2)=`0`, method(2)=`0` (store),
 *    mod time(2)=`0`, mod date(2)=`0`, crc-32(4), compressed size(4), uncompressed
 *    size(4) — equal under store — name length(2), extra length(2)=`0`, then the
 *    UTF-8 name.
 *  - **Central directory header** (§4.3.12), one per entry, written after every
 *    entry's local header + bytes: signature `50 4B 01 02`, version made by(2),
 *    version needed(2), flags(2), method(2), mod time/date(2+2), crc-32(4), the
 *    two sizes(4+4), name length(2), extra length(2)=`0`, comment length(2)=`0`,
 *    disk number(2)=`0`, internal attrs(2)=`0`, external attrs(4)=`0`, **the
 *    offset of this entry's local header from the start of the file**(4), name.
 *  - **End of central directory record** (§4.3.16), written once, last: signature
 *    `50 4B 05 06`, this disk(2)=`0`, disk with the CD start(2)=`0`, entries on
 *    this disk(2), total entries(2) — equal, one disk — central directory
 *    size(4), central directory offset(4), comment length(2)=`0`.
 *
 * Mod time/date fixed at `0` (ZIP's epoch, 1980-01-01) rather than the wall
 * clock, so two exports of the same report are byte-identical — worth stating
 * because it is the one field an ordinary ZIP writer fills from `Date.now()` and
 * this one deliberately does not.
 */

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;

/** "2.0" — store method, no encryption, no Zip64: the lowest version that describes this file. */
const ZIP_VERSION = 20;

/* ---------------------------------------------------------------------------
 * CRC-32 (ISO 3309 / ITU-T V.42), the polynomial APPNOTE.TXT and every common
 * ZIP tool use. Table-driven: 256 entries, built once at module load.
 * ------------------------------------------------------------------------- */

const CRC32_POLYNOMIAL = 0xedb88320;

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? CRC32_POLYNOMIAL ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

const CRC32_TABLE = buildCrc32Table();

/** Exported for `xlsx.test.ts` to assert stability directly, independent of the ZIP writer. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    const tableIndex = (crc ^ byte) & 0xff;
    crc = (CRC32_TABLE[tableIndex] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/* ---------------------------------------------------------------------------
 * Little-endian primitives and byte-buffer assembly.
 * ------------------------------------------------------------------------- */

function u16le(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff);
}

function u32le(value: number): Uint8Array {
  return Uint8Array.of(
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  );
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

interface ZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
}

/** Assembles a store-only ZIP from its parts. See the file header for the byte layout. */
function buildZip(entries: readonly ZipEntry[]): Uint8Array {
  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = utf8(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const localHeader = concat([
      u32le(LOCAL_FILE_HEADER_SIGNATURE),
      u16le(ZIP_VERSION),
      u16le(0), // general purpose bit flag
      u16le(0), // compression method: 0 = store
      u16le(0), // last mod file time — fixed for determinism, see the file header
      u16le(0), // last mod file date — fixed for determinism, see the file header
      u32le(crc),
      u32le(size), // compressed size == uncompressed size under store
      u32le(size),
      u16le(nameBytes.length),
      u16le(0), // extra field length
      nameBytes,
    ]);
    localChunks.push(localHeader, entry.data);

    const centralHeader = concat([
      u32le(CENTRAL_DIRECTORY_HEADER_SIGNATURE),
      u16le(ZIP_VERSION), // version made by
      u16le(ZIP_VERSION), // version needed to extract
      u16le(0), // general purpose bit flag
      u16le(0), // compression method
      u16le(0), // last mod file time
      u16le(0), // last mod file date
      u32le(crc),
      u32le(size),
      u32le(size),
      u16le(nameBytes.length),
      u16le(0), // extra field length
      u16le(0), // file comment length
      u16le(0), // disk number start
      u16le(0), // internal file attributes
      u32le(0), // external file attributes
      u32le(offset), // offset of this entry's local header from the start of the file
      nameBytes,
    ]);
    centralChunks.push(centralHeader);

    offset += localHeader.length + entry.data.length;
  }

  const centralDirectory = concat(centralChunks);
  const centralDirectoryOffset = offset;

  const endOfCentralDirectory = concat([
    u32le(END_OF_CENTRAL_DIRECTORY_SIGNATURE),
    u16le(0), // number of this disk
    u16le(0), // disk on which the central directory starts
    u16le(entries.length), // entries on this disk
    u16le(entries.length), // total entries
    u32le(centralDirectory.length),
    u32le(centralDirectoryOffset),
    u16le(0), // .ZIP file comment length
  ]);

  return concat([...localChunks, centralDirectory, endOfCentralDirectory]);
}

/* ---------------------------------------------------------------------------
 * OOXML parts.
 * ------------------------------------------------------------------------- */

/**
 * XML 1.0's five predefined entities, plus stripping the C0 control characters
 * the spec forbids outright (tab/LF/CR are legal and left alone). Character by
 * character rather than a control-character regex, so this needs no
 * eslint-disable for `no-control-regex` and stays trivially auditable.
 */
function xmlEscapeText(text: string): string {
  let escaped = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const isForbiddenControl =
      code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f);
    if (isForbiddenControl) continue;

    switch (char) {
      case '&':
        escaped += '&amp;';
        break;
      case '<':
        escaped += '&lt;';
        break;
      case '>':
        escaped += '&gt;';
        break;
      case '"':
        escaped += '&quot;';
        break;
      default:
        escaped += char;
    }
  }
  return escaped;
}

const INVALID_SHEET_NAME_CHARS = /[[\]:*?/\\]/g;

/** Excel's sheet-name rules: at most 31 characters, none of `[ ] : * ? / \`. */
function sanitizeSheetName(title: string): string {
  const cleaned = title.replace(INVALID_SHEET_NAME_CHARS, ' ').trim();
  return (cleaned.length > 0 ? cleaned : 'Sheet1').slice(0, 31);
}

const CONTENT_TYPES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '</Types>';

const PACKAGE_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  '</Relationships>';

const WORKBOOK_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
  '</Relationships>';

function buildWorkbookXml(sheetName: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets><sheet name="${xmlEscapeText(sheetName)}" sheetId="1" r:id="rId1"/></sheets>` +
    '</workbook>'
  );
}

type Cell =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'number'; readonly value: number };

function cellOf(value: string | number | null): Cell {
  if (value === null) return { kind: 'text', value: '' };
  return typeof value === 'number' ? { kind: 'number', value } : { kind: 'text', value };
}

/** `0` → `A`, `25` → `Z`, `26` → `AA` — the spreadsheet base-26 column name. */
function columnLetters(index: number): string {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function buildRowXml(rowNumber: number, cells: readonly Cell[]): string {
  const cellsXml = cells
    .map((cell, index) => {
      const ref = `${columnLetters(index)}${String(rowNumber)}`;
      if (cell.kind === 'number') return `<c r="${ref}" t="n"><v>${String(cell.value)}</v></c>`;
      if (cell.value === '') return `<c r="${ref}"/>`;
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscapeText(cell.value)}</t></is></c>`;
    })
    .join('');
  return `<row r="${String(rowNumber)}">${cellsXml}</row>`;
}

/**
 * The sheet's rows: title, optional subtitle, a blank divider row (skipped
 * rather than emitted — an absent row number reads as blank to Excel, same as a
 * present-but-empty one), the header, then the data. `csv.ts` deliberately omits
 * this heading; a worksheet has no reader that mis-shapes an extra row the way a
 * CSV importer does, so the richer sheet is the one that can afford it.
 */
function buildSheetDataXml(report: TabularReport): string {
  const rowsXml: string[] = [];
  let rowNumber = 1;

  rowsXml.push(buildRowXml(rowNumber, [{ kind: 'text', value: report.title }]));
  rowNumber += 1;

  if (report.subtitle !== undefined) {
    rowsXml.push(buildRowXml(rowNumber, [{ kind: 'text', value: report.subtitle }]));
    rowNumber += 1;
  }

  rowNumber += 1; // blank divider row

  rowsXml.push(
    buildRowXml(
      rowNumber,
      report.columns.map((column): Cell => ({ kind: 'text', value: column.label })),
    ),
  );
  rowNumber += 1;

  for (const row of report.rows) {
    rowsXml.push(buildRowXml(rowNumber, row.map(cellOf)));
    rowNumber += 1;
  }

  return rowsXml.join('');
}

function buildWorksheetXml(report: TabularReport): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${buildSheetDataXml(report)}</sheetData>` +
    '</worksheet>'
  );
}

/** Assembles the five OOXML parts and packages them as a store-only ZIP. */
export function toXlsx(report: TabularReport): Uint8Array {
  const sheetName = sanitizeSheetName(report.title);

  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: utf8(CONTENT_TYPES_XML) },
    { name: '_rels/.rels', data: utf8(PACKAGE_RELS_XML) },
    { name: 'xl/workbook.xml', data: utf8(buildWorkbookXml(sheetName)) },
    { name: 'xl/_rels/workbook.xml.rels', data: utf8(WORKBOOK_RELS_XML) },
    { name: 'xl/worksheets/sheet1.xml', data: utf8(buildWorksheetXml(report)) },
  ];

  return buildZip(entries);
}
