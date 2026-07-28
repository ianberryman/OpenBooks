import PdfPrinter from 'pdfmake';

import { buildInvoiceDocDefinition } from './document';
import { loadDefaultFonts } from './fonts';
import type { InvoiceRenderInput, InvoiceRenderer } from './types';

export type { InvoiceRenderInput, InvoiceRenderer };
export { buildInvoiceDocDefinition };

/**
 * The invoice PDF renderer (OB-125; ROADMAP D-71 locks pdfmake as the library,
 * "not headless Chromium" — deterministic and dependency-light rather than a
 * bundled browser in a deliberately slim runtime).
 *
 * `createInvoiceRenderer()` is the only export application code should call;
 * everything else in this directory is this file's implementation. Consumers
 * depend on the `InvoiceRenderer` interface (`types.ts`), not on pdfmake, so the
 * library choice stays swappable per D-71's own framing.
 *
 * `document.ts` builds the pdfmake document definition — a pure function of
 * `InvoiceRenderInput`, no pdfkit involved — and this file is only the part that
 * turns that definition into bytes: constructs `PdfPrinter` once (loading and
 * base64-decoding the bundled Roboto faces is not free, and nothing about it
 * varies between renders), then per call, creates the pdfkit document, pins its
 * creation timestamp (see below), and collects the streamed output into one
 * `Uint8Array`.
 *
 * ## Determinism
 *
 * pdfkit stamps `info.CreationDate = new Date()` when a document is constructed,
 * which — left alone — would make two renders of the identical
 * `InvoiceRenderInput` differ byte-for-byte purely on wall-clock time.
 * `DETERMINISTIC_CREATION_DATE` overrides it directly on the pdfkit document
 * pdfmake hands back, before any bytes are written: `createPdfKitDocument`
 * accepts `docDefinition.info` but forwards only a fixed set of keys
 * (`title`/`author`/`subject`/`keywords` in pdfmake's own docs) — not a creation
 * date — so reaching pdfkit's `.info` directly is the only way to fix it. Beyond
 * that, nothing in `document.ts` reads the clock, a random source, or iterates a
 * `Map`/`Set` whose order is not insertion order, so the document definition
 * itself is already a pure function of its input.
 *
 * What this has **not** independently verified offline: pdfkit's trailer `/ID`
 * entry, which on some versions is derived from more than `info` (see the
 * per-item note in `fonts.ts` and below for the fuller offline-authoring
 * context). If two renders of `fixtures.fullInvoiceRenderInput()` differ after
 * the `CreationDate` fix, that is the remaining source to check — the test in
 * `test/delivery/renderer.test.ts` that asserts byte-for-byte equality is the
 * tripwire for it.
 *
 * ## What is assumed about the pdfmake surface, offline and unverified
 *
 * Authored in a worktree with no `node_modules` (no build, no typecheck) — the
 * orchestrator adds the `pdfmake` dependency, installs it, and runs the gate.
 * Everything below is a plausible reading of pdfmake's long-documented node API
 * that could not be checked against the actually-installed version:
 *
 * - `import PdfPrinter from 'pdfmake'` — the default export is `PdfPrinter`,
 *   pdfmake's own long-standing README form. If the installed package ships no
 *   types (`pdfmake` itself, historically, often does not), this needs a
 *   `@types/pdfmake` devDependency, which is the orchestrator's addition to make
 *   alongside the runtime dependency.
 * - `import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces'`
 *   (in `document.ts`) — the commonly-documented path and export names for
 *   pdfmake's own TypeScript types. Kept to two names deliberately, to narrow
 *   what could be spelled wrong.
 * - `printer.createPdfKitDocument(docDefinition)` returns a pdfkit
 *   `PDFDocument`. Rather than depending on `@types/pdfkit` (an optional peer
 *   `pdfmake/interfaces` may or may not pull in) to type that return value, this
 *   file declares `PdfKitDocumentLike` below — the small slice of the pdfkit API
 *   actually used (`.info`, `.on('data'|'end'|'error', …)`, `.end()`) — and casts
 *   through `unknown` onto it. That sidesteps the `@types/pdfkit` question
 *   entirely rather than guessing whether it is installed.
 * - `PdfPrinter`'s font descriptor accepting a `Buffer` per face rather than only
 *   a file path `string` — argued in `fonts.ts`, cast past the constructor
 *   parameter's declared type via `ConstructorParameters<typeof PdfPrinter>[0]`
 *   so this file does not also have to name pdfmake's font-dictionary type.
 *
 * None of this is guesswork about *behaviour* — pdfmake's declarative
 * doc-definition shape (`content`, `table`, `columns`, `stack`, `styles`) is
 * stable and long-documented, which is what `document.ts` is built against.
 * What is genuinely unverified is only import paths, export names and exact
 * declared types — a typecheck away from confirming, which this worktree cannot
 * run.
 */

/**
 * The slice of pdfkit's `PDFDocument` this file touches. Named locally rather
 * than sourced from `@types/pdfkit` — see the header above for why.
 */
interface PdfKitDocumentLike {
  info: { CreationDate?: Date };
  on(event: 'data', listener: (chunk: Buffer) => void): void;
  on(event: 'end', listener: () => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  end(): void;
}

/**
 * A fixed instant, not `new Date(0)` — an epoch timestamp on every generated
 * invoice would read as a bug report waiting to happen the first time someone
 * opens a PDF's document properties. Any fixed instant satisfies determinism;
 * this one reads as "not a real creation time" without reading as an error.
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

/** The pdfmake-backed `InvoiceRenderer` (OB-125). See this file's header. */
export function createInvoiceRenderer(): InvoiceRenderer {
  const fonts = loadDefaultFonts();
  const printer = new PdfPrinter(fonts);

  return {
    render(input: InvoiceRenderInput): Promise<Uint8Array> {
      const docDefinition = buildInvoiceDocDefinition(input);
      const pdfDoc = printer.createPdfKitDocument(docDefinition) as unknown as PdfKitDocumentLike;
      pdfDoc.info.CreationDate = DETERMINISTIC_CREATION_DATE;

      return renderToBytes(pdfDoc);
    },
  };
}
