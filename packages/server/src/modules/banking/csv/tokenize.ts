/**
 * An RFC 4180 tokeniser (OB-076).
 *
 * ## Why hand-written rather than a dependency
 *
 * The one thing that must not be got wrong here is quoting, and a naive
 * `line.split(delimiter)` gets it wrong on the files that matter most: a quoted
 * field may contain the delimiter, a doubled quote (`""`) escaping a literal one,
 * and a newline. A bank narrative like `"COFFEE, LARGE"` or a two-line address in a
 * counterparty column is exactly where the split breaks, and it breaks silently —
 * the wrong number of columns, the amount read out of the description. A correct
 * tokeniser is small, so it is written once, here, and the parser above it never
 * sees a half-parsed field.
 *
 * ## What it is deliberately not
 *
 * It does not know what any column means, does not skip a header, and does not
 * decide what an amount or a date is. It turns bytes-of-text into records of raw
 * string fields and stops. Everything downstream — the header, the mapping, the
 * money and the dates — is `parse.ts`'s.
 */

/** One record: its raw string fields, and where it began in the source text. */
export interface CsvRecord {
  readonly fields: readonly string[];
  /**
   * The 1-based line number in the source text where this record starts. A record
   * can span several lines when a quoted field contains a newline, so this is the
   * line it opened on — which is what a "row N could not be read" message needs to
   * point a user at the right place in their file.
   */
  readonly line: number;
}

/**
 * Splits CSV text into records under a single-character `delimiter`
 * (`bankImportMappingDefinitionSchema` bounds it to one character).
 *
 * Line endings are `\n`, `\r\n`, or a lone `\r`, all treated as a record boundary.
 * A record that is a single empty field — a blank line, or the empty tail after a
 * trailing newline — is dropped rather than returned as a phantom row of nothing.
 */
export function tokenizeCsv(text: string, delimiter: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let started = false;
  let line = 1;
  let recordStartLine = 1;

  const endField = (): void => {
    fields.push(field);
    field = '';
  };

  const endRecord = (): void => {
    endField();
    // A single empty field is a blank line, not a transaction: dropping it here is
    // what keeps a trailing newline or a blank separator line from becoming a row
    // the parser then fails to read.
    if (!(fields.length === 1 && fields[0] === '')) {
      records.push({ fields, line: recordStartLine });
    }
    fields = [];
    started = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (!started) {
      recordStartLine = line;
      started = true;
    }

    if (inQuotes) {
      if (char === '"') {
        // A doubled quote inside a quoted field is one literal quote; a lone one
        // closes the field.
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (char === '\n') line += 1;
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      endField();
    } else if (char === '\r') {
      if (text[i + 1] === '\n') i += 1;
      line += 1;
      endRecord();
    } else if (char === '\n') {
      line += 1;
      endRecord();
    } else {
      field += char;
    }
  }

  // A final record with no trailing newline still has to be emitted; a file ending
  // exactly on a newline left `started` false and emits nothing, which is why the
  // guard is on `started` rather than on the buffers being non-empty.
  if (started) endRecord();

  return records;
}
