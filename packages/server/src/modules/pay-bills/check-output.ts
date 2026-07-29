import { fromMinorUnits, toDecimalString } from '@openbooks/shared-types/money';
import PdfPrinter from 'pdfmake';
import vfsFonts from 'pdfmake/build/vfs_fonts.js';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';

import { storageProvider } from '../../providers';

/**
 * The one in-app rail's printable artifact (D-111): a check drawn from the
 * register in `check-register.repository.ts`, plus the stub a company keeps for
 * its own records. `ach`/`wire` are classification tags only (D-110) — they
 * produce no artifact and never reach this file.
 *
 * `bankAccountId` and `checkNumber` travel as plain values rather than the issue
 * service handing this a `PendingPayment`/`Payment`: this interface is the seam a
 * company feeding checks to an external printer swaps (the
 * `StorageProvider`/extraction-provider idiom), and the smaller the shape the
 * easier that implementation is to write against.
 */
export interface Check {
  readonly bankAccountId: string;
  readonly checkNumber: bigint;
  readonly payeeName: string;
  readonly amountMinor: bigint;
  readonly memo: string | null;
  /** Calendar date, e.g. `"2026-07-29"` — the check's own date, not `now()`. */
  readonly date: string;
}

/**
 * What issuing a check produces: an artifact key to retain (or `undefined` for
 * an implementation with nothing to store — a company that hands checks
 * straight to an external printer has no PDF of its own to keep).
 */
export interface CheckOutput {
  emit(check: Check): Promise<{ artifactKey?: string }>;
}

/**
 * The slice of pdfkit's `PDFDocument` this file touches. Named locally rather
 * than sourced from `@types/pdfkit`, for the reason `delivery/renderer/index.ts`
 * gives at length: `printer.createPdfKitDocument` returns a pdfkit document, and
 * declaring the two methods actually used avoids taking on a second, unreviewed
 * type dependency to describe the whole surface.
 */
interface PdfKitDocumentLike {
  on(event: 'data', listener: (chunk: Buffer) => void): void;
  on(event: 'end', listener: () => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  end(): void;
}

function renderToBytes(pdfDoc: PdfKitDocumentLike): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    pdfDoc.on('data', (chunk) => chunks.push(chunk));
    pdfDoc.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    pdfDoc.on('error', (error) => reject(error));
    pdfDoc.end();
  });
}

/** One family's four faces, keyed the way pdfmake's font descriptors are. */
interface FontFaces {
  readonly normal: Buffer;
  readonly bold: Buffer;
  readonly italics: Buffer;
  readonly bolditalics: Buffer;
}

const ROBOTO_FILES = {
  normal: 'Roboto-Regular.ttf',
  bold: 'Roboto-Medium.ttf',
  italics: 'Roboto-Italic.ttf',
  bolditalics: 'Roboto-MediumItalic.ttf',
} as const;

/**
 * Sourced from pdfmake's own bundled `vfs_fonts.js` rather than a `.ttf` vendored
 * into this package — `delivery/renderer/fonts.ts`'s exact reasoning, restated
 * here rather than imported from it: this module is a different seam (D-111's
 * `CheckOutput`, not the invoice renderer's `InvoiceRenderer`) with its own
 * swappable default, so it builds its own tiny `PdfPrinter` rather than reaching
 * into another module's internals for one.
 */
function fontBuffer(fileName: string): Buffer {
  const base64 = vfsFonts.pdfMake.vfs[fileName];
  if (base64 === undefined) {
    throw new Error(
      `pdfmake's bundled vfs_fonts.js has no entry for "${fileName}" — see the note in ` +
        "delivery/renderer/fonts.ts for the same assumption on the invoice renderer's side.",
    );
  }
  return Buffer.from(base64, 'base64');
}

function loadRobotoFonts(): FontFaces {
  return {
    normal: fontBuffer(ROBOTO_FILES.normal),
    bold: fontBuffer(ROBOTO_FILES.bold),
    italics: fontBuffer(ROBOTO_FILES.italics),
    bolditalics: fontBuffer(ROBOTO_FILES.bolditalics),
  };
}

const MUTED_TEXT_COLOR = '#555555';

/**
 * Cents → displayed decimal, routed through the money primitives rather than
 * `Number(amountMinor) / 100` (CLAUDE.md, D-13): a printed check is the one
 * artifact where a floating-point rounding slip would be a literal, signed
 * instrument, not just a wrong number on a screen.
 */
function formatAmount(amountMinor: bigint): string {
  return `$${toDecimalString(fromMinorUnits(amountMinor))}`;
}

