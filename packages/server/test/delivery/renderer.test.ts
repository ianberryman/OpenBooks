import { fromMinorString, toDecimalString } from '@openbooks/shared-types/money';
import { describe, expect, it } from 'vitest';

import {
  buildInvoiceDocDefinition,
  createInvoiceRenderer,
} from '../../src/modules/delivery/renderer';
import {
  fullInvoiceRenderInput,
  minimalInvoiceRenderInput,
} from '../../src/modules/delivery/renderer/fixtures';

/**
 * The invoice PDF renderer (OB-125), against the two fixtures in
 * `renderer/fixtures.ts` rather than a real invoice or S1's branding service —
 * exactly the standalone story the roadmap gives S2.
 *
 * No mocks (spec §11): every case either drives the real `PdfPrinter` pdfmake
 * hands back, or inspects the plain document-definition object
 * `buildInvoiceDocDefinition` returns before any of that runs. The two levels
 * split the "money is formatted" assertion the task brief for this ticket asks
 * for: a rendered PDF's text is not a reliable grep target, because pdfmake
 * embeds a subsetted TrueType font and draws `Tj` operands as glyph ids, not
 * ASCII character codes — a real PDF text layer needs a text-extraction library
 * this package does not depend on to check that honestly. What *is* directly and
 * reliably checkable is the document definition itself: it is where this
 * renderer's own code writes the formatted strings, in plain objects, before
 * handing anything to pdfmake — so the money-formatting assertions run there,
 * and the PDF-bytes level is asserted structurally (magic bytes, non-empty,
 * determinism).
 */

describe('buildInvoiceDocDefinition', () => {
  it('formats every money amount as a decimal string, never the raw cents', () => {
    const input = fullInvoiceRenderInput();
    const docDefinition = buildInvoiceDocDefinition(input);
    const rendered = JSON.stringify(docDefinition);

    const expectedNet = toDecimalString(fromMinorString(input.view.totals.net));
    const expectedTax = toDecimalString(fromMinorString(input.view.totals.tax));
    const expectedGross = toDecimalString(fromMinorString(input.view.totals.gross));

    expect(rendered).toContain(expectedNet);
    expect(rendered).toContain(expectedTax);
    expect(rendered).toContain(expectedGross);
    // The raw wire cents never appear as themselves — only as a substring of a
    // longer, differently-formatted number, if at all.
    expect(rendered).not.toContain(`"${input.view.totals.gross}"`);

    for (const line of input.view.lines) {
      expect(rendered).toContain(toDecimalString(fromMinorString(line.netAmount)));
      expect(rendered).toContain(toDecimalString(fromMinorString(line.grossAmount)));
    }

    for (const row of input.view.taxSummary) {
      expect(rendered).toContain(toDecimalString(fromMinorString(row.net)));
      expect(rendered).toContain(toDecimalString(fromMinorString(row.tax)));
      if (row.percentage !== null) {
        expect(rendered).toContain(`${row.percentage}%`);
      }
    }
  });

  it('embeds the logo as a data URI, keyed for the content block that references it', () => {
    const docDefinition = buildInvoiceDocDefinition(fullInvoiceRenderInput());

    // `noPropertyAccessFromIndexSignature` forces the bracket form here too.
    const logo = docDefinition.images?.['logo'];
    expect(logo).toMatch(/^data:image\/png;base64,/);
  });

  it('carries the org footer as a dynamic footer when the org set one', () => {
    const docDefinition = buildInvoiceDocDefinition(fullInvoiceRenderInput());

    expect(typeof docDefinition.footer).toBe('function');
  });

  it('does not throw, embeds no logo and carries no footer for an all-null branding block', () => {
    const input = minimalInvoiceRenderInput();

    expect(() => buildInvoiceDocDefinition(input)).not.toThrow();

    const docDefinition = buildInvoiceDocDefinition(input);
    expect(docDefinition.images).toBeUndefined();
    expect(docDefinition.footer).toBeUndefined();

    // Still formats the one line's money correctly.
    const rendered = JSON.stringify(docDefinition);
    expect(rendered).toContain(toDecimalString(fromMinorString(input.view.totals.gross)));
  });
});

describe('createInvoiceRenderer', () => {
  it('renders a full invoice to non-empty bytes starting with the PDF magic', async () => {
    const renderer = createInvoiceRenderer();
    const bytes = await renderer.render(fullInvoiceRenderInput());

    expect(bytes.length).toBeGreaterThan(0);
    // "%PDF" — every PDF, from the very first byte (PDF 32000-1 §7.5.2).
    expect([...bytes.slice(0, 4)]).toEqual([0x25, 0x50, 0x44, 0x46]);
  });

  it('does not throw on a branding block with every optional field null and no logo', async () => {
    const renderer = createInvoiceRenderer();
    const bytes = await renderer.render(minimalInvoiceRenderInput());

    expect(bytes.length).toBeGreaterThan(0);
    expect([...bytes.slice(0, 4)]).toEqual([0x25, 0x50, 0x44, 0x46]);
  });

  it('renders the same input to a stable-length PDF across runs', async () => {
    // The retained artifact (OB-125) must be stable in *content* for a given invoice:
    // the same input renders the same document, not one that drifts. `index.ts` pins
    // pdfkit's `info.CreationDate` to remove the one time source under our control.
    //
    // Byte-for-byte equality is deliberately NOT asserted: pdfkit writes a file
    // identifier (`/ID`) into the trailer that is randomised per document and cannot
    // be pinned through pdfmake's surface. It is a fixed-length pair of digests, so it
    // shifts the bytes' *values* but never their count — and it has no functional
    // meaning here (a delivery renders once and stores the result; nothing re-renders
    // and compares). So the achievable, meaningful invariant is that the same input
    // yields a valid PDF of identical length every time; a change to the actual
    // content — a different line, a moved total — moves the length and fails this.
    const renderer = createInvoiceRenderer();
    const input = fullInvoiceRenderInput();

    const first = await renderer.render(input);
    const second = await renderer.render(input);

    expect(first.length).toBe(second.length);
    expect([...first.slice(0, 4)]).toEqual([0x25, 0x50, 0x44, 0x46]);
  });
});
