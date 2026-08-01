import type { AgingAmounts, AgingDocument } from '@openbooks/shared-types';
import { fromMinorString, toDecimalString } from '@openbooks/shared-types/money';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';

import type { CustomerStatementBranding, StatementRenderInput } from './types';

/**
 * Builds the pdfmake document definition for one customer statement (OB-220) —
 * the pure, printer-free half of the renderer, mirroring
 * `statements/renderer/document.ts`'s split for the same reason: a plain function
 * of `StatementRenderInput` can be asserted on directly, in a way PDF bytes (glyph
 * ids in a subsetted font) cannot.
 *
 * Draws, in order: a branded letterhead, the customer name and the as-at date, a
 * table of every open item the aging report returned for this contact, the same
 * five-bucket totals a `reports.read` holder sees on `/v1/reports/aging`, and a
 * bold balance due. Every open item prints, in the report's own sort order — no
 * row is hidden for being small, matching every statement in this codebase.
 */

const DEFAULT_ACCENT_COLOR = '#1a1a1a';
const MUTED_TEXT_COLOR = '#555555';

/**
 * Cents string → displayed decimal string. Routed through
 * `fromMinorString`/`toDecimalString` rather than `Number(cents) / 100` (CLAUDE.md,
 * D-13) for `statements/renderer/document.ts#formatMoney`'s exact reason: an
 * `AgingDocument`'s `total`/`outstanding` are TS strings with no runtime guarantee
 * at this boundary, and `fromMinorString` is what actually checks they are
 * canonical minor units — including the sign, since a credit row is negative.
 */
function formatMoney(cents: string): string {
  return toDecimalString(fromMinorString(cents));
}

/**
 * pdfkit (via pdfmake) embeds only PNG and JPEG. Sniffed from the magic bytes
 * rather than trusted from a caller-supplied mime type — `logo` on the contract is
 * bare `Uint8Array`, the same as `InvoiceRenderInput.logo`, and for the same reason
 * (`statements/renderer/document.ts`'s copy of this function).
 */
function detectImageMimeType(bytes: Uint8Array): 'image/png' | 'image/jpeg' {
  const isPng =
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a;
  if (isPng) return 'image/png';

  const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (isJpeg) return 'image/jpeg';

  throw new Error(
    'Logo bytes are neither a PNG nor a JPEG signature — pdfmake embeds only these two formats.',
  );
}

function logoDataUri(bytes: Uint8Array): string {
  const mimeType = detectImageMimeType(bytes);
  return `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`;
}

/** The address block under the org name, one line per non-empty part. */
function addressLines(branding: CustomerStatementBranding): string[] {
  const cityRegion = [branding.city, branding.region]
    .filter((part): part is string => part !== null)
    .join(', ');

  const candidates: (string | null)[] = [
    branding.addressLine1,
    branding.addressLine2,
    cityRegion === '' ? null : cityRegion,
    branding.postalCode,
    branding.country,
  ];

  return candidates.filter((line): line is string => line !== null);
}

function letterheadBlock(input: StatementRenderInput): Content {
  const { branding } = input;

  const nameAndAddress: Content = {
    stack: [
      { text: branding.displayName, style: 'orgName' },
      ...addressLines(branding).map((line): Content => ({ text: line, style: 'orgAddress' })),
    ],
  };

  if (input.logo === undefined) {
    return { columns: [nameAndAddress], margin: [0, 0, 0, 20] };
  }

  return {
    columns: [nameAndAddress, { image: 'logo', width: 100, alignment: 'right' }],
    margin: [0, 0, 0, 20],
  };
}

/**
 * `Reference` shows the document's free-text reference when the customer set one,
 * and falls back to the document number otherwise — a statement line with neither
 * would name nothing a recipient could match against their own records, and the
 * number is always present (`aging.service.ts#requireNumber`: an approved document
 * always carries one).
 */
