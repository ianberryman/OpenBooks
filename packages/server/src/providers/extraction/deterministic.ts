import type {
  DocumentExtractionProvider,
  ExtractedBill,
  ExtractedBillLine,
} from '@openbooks/plugin-api';

/**
 * The self-host `DocumentExtractionProvider` (D-07, initiative O): a real,
 * testable parser rather than a stub returning canned data — `providers/email/
 * log.ts`'s reasoning applied here: a self-host deployment with no LLM budget
 * still needs a working extraction path, and so does the E2E narrative that
 * exercises the whole capture pipeline without a live model call.
 *
 * Interprets the uploaded bytes as UTF-8 text of `key: value` lines and one
 * `line:` per item:
 *
 * ```
 * vendor: Acme Supplies
 * date: 2026-07-20
 * reference: INV-4471
 * tax: 0
 * line: Widgets | 2 | 15000
 * line: Freight | 1 | 5000
 * ```
 *
 * `line:` is `description | quantity | unitAmountMinor`. Unknown keys are
 * ignored and a missing or unparsable field is `null` rather than an error —
 * extraction is allowed to know less than everything; `document_captures` stages
 * exactly this partial read for a human to complete at review (see the capture
 * service contract). `total`, if present, is taken as given; if absent it is the
 * sum of each line's `quantity * unitAmountMinor`, computed in integer minor
 * units via the same micros scaling `recurring_invoice_template_lines` carries
 * quantity in, rather than floating point — even though nothing downstream posts
 * this figure, it is a summary the review screen displays, not a journal amount,
 * and there is no reason for a summary to be wrong when an exact answer costs no
 * more to compute.
 *
 * The `anthropic` adapter (deferred, see `./anthropic.ts`) replaces this with a
 * real Claude call over the same interface; this one is what proves the pipeline
 * end to end without one.
 */
export function createDeterministicExtractionProvider(): DocumentExtractionProvider {
  return {
    extract(input) {
      const text = new TextDecoder('utf-8').decode(input.body);
      return Promise.resolve(parseDeterministic(text));
    },
  };
}

/**
 * Quantity is carried as micros — a count scaled by 1,000,000 — for exact integer
 * arithmetic, the shape `recurring_invoice_template_lines.quantity_micros` uses.
 */
const QUANTITY_MICROS_SCALE = 1_000_000n;

const LINE_PREFIX = /^line\s*:/iu;
const QUANTITY_PATTERN = /^(-?\d+)(?:\.(\d{1,6}))?$/u;

function parseDeterministic(text: string): ExtractedBill {
  let vendorName: string | null = null;
  let issueDate: string | null = null;
  let reference: string | null = null;
  let taxMinor: string | null = null;
  let totalMinor: string | null = null;
  const lines: ExtractedBillLine[] = [];

  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === '') continue;

    if (LINE_PREFIX.test(line)) {
      const parsed = parseLine(line);
      if (parsed !== null) lines.push(parsed);
      continue;
    }

    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim().toLowerCase();
    const value = line.slice(colonIndex + 1).trim();
    if (value === '') continue;

    switch (key) {
      case 'vendor':
        vendorName = value;
        break;
      case 'date':
        issueDate = value;
        break;
      case 'reference':
        reference = value;
        break;
      case 'tax':
        taxMinor = value;
        break;
      case 'total':
        totalMinor = value;
        break;
      default:
        // Unknown keys are ignored, per the format's contract.
        break;
    }
  }

  return {
    vendorName,
    issueDate,
    reference,
    totalMinor: totalMinor ?? sumLines(lines),
    taxMinor,
    lines,
  };
}

/** `line: description | quantity | unitAmountMinor`. Malformed lines are dropped, not thrown. */
function parseLine(line: string): ExtractedBillLine | null {
  const content = line.slice(line.indexOf(':') + 1).trim();
  const parts = content.split('|').map((part) => part.trim());
  const [description, quantity, unitAmountMinor] = parts;
  if (quantity === undefined || quantity === '' || unitAmountMinor === undefined) return null;

  return {
    description: description === undefined || description === '' ? null : description,
    quantity,
    unitAmountMinor,
  };
}

/**
 * Sums `quantity * unitAmountMinor` across every line, in integer minor units.
 * `null` for no lines, or when nothing on the extraction parsed as a number — an
 * absent total stays absent rather than becoming a confident zero.
 */
function sumLines(lines: readonly ExtractedBillLine[]): string | null {
  let total = 0n;
  let counted = 0;

  for (const line of lines) {
    const unitAmountMinor = parseBigIntOrNull(line.unitAmountMinor);
    const quantityMicros = parseQuantityMicros(line.quantity);
    if (unitAmountMinor === null || quantityMicros === null) continue;
    total += (unitAmountMinor * quantityMicros) / QUANTITY_MICROS_SCALE;
    counted += 1;
  }

  return counted === 0 ? null : total.toString();
}

function parseBigIntOrNull(value: string): bigint | null {
  if (!/^-?\d+$/u.test(value)) return null;
  return BigInt(value);
}

/** A decimal quantity string (up to six fraction digits) into micros. */
function parseQuantityMicros(value: string): bigint | null {
  const match = QUANTITY_PATTERN.exec(value);
  if (match === null) return null;
  const whole = match[1];
  const fraction = (match[2] ?? '').padEnd(6, '0');
  if (whole === undefined) return null;
  const magnitude = BigInt(whole.replace('-', '')) * QUANTITY_MICROS_SCALE + BigInt(fraction);
  return whole.startsWith('-') ? -magnitude : magnitude;
}