/**
 * The check + stub document definition. Deliberately plain: check-printing
 * *fidelity* — MICR line, positive-pay layout, pre-printed stock alignment — is
 * an explicit fast-follow (ROADMAP "Explicitly out"), so this renders the fields
 * a reviewer needs to see are correct and no more. It is not built from
 * `InvoiceRenderInput`/`buildInvoiceDocDefinition`: a check shares pdfmake as a
 * library (D-111) but not a content shape with an invoice, and forcing one into
 * the other's input type would be a worse coupling than the few lines repeated
 * here.
 */
function buildCheckDocDefinition(check: Check): TDocumentDefinitions {
  const amount = formatAmount(check.amountMinor);

  const checkLines: Content[] = [
    { text: `Check No. ${check.checkNumber.toString()}`, style: 'heading' },
    { text: `Date: ${check.date}`, margin: [0, 4, 0, 0] },
    { text: `Pay to the order of: ${check.payeeName}`, margin: [0, 12, 0, 0] },
    { text: amount, style: 'amount', margin: [0, 4, 0, 0] },
  ];
  if (check.memo !== null) {
    checkLines.push({ text: `Memo: ${check.memo}`, margin: [0, 12, 0, 0] });
  }

  const stubLines: Content[] = [
    { text: '- - - - - - - - - - - - - - - - - - - - - - - -', margin: [0, 24, 0, 12] },
    { text: 'Stub — for your records', style: 'stubHeading' },
    { text: `Bank account: ${check.bankAccountId}` },
    { text: `Check No. ${check.checkNumber.toString()}` },
    { text: `Date: ${check.date}` },
    { text: `Pay to: ${check.payeeName}` },
    { text: `Amount: ${amount}` },
  ];
  if (check.memo !== null) {
    stubLines.push({ text: `Memo: ${check.memo}` });
  }

  return {
    content: [{ stack: checkLines }, { stack: stubLines }],
    defaultStyle: { font: 'Roboto' },
    styles: {
      heading: { fontSize: 14, bold: true },
      amount: { fontSize: 14, bold: true },
      stubHeading: { fontSize: 10, bold: true, color: MUTED_TEXT_COLOR },
    },
  };
}

/**
 * The default `CheckOutput` (D-111): renders a check + stub PDF and retains it
 * through `StorageProvider`, the same object store an invoice's PDF goes to.
 *
 * No org segment in the artifact key: `Check` carries no `orgId` (see its own
 * header on why the shape stays small), but `bankAccountId` is itself a
 * process-wide unique UUID, and a check number is gapless *per bank account*
 * (`check-register.repository.ts`) — so `bankAccountId`/`checkNumber` together
 * already name one artifact with no collision across orgs.
 */
function createPdfCheckOutput(): CheckOutput {
  const printer = new PdfPrinter({ Roboto: loadRobotoFonts() });

  return {
    async emit(check: Check): Promise<{ artifactKey?: string }> {
      const docDefinition = buildCheckDocDefinition(check);
      const pdfDoc = printer.createPdfKitDocument(docDefinition) as unknown as PdfKitDocumentLike;
      const bytes = await renderToBytes(pdfDoc);

      const artifactKey = `checks/${check.bankAccountId}/${check.checkNumber.toString()}.pdf`;
      await storageProvider().put(artifactKey, bytes, 'application/pdf');

      return { artifactKey };
    },
  };
}

let resolved: CheckOutput | undefined;

/**
 * The process-wide check output dependency, built on first use — the
 * `storageProvider()`/`outboundEmail()` seam (`providers/index.ts`) applied to
 * D-111's `CheckOutput`: a function rather than an exported `const` so importing
 * this module builds nothing, lazy so a role that never issues a check (e.g.
 * `migrate`) never constructs a `PdfPrinter`.
 *
 * One accessor with one real implementation, not a config-selected registry —
 * ROADMAP D-110/D-111 rule that out explicitly for PB: `pdf` is the only shipped
 * rail mechanic, and a registry built for a single implementation is the exact
 * shape spec §8 warns against (`providers/index.ts`'s `setOutboundEmail` makes
 * the same point). A company that prints externally swaps this whole function's
 * return value via `setCheckOutput`, not a config value this file switches on.
 */
export function checkOutput(): CheckOutput {
  resolved ??= createPdfCheckOutput();
  return resolved;
}

/**
 * Installs the check output dependency for the rest of the process.
 *
 * For hosts and tests, not services — the same seam `setStorageProvider` is
 * (`providers/index.ts`): a suite exercising `issuePendingPayment` installs an
 * implementation it also holds a reference to, so it can assert what `emit` was
 * called with — spec §11's "no mocks" applied here means a real, small
 * `CheckOutput` the test wrote, not a stubbed return value on the default one.
 */
export function setCheckOutput(impl: CheckOutput): void {
  resolved = impl;
}