function documentsTable(documents: readonly AgingDocument[]): Content {
  const header: Content[] = [
    'Date',
    'Reference',
    'Due date',
    'Days overdue',
    'Amount',
    'Balance',
  ].map((text): Content => ({ text, style: 'tableHeader' }));

  const body: Content[][] = documents.map((row): Content[] => [
    { text: row.issueDate },
    { text: row.reference ?? row.documentNumber },
    { text: row.dueDate ?? '—' },
    { text: row.daysPastDue === null ? '—' : row.daysPastDue.toString(), alignment: 'right' },
    { text: formatMoney(row.total), alignment: 'right' },
    { text: formatMoney(row.outstanding), alignment: 'right' },
  ]);

  return {
    table: {
      headerRows: 1,
      widths: ['auto', '*', 'auto', 'auto', 'auto', 'auto'],
      body: [header, ...body],
    },
    layout: 'lightHorizontalLines',
    margin: [0, 8, 0, 8],
  };
}

function bucketRow(label: string, cents: string): Content[] {
  return [{ text: label }, { text: formatMoney(cents), alignment: 'right' }];
}

/** The same five buckets `agingAmountsSchema` (shared-types) documents, current through 90+. */
function agingSummaryTable(totals: AgingAmounts): Content {
  const header: Content[] = ['Bucket', 'Amount'].map((text): Content => ({
    text,
    style: 'tableHeader',
  }));

  const body: Content[][] = [
    bucketRow('Current', totals.current),
    bucketRow('1–30 days', totals.days1To30),
    bucketRow('31–60 days', totals.days31To60),
    bucketRow('61–90 days', totals.days61To90),
    bucketRow('90+ days', totals.days90Plus),
    bucketRow('Total', totals.total),
  ];

  return {
    table: { headerRows: 1, widths: ['*', 'auto'], body: [header, ...body] },
    layout: 'lightHorizontalLines',
    margin: [0, 0, 0, 8],
  };
}

function balanceDueLine(closingBalanceMinor: string): Content {
  return {
    columns: [
      { width: '*', text: '' },
      {
        width: 'auto',
        text: `Balance due: ${formatMoney(closingBalanceMinor)}`,
        style: 'balanceDue',
      },
    ],
    margin: [0, 4, 0, 0],
  };
}

export function buildStatementDocDefinition(input: StatementRenderInput): TDocumentDefinitions {
  const accentColor = input.branding.brandColor ?? DEFAULT_ACCENT_COLOR;

  const content: Content[] = [
    letterheadBlock(input),
    { text: 'Statement of Account', style: 'coverTitle', margin: [0, 20, 0, 4] },
    { text: input.contactName, style: 'coverSubtitle' },
    { text: `As at ${input.asOf}`, style: 'coverSubtitle' },
    { text: `Generated ${input.generatedAt}`, style: 'coverMeta', margin: [0, 0, 0, 12] },
    documentsTable(input.documents),
    { text: 'Aging summary', style: 'subsectionTitle', margin: [0, 8, 0, 4] },
    agingSummaryTable(input.bucketTotals),
    balanceDueLine(input.closingBalanceMinor),
  ];

  return {
    info: { title: `Statement of Account — ${input.contactName} — ${input.asOf}` },
    pageSize: 'A4',
    pageMargins: [40, 40, 40, 60],
    ...(input.logo === undefined ? {} : { images: { logo: logoDataUri(input.logo) } }),
    defaultStyle: { font: 'Roboto', fontSize: 10, color: '#1a1a1a' },
    styles: {
      orgName: { fontSize: 16, bold: true, color: accentColor },
      orgAddress: { fontSize: 9, color: MUTED_TEXT_COLOR },
      coverTitle: { fontSize: 20, bold: true, color: accentColor },
      coverSubtitle: { fontSize: 12, color: MUTED_TEXT_COLOR },
      coverMeta: { fontSize: 9, color: MUTED_TEXT_COLOR },
      subsectionTitle: { fontSize: 11, bold: true },
      tableHeader: { bold: true, fontSize: 9, color: '#ffffff', fillColor: accentColor },
      balanceDue: { fontSize: 13, bold: true, color: accentColor },
    },
    content,
  };
}
