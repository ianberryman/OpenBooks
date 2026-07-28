import type { PublicInvoiceView } from '@openbooks/shared-types';
import { fromMinorString, toDecimalString } from '@openbooks/shared-types/money';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';

import type { InvoiceRenderInput } from './types';

/**
 * Builds the pdfmake document definition for one invoice — the pure, printer-free
 * half of the renderer (OB-125). `index.ts` is the only caller: it hands this
 * definition to `PdfPrinter` and streams the bytes out. Kept separate so the
 * layout can be asserted directly (`buildInvoiceDocDefinition` is a plain
 * function of `InvoiceRenderInput`, no pdfkit involved) rather than only through
 * PDF bytes, which embed drawn text as glyph ids for a subsetted TrueType font
 * and cannot be grepped for the strings this file wrote (see the test suite's
 * header for the fuller version of that argument).
 *
 * Draws, top to bottom: the letterhead (branding name + address, logo if given),
 * a "bill to" / invoice-meta block, the line-item table, the tax summary
 * (omitted when there is nothing to summarise), the totals, an optional memo,
 * and a footer carrying `branding.invoiceFooter` when the org set one.
 *
 * `branding.logoUrl` is never read here — `InvoiceRenderInput.logo` carries the
 * already-decoded bytes to embed, so this module has no dependency on the
 * storage adapter that resolved the URL.
 */

const DEFAULT_ACCENT_COLOR = '#1a1a1a';
const MUTED_TEXT_COLOR = '#555555';

/**
 * Cents string → displayed decimal string, e.g. `"150000"` → `"1500.00"`. Routed
 * through `fromMinorString`/`toDecimalString` rather than `Number(cents) / 100`
 * (CLAUDE.md, D-13): the latter is exactly the float path `openbooks/no-float-money`
 * exists to make unwritable, and here it would additionally be unchecked, since
 * `PublicInvoiceView` is a TS type with no runtime guarantee at this boundary —
 * `fromMinorString` is what actually verifies the string is canonical minor units.
 */
function formatMoney(cents: string): string {
  return toDecimalString(fromMinorString(cents));
}

/**
 * pdfkit (via pdfmake) embeds only PNG and JPEG. Sniffed from the magic bytes
 * rather than trusted from a caller-supplied mime type, because `logo` on the
 * contract is bare `Uint8Array` — there is no mime field to trust or mistrust.
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
function addressLines(branding: PublicInvoiceView['branding']): string[] {
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

function letterheadBlock(input: InvoiceRenderInput): Content {
  const { branding } = input.view;

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

/** "Bill to" on the left, the invoice number/dates/reference on the right. */
function addressesAndMetaBlock(view: PublicInvoiceView): Content {
  const metaRows: Content[][] = [
    [{ text: 'Invoice number', style: 'metaLabel' }, { text: view.documentNumber }],
    [{ text: 'Issue date', style: 'metaLabel' }, { text: view.issueDate }],
    [{ text: 'Due date', style: 'metaLabel' }, { text: view.dueDate }],
    ...(view.reference === null
      ? []
      : [[{ text: 'Reference', style: 'metaLabel' }, { text: view.reference }]]),
  ];

  return {
    columns: [
      {
        width: '*',
        stack: [
          { text: 'Bill to', style: 'sectionLabel' },
          { text: view.customerName, style: 'billTo' },
        ],
      },
      {
        width: 'auto',
        table: { body: metaRows },
        layout: 'noBorders',
        style: 'metaTable',
      },
    ],
    margin: [0, 0, 0, 20],
  };
}

function lineItemsTable(view: PublicInvoiceView): Content {
  const header: Content[] = ['Description', 'Qty', 'Unit price', 'Net', 'Tax', 'Total'].map(
    (text): Content => ({ text, style: 'tableHeader' }),
  );

  const rows: Content[][] = view.lines.map((line): Content[] => [
    { text: line.description },
    { text: line.quantity, alignment: 'right' },
    { text: formatMoney(line.unitAmount), alignment: 'right' },
    { text: formatMoney(line.netAmount), alignment: 'right' },
    { text: formatMoney(line.taxAmount), alignment: 'right' },
    { text: formatMoney(line.grossAmount), alignment: 'right' },
  ]);

  return {
    table: {
      headerRows: 1,
      widths: ['*', 'auto', 'auto', 'auto', 'auto', 'auto'],
      body: [header, ...rows],
    },
    layout: 'lightHorizontalLines',
    margin: [0, 0, 0, 12],
  };
}

