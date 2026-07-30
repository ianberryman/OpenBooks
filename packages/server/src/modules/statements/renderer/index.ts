import PdfPrinter from 'pdfmake';

// A deliberate deep import: `delivery`'s barrel (`modules/delivery/index.ts`) does
// not re-export its renderer internals, and `fonts.ts` — the bundled Roboto faces,
// base64-decoded out of pdfmake's own `vfs_fonts.js` — has no reason to differ
// between the invoice renderer and this one. Duplicating it would be a second copy
// to keep in sync with whatever pdfmake version the project runs; importing it
// costs one edge in the dependency graph instead. `.dependency-cruiser.cjs` has no
// rule against a module reaching a sibling module's non-barrel file directly, and
// nothing about `fonts.ts` is delivery-specific (see its own header).
import { loadDefaultFonts } from '../../delivery/renderer/fonts';

import { buildStatementPackageDocDefinition } from './document';
import type { StatementPackageRenderInput, StatementPackageRenderer } from './types';

export type { StatementPackageRenderInput, StatementPackageRenderer };
export { buildStatementPackageDocDefinition };

/**
 * The pdfmake-backed statement-package renderer (OB-195; ROADMAP D-71 locks
 * pdfmake, "not headless Chromium" — the same choice `delivery/renderer/index.ts`
 * was built against, restated here rather than shared because the two renderers
 * build unrelated document definitions and have no other reason to depend on each
 * other).
 *
 * `createStatementPackageRenderer()` is the only export application code should
 * call; everything else in this directory is this file's implementation, mirroring
 * `delivery/renderer/index.ts` line for line where the reasoning is identical —
 * that file's header carries the fuller argument for the pieces restated tersely
 * below.
 *
 * ## Determinism
 *
 * pdfkit stamps `info.CreationDate = new Date()` on construction, which — left
 * alone — would make two renders of the identical `StatementPackageRenderInput`
 * differ byte-for-byte purely on wall-clock time. `DETERMINISTIC_CREATION_DATE`
 * overrides it directly on the pdfkit document pdfmake hands back, for
 * `delivery/renderer/index.ts`'s exact reason: `createPdfKitDocument` forwards
 * only `title`/`author`/`subject`/`keywords` out of `docDefinition.info`, not a
 * creation date, so reaching pdfkit's `.info` directly is the only way to fix it.
 * `document.ts` itself reads the clock only through `StatementPackageRenderInput`'s
 * `generatedAt` field — never the ambient clock — so the document definition is
 * already a pure function of its input once that field is supplied.
 *
 * ## What is assumed about the pdfmake surface, offline and unverified
 *
 * Authored in a worktree with no `node_modules`. Everything below is the same
 * plausible reading of pdfmake's long-documented node API `delivery/renderer/index.ts`
 * already assumes, applied to a second document — nothing here is a new
 * assumption about the library, only a second call site for the same one:
 *
 * - `import PdfPrinter from 'pdfmake'` — the default export.
 * - `import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces'`
 *   (in `document.ts`).
 * - `printer.createPdfKitDocument(docDefinition)` returns a pdfkit `PDFDocument`,
 *   narrowed locally to `PdfKitDocumentLike` for `delivery/renderer/index.ts`'s
 *   reason: sidestepping whether `@types/pdfkit` is installed.
 * - `PdfPrinter`'s font descriptor accepting a `Buffer` per face, cast past the
 *   constructor parameter's declared type — `fonts.ts` is shared with the invoice
 *   renderer, so this assumption is verified the moment either renderer typechecks.
 */

/**
 * The slice of pdfkit's `PDFDocument` this file touches. Named locally rather
 * than sourced from `@types/pdfkit` — see the header above for why. Identical to
 * `delivery/renderer/index.ts`'s own declaration; not imported from there because
 * importing a `.ts` file for one interface would be a stranger coupling than
 * repeating six lines that describe pdfkit's own API, not this project's.
 */
interface PdfKitDocumentLike {
  info: { CreationDate?: Date };
  on(event: 'data', listener: (chunk: Buffer) => void): void;
  on(event: 'end', listener: () => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  end(): void;
}

/**
 * A fixed instant, not `new Date(0)` — `delivery/renderer/index.ts`'s reasoning:
 * an epoch timestamp on every generated PDF reads as a bug report waiting to
 * happen the first time someone opens its document properties.
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

/** The pdfmake-backed `StatementPackageRenderer` (OB-195). See this file's header. */
export function createStatementPackageRenderer(): StatementPackageRenderer {
  const fonts = loadDefaultFonts();
  const printer = new PdfPrinter(fonts);

  return {
    render(input: StatementPackageRenderInput): Promise<Uint8Array> {
      const docDefinition = buildStatementPackageDocDefinition(input);
      const pdfDoc = printer.createPdfKitDocument(docDefinition) as unknown as PdfKitDocumentLike;
      pdfDoc.info.CreationDate = DETERMINISTIC_CREATION_DATE;

      return renderToBytes(pdfDoc);
    },
  };
}
