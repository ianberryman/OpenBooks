import type { Ten99BoxCode, Ten99FormType } from '@openbooks/shared-types';
import { fromMinorString, toDecimalString } from '@openbooks/shared-types/money';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';

import type { Ten99FormBranding, Ten99FormRenderInput } from './types';

/**
 * Builds the pdfmake document definition for one filed 1099 form (OB-228) — the pure,
 * printer-free half of the renderer, mirroring `account-statements/renderer/document.ts`'s
 * split for the same reason: a plain function of `Ten99FormRenderInput` can be asserted on
 * directly, in a way PDF bytes (glyph ids in a subsetted font) cannot.
 *
 * Draws a recipient **Copy B** — the copy the vendor themselves receives, not the IRS's own
 * scannable Copy A — in the same "payer block / recipient block / boxed amount" layout the
 * real form takes, laid out with pdfmake tables rather than an image of the actual IRS form
 * (there is no requirement that Copy B match the IRS's paper layout pixel for pixel; only
 * Copy A, which this v1 never renders, does).
 */

const DEFAULT_ACCENT_COLOR = '#1a1a1a';
const MUTED_TEXT_COLOR = '#555555';

/** Cents string → displayed decimal string. `account-statements/renderer/document.ts#formatMoney`'s reason. */
function formatMoney(cents: string): string {
  return toDecimalString(fromMinorString(cents));
}

const FORM_TITLES: Record<Ten99FormType, string> = {
  '1099_nec': 'Form 1099-NEC',
  '1099_misc': 'Form 1099-MISC',
};

/** The reportable box label — v1's three (`TEN99_BOX_CODES`, `@openbooks/shared-types`). */
const BOX_LABELS: Record<Ten99BoxCode, string> = {
  nec_1: 'Box 1 — Nonemployee compensation',
  misc_1: 'Box 1 — Rents',
  misc_3: 'Box 3 — Other income',
};

/** pdfkit (via pdfmake) embeds only PNG and JPEG. `account-statements/renderer/document.ts`'s copy. */
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

/** The payer address block, one line per non-empty part — `account-statements`'s own helper. */
function addressLines(branding: Ten99FormBranding): string[] {
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

function letterheadBlock(input: Ten99FormRenderInput): Content {
  const { branding } = input;

  const nameAndAddress: Content = {
    stack: [
      { text: 'PAYER', style: 'blockLabel' },
      { text: branding.displayName, style: 'orgName' },
      ...addressLines(branding).map((line): Content => ({ text: line, style: 'orgAddress' })),
    ],
  };

  if (input.logo === undefined) {
    return { columns: [nameAndAddress], margin: [0, 0, 0, 16] };
  }

  return {
    columns: [nameAndAddress, { image: 'logo', width: 100, alignment: 'right' }],
    margin: [0, 0, 0, 16],
  };
}

/** Recipient's address snapshot: one line per `\n` — `ten99.service.ts#formatAddressSnapshot`'s own shape. */
function recipientAddressLines(address: string | null): string[] {
  return address === null ? [] : address.split('\n');
}

function recipientTinLine(taxIdLast4: string | null): string {
  return `TIN: ${taxIdLast4 === null ? 'not on file' : `···-··-${taxIdLast4}`}`;
}

function recipientBlock(input: Ten99FormRenderInput): Content {
  return {
    stack: [
      { text: 'RECIPIENT', style: 'blockLabel' },
      { text: input.recipientLegalName, style: 'orgName' },
      { text: recipientTinLine(input.recipientTinLast4), style: 'orgAddress' },
      ...recipientAddressLines(input.recipientAddress).map((line): Content => ({
        text: line,
        style: 'orgAddress',
      })),
    ],
    margin: [0, 0, 0, 16],
  };
}

function boxAmountTable(input: Ten99FormRenderInput): Content {
  const header: Content[] = ['Box', 'Amount'].map((text): Content => ({
    text,
    style: 'tableHeader',
  }));

  const body: Content[][] = [
    [
      { text: BOX_LABELS[input.boxCode] },
      { text: formatMoney(input.amountMinor), alignment: 'right' },
    ],
  ];

  return {
    table: { headerRows: 1, widths: ['*', 'auto'], body: [header, ...body] },
    layout: 'lightHorizontalLines',
    margin: [0, 0, 0, 12],
  };
}

export function buildTen99FormDocDefinition(input: Ten99FormRenderInput): TDocumentDefinitions {
  const accentColor = input.branding.brandColor ?? DEFAULT_ACCENT_COLOR;
  const title = FORM_TITLES[input.formType];

  const content: Content[] = [
    letterheadBlock(input),
    { text: title, style: 'coverTitle', margin: [0, 4, 0, 2] },
    { text: `Tax year ${String(input.taxYear)} — Copy B (for Recipient)`, style: 'coverSubtitle' },
    {
      text: '(This information is being furnished to the IRS.)',
      style: 'coverMeta',
      margin: [0, 0, 0, 16],
    },
    recipientBlock(input),
    boxAmountTable(input),
  ];

  return {
    info: { title: `${title} — ${input.recipientLegalName} — ${String(input.taxYear)}` },
    pageSize: 'A4',
    pageMargins: [40, 40, 40, 60],
    ...(input.logo === undefined ? {} : { images: { logo: logoDataUri(input.logo) } }),
    defaultStyle: { font: 'Roboto', fontSize: 10, color: '#1a1a1a' },
    styles: {
      blockLabel: { fontSize: 8, bold: true, color: MUTED_TEXT_COLOR },
      orgName: { fontSize: 13, bold: true, color: accentColor },
      orgAddress: { fontSize: 9, color: MUTED_TEXT_COLOR },
      coverTitle: { fontSize: 18, bold: true, color: accentColor },
      coverSubtitle: { fontSize: 11, color: MUTED_TEXT_COLOR },
      coverMeta: { fontSize: 8, color: MUTED_TEXT_COLOR, italics: true },
      tableHeader: { bold: true, fontSize: 9, color: '#ffffff', fillColor: accentColor },
    },
    content,
  };
}
