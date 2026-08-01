import PdfPrinter from 'pdfmake';

// A deliberate deep import: `delivery`'s barrel (`modules/delivery/index.ts`) does not
// re-export its renderer internals, and `fonts.ts` (the bundled Roboto faces) has no reason
// to differ between the invoice renderer, the statement-package renderer, the
// account-statement renderer, and this one. `account-statements/renderer/index.ts`'s header
// gives the fuller argument for this exact import; restated tersely here.
import { loadDefaultFonts } from '../../delivery/renderer/fonts';

import { buildTen99FormDocDefinition } from './document';
import type { Ten99FormRenderInput, Ten99FormRenderer } from './types';

export type { Ten99FormRenderInput, Ten99FormRenderer };
export { buildTen99FormDocDefinition };

/**
 * The pdfmake-backed 1099-form renderer (OB-228; ROADMAP D-71 locks pdfmake, "not headless
 * Chromium"). `createTen99Renderer()` is the only export application code should call;
 * everything else in this directory is this file's implementation, mirroring
 * `account-statements/renderer/index.ts` line for line where the reasoning is identical —
 * that file's header carries the fuller argument for the pieces restated tersely below.
 *
 * ## Determinism
 *
 * pdfkit stamps `info.CreationDate = new Date()` on construction, which — left alone —
 * would make two renders of the identical `Ten99FormRenderInput` differ byte-for-byte purely
 * on wall-clock time. `DETERMINISTIC_CREATION_DATE` overrides it directly on the pdfkit
 * document pdfmake hands back, for `account-statements/renderer/index.ts`'s exact reason:
 * `createPdfKitDocument` forwards only `title`/`author`/`subject`/`keywords` out of
 * `docDefinition.info`, not a creation date, so reaching pdfkit's `.info` directly is the
 * only way to fix it. This matters more here than most renderers in this codebase: a
 * re-render of the same filed form (`ten99.service.ts#renderTen99FormPdf`, called again
 * after the first) must produce byte-identical output, since the artifact is stored at a
 * **deterministic** key and the second render simply overwrites the first — see that
 * function's own header for why `ten99_forms` being append-only makes that the design.
 *
 * ## What is assumed about the pdfmake surface, offline and unverified
 *
 * Authored in a worktree with no `node_modules`. Everything below is the same plausible
 * reading of pdfmake's long-documented node API `delivery/renderer/index.ts` and
 * `account-statements/renderer/index.ts` already assume, applied to a fourth document —
 * nothing here is a new assumption about the library, only a fourth call site for the same
 * one. See either of those files' own headers for the itemized list (the default export, the
 * `pdfmake/interfaces` types, `createPdfKitDocument`'s return shape, and the font descriptor
 * cast) — identical here.
 */

/**
 * The slice of pdfkit's `PDFDocument` this file touches. Named locally rather than sourced
 * from `@types/pdfkit` — see the header above for why. Identical to
 * `account-statements/renderer/index.ts`'s own declaration; not imported from there because
 * importing a `.ts` file for one interface would be a stranger coupling than repeating six
 * lines that describe pdfkit's own API, not this project's.
 */
interface PdfKitDocumentLike {
  info: { CreationDate?: Date };
  on(event: 'data', listener: (chunk: Buffer) => void): void;
  on(event: 'end', listener: () => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  end(): void;
}

/**
 * A fixed instant, not `new Date(0)` — `delivery/renderer/index.ts`'s reasoning: an epoch
 * timestamp on every generated PDF reads as a bug report waiting to happen the first time
 * someone opens its document properties.
 */
const DETERMINISTIC_CREATION_DATE = new Date('2000-01-01T00:00:00Z');

function renderToBytes(pdfDoc: PdfKitDocumentLike): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    pdfDoc.on('data', (chunk) => chunks.push(chunk));
    pdfDoc.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    pdfDoc.on('error', (error) => reject(error));
    pdfDoc.end();
  });
}

/** The pdfmake-backed `Ten99FormRenderer` (OB-228). See this file's header. */
export function createTen99Renderer(): Ten99FormRenderer {
  const fonts = loadDefaultFonts();
  const printer = new PdfPrinter(fonts);

  return {
    render(input: Ten99FormRenderInput): Promise<Uint8Array> {
      const docDefinition = buildTen99FormDocDefinition(input);
      const pdfDoc = printer.createPdfKitDocument(docDefinition) as unknown as PdfKitDocumentLike;
      pdfDoc.info.CreationDate = DETERMINISTIC_CREATION_DATE;

      return renderToBytes(pdfDoc);
    },
  };
}