function taxSummaryTable(view: PublicInvoiceView): Content {
  const header: Content[] = ['Tax', 'Rate', 'Net', 'Tax'].map((text): Content => ({
    text,
    style: 'tableHeader',
  }));

  const rows: Content[][] = view.taxSummary.map((row): Content[] => [
    { text: row.taxRateName ?? 'Untaxed' },
    { text: row.percentage === null ? '—' : `${row.percentage}%`, alignment: 'right' },
    { text: formatMoney(row.net), alignment: 'right' },
    { text: formatMoney(row.tax), alignment: 'right' },
  ]);

  return {
    table: { headerRows: 1, widths: ['*', 'auto', 'auto', 'auto'], body: [header, ...rows] },
    layout: 'lightHorizontalLines',
    margin: [0, 0, 0, 12],
  };
}

function totalsRow(label: string, cents: string, style: string): Content[] {
  return [
    { text: label, style },
    { text: formatMoney(cents), alignment: 'right', style },
  ];
}

function totalsBlock(view: PublicInvoiceView): Content {
  return {
    columns: [
      { width: '*', text: '' },
      {
        width: 'auto',
        table: {
          widths: ['auto', 'auto'],
          body: [
            totalsRow('Subtotal', view.totals.net, 'totalsLabel'),
            totalsRow('Tax', view.totals.tax, 'totalsLabel'),
            totalsRow('Total due', view.totals.gross, 'totalsGrand'),
          ],
        },
        layout: 'noBorders',
      },
    ],
    margin: [0, 0, 0, 12],
  };
}

function memoBlock(memo: string): Content {
  return { text: memo, style: 'memo', margin: [0, 12, 0, 0] };
}

export function buildInvoiceDocDefinition(input: InvoiceRenderInput): TDocumentDefinitions {
  const { view } = input;
  const accentColor = view.branding.brandColor ?? DEFAULT_ACCENT_COLOR;
  const footerText = view.branding.invoiceFooter;

  const content: Content[] = [
    letterheadBlock(input),
    addressesAndMetaBlock(view),
    lineItemsTable(view),
    ...(view.taxSummary.length > 0 ? [taxSummaryTable(view)] : []),
    totalsBlock(view),
    ...(view.memo === null ? [] : [memoBlock(view.memo)]),
  ];

  return {
    info: { title: `Invoice ${view.documentNumber}` },
    pageSize: 'A4',
    pageMargins: [40, 40, 40, 60],
    ...(input.logo === undefined ? {} : { images: { logo: logoDataUri(input.logo) } }),
    defaultStyle: { font: 'Roboto', fontSize: 10, color: '#1a1a1a' },
    styles: {
      orgName: { fontSize: 16, bold: true, color: accentColor },
      orgAddress: { fontSize: 9, color: MUTED_TEXT_COLOR },
      sectionLabel: { fontSize: 8, color: MUTED_TEXT_COLOR, margin: [0, 0, 0, 2] },
      billTo: { fontSize: 11, bold: true },
      metaLabel: { fontSize: 9, color: MUTED_TEXT_COLOR },
      metaTable: { fontSize: 9 },
      tableHeader: { bold: true, fontSize: 9, color: '#ffffff', fillColor: accentColor },
      totalsLabel: { fontSize: 10 },
      totalsGrand: { fontSize: 12, bold: true },
      memo: { fontSize: 9, color: MUTED_TEXT_COLOR, italics: true },
    },
    content,
    ...(footerText === null
      ? {}
      : {
          footer: (): Content => ({
            text: footerText,
            style: 'memo',
            alignment: 'center',
            margin: [40, 0, 40, 20],
          }),
        }),
  };
}
