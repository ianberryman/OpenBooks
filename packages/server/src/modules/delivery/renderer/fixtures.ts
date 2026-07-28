import type { PublicInvoiceView } from '@openbooks/shared-types';

import type { InvoiceRenderInput } from './types';

/**
 * Sample `InvoiceRenderInput`s (OB-125), so this renderer is exercisable without
 * S1's branding service or a real invoice — the roadmap's own framing for S2:
 * "works standalone via a branding fixture (doesn't wait on S1)". Used by this
 * directory's own tests and available to any later integrator (S3's hosted-page
 * stub, C1) that wants a realistic `PublicInvoiceView` without standing up the
 * services that normally produce one.
 */

/**
 * The smallest PNG a decoder accepts: an 8-byte signature, one IHDR chunk
 * declaring a 1×1 grayscale image, one IDAT chunk, and IEND — 67 bytes total.
 * Widely reused in the JS ecosystem as *the* minimal test PNG, which is exactly
 * why it is used here rather than a hand-rolled one: it is real, decodable image
 * data, not a plausible-looking byte string. **Not independently verified
 * offline** against pdfmake/pdfkit's actual PNG decoder (no `node_modules` in
 * this worktree) — if `render()` throws on it once the dependency is installed,
 * regenerate a 1×1 PNG with any encoder and replace this constant; nothing else
 * in the renderer depends on its exact bytes.
 */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

export function tinyPngLogo(): Uint8Array {
  return Uint8Array.from(Buffer.from(TINY_PNG_BASE64, 'base64'));
}

/**
 * A multi-line invoice with a discount line, one tax rate, a full branding
 * block and a memo — the "everything is present" end of the input space.
 * Internally consistent with the invariant `documents.ts` states for the real
 * schema: `netAmount + taxAmount === grossAmount` per line, and `totals` is the
 * sum of the (rounded) lines rather than a rate applied to a sum.
 */
const fullView: PublicInvoiceView = {
  documentNumber: 'INV-1042',
  reference: 'PO-8831',
  issueDate: '2026-06-01',
  dueDate: '2026-06-30',
  lines: [
    {
      description: 'Consulting services — June',
      quantity: '12',
      unitAmount: '15000',
      netAmount: '180000',
      taxAmount: '14850',
      grossAmount: '194850',
    },
    {
      description: 'Software licence — annual',
      quantity: '1',
      unitAmount: '250000',
      netAmount: '250000',
      taxAmount: '20625',
      grossAmount: '270625',
    },
    {
      description: 'Onboarding discount',
      quantity: '1',
      unitAmount: '-5000',
      netAmount: '-5000',
      taxAmount: '-412',
      grossAmount: '-5412',
    },
  ],
  totals: {
    net: '425000',
    tax: '35063',
    gross: '460063',
  },
  taxSummary: [{ taxRateName: 'Standard VAT', percentage: '8.25', net: '425000', tax: '35063' }],
  memo: 'Thank you for your business — payment is due within 30 days.',
  customerName: 'Ferris Wheel Co',
  branding: {
    displayName: 'Acme Supplies Limited',
    addressLine1: '221B Baker Street',
    addressLine2: 'Marylebone',
    city: 'London',
    region: null,
    postalCode: 'NW1 6XE',
    country: 'United Kingdom',
    logoUrl: 'https://cdn.example.test/orgs/acme/logo.png',
    brandColor: '#0b5cff',
    invoiceFooter: 'Acme Supplies Limited — Company No. 01234567 — VAT GB123456789',
  },
  pdfUrl: 'https://books.example.test/public/invoices/abcd1234.secret-token/pdf',
};

export function fullInvoiceRenderInput(): InvoiceRenderInput {
  return { view: fullView, logo: tinyPngLogo() };
}

/**
 * The floor the renderer must not throw on: every nullable branding field null,
 * no logo, no memo, no reference, and no tax summary rows (an untaxed
 * document — `taxSummary` is legitimately `[]`, not a row with a null rate).
 */
const minimalView: PublicInvoiceView = {
  documentNumber: 'INV-1',
  reference: null,
  issueDate: '2026-01-01',
  dueDate: '2026-01-31',
  lines: [
    {
      description: 'Item',
      quantity: '1',
      unitAmount: '100',
      netAmount: '100',
      taxAmount: '0',
      grossAmount: '100',
    },
  ],
  totals: { net: '100', tax: '0', gross: '100' },
  taxSummary: [],
  memo: null,
  customerName: 'A Customer',
  branding: {
    displayName: 'A Company',
    addressLine1: null,
    addressLine2: null,
    city: null,
    region: null,
    postalCode: null,
    country: null,
    logoUrl: null,
    brandColor: null,
    invoiceFooter: null,
  },
  pdfUrl: 'https://books.example.test/public/invoices/wxyz9876.secret-token/pdf',
};

export function minimalInvoiceRenderInput(): InvoiceRenderInput {
  return { view: minimalView };
}
