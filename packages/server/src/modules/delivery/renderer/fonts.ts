import vfsFonts from 'pdfmake/build/vfs_fonts.js';

/**
 * The one font this renderer uses. Every string on `PublicInvoiceView` — the
 * customer name, the memo, the branding address — is free text with no
 * font-selection concept of its own, so one family covers the whole document;
 * `bold` dresses the letterhead name, the table headers and the grand total.
 *
 * Sourced from pdfmake's own bundled `vfs_fonts.js` rather than a `.ttf` vendored
 * into this package. `PdfPrinter`'s font descriptor normally names real files on
 * disk (`fs.readFileSync`d at print time), which is awkward for a container image
 * and would add a second, unreviewed binary dependency alongside pdfmake itself
 * (D-71 locked the PDF library, not a font). pdfmake's node build carries the
 * standard fonts pre-embedded as base64 in `build/vfs_fonts.js` for exactly this
 * — decoding them here needs nothing beyond the `pdfmake` dependency the
 * orchestrator is already adding.
 *
 * **Offline-unverified.** Authored without `node_modules` (see `index.ts`'s
 * header for the full list of pdfmake-surface assumptions this renderer makes).
 * Two things here specifically need confirming once the package is installed:
 *
 * 1. `pdfmake/build/vfs_fonts.js`'s export shape — assumed
 *    `{ pdfMake: { vfs: Record<string, string> } }`, the form pdfmake's node
 *    build has exported this file in across a long run of versions. If the
 *    installed version differs (e.g. a bare `{ vfs }` export), this file is the
 *    one place to fix — `pdfmake-vfs.d.ts` names the same assumption for the
 *    typechecker.
 * 2. Whether `PdfPrinter`'s font descriptor accepts a `Buffer` for each face, or
 *    only a file path `string`. The runtime historically reads each entry with
 *    `Buffer.isBuffer(entry) ? entry : fs.readFileSync(entry)`, so a `Buffer`
 *    works even where the published types say `string`; `index.ts` casts past
 *    the declared type at the one call site that constructs `PdfPrinter`, on
 *    that assumption.
 */
const ROBOTO_FILES = {
  normal: 'Roboto-Regular.ttf',
  bold: 'Roboto-Medium.ttf',
  italics: 'Roboto-Italic.ttf',
  bolditalics: 'Roboto-MediumItalic.ttf',
} as const;

function fontBuffer(fileName: string): Buffer {
  const base64 = vfsFonts.pdfMake.vfs[fileName];
  if (base64 === undefined) {
    throw new Error(
      `pdfmake's bundled vfs_fonts.js has no entry for "${fileName}" — the vendored font set ` +
        'may have changed between pdfmake versions; see the note at the top of fonts.ts.',
    );
  }
  return Buffer.from(base64, 'base64');
}

/** One family's four faces, keyed the way pdfmake's font descriptors are. */
type FontFaces = Record<'normal' | 'bold' | 'italics' | 'bolditalics', Buffer>;

/**
 * `PdfPrinter`'s constructor takes a dictionary of font *families* — each key a
 * family name, each value the four faces above — because a document definition
 * selects a face by naming a family (`document.ts`'s `defaultStyle: { font:
 * 'Roboto' }`), not by referencing a face directly. `{ normal: ... }` alone,
 * with no `Roboto` key, is a font descriptor for the *wrong* thing — pdfmake
 * would read it as "no family named 'Roboto' configured" the first time
 * anything asked for one. The caller (`index.ts`) casts the result to whatever
 * type the installed `pdfmake` actually declares for its constructor argument.
 */
export function loadDefaultFonts(): Record<'Roboto', FontFaces> {
  return {
    Roboto: {
      normal: fontBuffer(ROBOTO_FILES.normal),
      bold: fontBuffer(ROBOTO_FILES.bold),
      italics: fontBuffer(ROBOTO_FILES.italics),
      bolditalics: fontBuffer(ROBOTO_FILES.bolditalics),
    },
  };
}
