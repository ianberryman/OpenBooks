import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { publicInvoiceViewSchema } from '@openbooks/shared-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  getPublicInvoiceArtifact,
  getPublicInvoiceView,
  mintDeliveryToken,
} from '../../src/modules/delivery';
import { setStorageProvider, storageProvider } from '../../src/providers';
import {
  createLocalStorageProvider,
  LOCAL_ARTIFACT_PREFIX,
} from '../../src/providers/storage/local';
import { approvedInvoiceIn, deliveryIn, useServiceDatabase } from './support';

/**
 * The hosted invoice page's data, end to end (OB-121; ROADMAP D-74): what a token
 * unlocks, and — the security-load-bearing half — what it never carries.
 *
 * `token.test.ts` covers the credential in isolation; this suite covers the shape a
 * customer actually sees, built from a real approved invoice going through
 * `createInvoice`/`approveInvoice` exactly as `test/invoices/invoices.service.test.ts`
 * does, so a wrong number here is a claim about the same arithmetic the authenticated
 * API makes, not about a hand-rolled fixture.
 *
 * `local` storage against a real temp directory (spec §11 again): the PDF endpoint's
 * claim is "the bytes that come back are the bytes that were put", and a mock cannot
 * prove that.
 */
const db = useServiceDatabase();

const encoder = new TextEncoder();

let basePath: string;

beforeAll(async () => {
  basePath = await mkdtemp(join(tmpdir(), 'openbooks-public-invoice-'));
  setStorageProvider(createLocalStorageProvider({ provider: 'local', basePath }));
});

afterAll(async () => {
  setStorageProvider(undefined);
  await rm(basePath, { recursive: true, force: true });
});

interface DeliveredInvoiceOverrides {
  readonly reference?: string;
  readonly memo?: string;
}

/** An approved invoice, retained as a fake PDF, with a minted and stored delivery token. */
async function deliveredInvoice(overrides: DeliveredInvoiceOverrides = {}) {
  const fixture = await approvedInvoiceIn(db, overrides);
  const minted = mintDeliveryToken();
  const orgHex = fixture.orgId.toString('hex');
  const invoiceHex = fixture.invoiceId.toString('hex');
  const artifactStorageKey = `orgs/${orgHex}/invoices/${invoiceHex}.pdf`;
  const pdfBytes = encoder.encode(`pdf bytes for invoice ${fixture.invoice.documentNumber}`);

  await storageProvider().put(artifactStorageKey, pdfBytes, 'application/pdf');
  await deliveryIn(db, {
    orgId: fixture.orgId,
    invoiceId: fixture.invoiceId,
    keyPrefix: minted.keyPrefix,
    tokenHash: minted.tokenHash,
    artifactStorageKey,
  });

  return { fixture, token: minted.token, artifactStorageKey, pdfBytes };
}

describe('getPublicInvoiceView', () => {
  it('renders the customer-safe view of a real approved invoice', async () => {
    const { fixture, token } = await deliveredInvoice({ reference: 'PO-100', memo: 'Thanks!' });

    const view = await getPublicInvoiceView(token);

    expect(view).toMatchObject({
      documentNumber: fixture.invoice.documentNumber,
      reference: 'PO-100',
      issueDate: fixture.invoice.issueDate,
      dueDate: fixture.invoice.dueDate,
      memo: 'Thanks!',
      customerName: 'Acme Ltd',
      totals: fixture.invoice.totals,
      pdfUrl: `/public/invoices/${token}/pdf`,
    });
    expect(view?.lines).toHaveLength(1);
    expect(view?.lines[0]).toMatchObject({
      description: 'Consulting',
      quantity: '2',
      unitAmount: '10000',
      netAmount: fixture.invoice.lines[0]?.netAmount,
      taxAmount: fixture.invoice.lines[0]?.taxAmount,
      grossAmount: fixture.invoice.lines[0]?.grossAmount,
    });
    expect(view?.taxSummary).toEqual(
      fixture.invoice.taxSummary.map(({ taxRateId: _taxRateId, ...rest }) => rest),
    );
  });

  it('carries no internal ids — validated structurally against the strict schema', async () => {
    const { token } = await deliveredInvoice();

    const view = await getPublicInvoiceView(token);
    expect(view).not.toBeNull();

    // Every object in this shape is a `strictObject` (`delivery.ts`'s file header);
    // parsing throws on any key — `journalId`, `contactId`, `orgId`, a line or tax
    // rate id — that should not be here. This is the runtime counterpart of the
    // compile-time check the function's own `Promise<PublicInvoiceView | null>`
    // return type already gives: this proves it against the value actually produced.
    expect(() => publicInvoiceViewSchema.parse(view)).not.toThrow();

    const serialized = JSON.stringify(view);
    const forbidden = [
      'journalId',
      'voidJournalId',
      'contactId',
      '"orgId"',
      'lineId',
      'accountId',
      'taxRateId',
      'logoStorageKey',
      'artifactStorageKey',
      'keyPrefix',
      'tokenHash',
    ];
    for (const key of forbidden) {
      expect(serialized).not.toContain(key);
    }
  });

  it('falls back to the org’s own name when branding has never been configured', async () => {
    const { fixture, token } = await deliveredInvoice();
    const org = await db.app
      .selectFrom('orgs')
      .select('name')
      .where('id', '=', fixture.orgId)
      .executeTakeFirstOrThrow();

    const view = await getPublicInvoiceView(token);

    expect(view?.branding).toEqual({
      displayName: org.name,
      addressLine1: null,
      addressLine2: null,
      city: null,
      region: null,
      postalCode: null,
      country: null,
      logoUrl: null,
      brandColor: null,
      invoiceFooter: null,
    });
  });

  it('renders branding once the org has set it, deriving a logoUrl and never the key', async () => {
    const { fixture, token } = await deliveredInvoice();

    await db.app
      .insertInto('org_branding')
      .values({
        org_id: fixture.orgId,
        display_name: 'Acme Supplies Ltd',
        address_line1: '1 Market St',
        address_line2: null,
        city: 'Springfield',
        region: null,
        postal_code: '00000',
        country: 'US',
        email: null,
        phone: null,
        website: null,
        tax_number: null,
        logo_storage_key: 'orgs/acme/logo.png',
        brand_color: '#123456',
        invoice_footer: 'Thanks for your business',
      })
      .execute();

    const view = await getPublicInvoiceView(token);

    expect(view?.branding).toMatchObject({
      displayName: 'Acme Supplies Ltd',
      addressLine1: '1 Market St',
      city: 'Springfield',
      postalCode: '00000',
      country: 'US',
      brandColor: '#123456',
      invoiceFooter: 'Thanks for your business',
    });
    // The local adapter's signedUrl is an app-relative path (`local.ts`'s header);
    // never the storage key itself.
    expect(view?.branding.logoUrl).toBe(`${LOCAL_ARTIFACT_PREFIX}orgs/acme/logo.png`);
  });

  it('returns null for a token that names no delivery', async () => {
    await expect(getPublicInvoiceView('unknown-prefix.unknown-secret')).resolves.toBeNull();
  });

  it('never crosses invoices between two different orgs’ tokens', async () => {
    const a = await deliveredInvoice({ reference: 'ORG-A-REF' });
    const b = await deliveredInvoice({ reference: 'ORG-B-REF' });

    const [viewA, viewB] = await Promise.all([
      getPublicInvoiceView(a.token),
      getPublicInvoiceView(b.token),
    ]);

    expect(viewA?.reference).toBe('ORG-A-REF');
    expect(viewA?.customerName).toBe('Acme Ltd');
    expect(viewB?.reference).toBe('ORG-B-REF');
    // Not a comparison of document numbers: two orgs each number from 1, so both
    // being freshly-created orgs' first invoice would coincide and prove nothing.
  });
});

describe('getPublicInvoiceArtifact', () => {
  it('streams exactly the retained PDF bytes, with an application/pdf content type', async () => {
    const { token, pdfBytes } = await deliveredInvoice();

    const artifact = await getPublicInvoiceArtifact(token);

    expect(artifact).not.toBeNull();
    expect(artifact?.contentType).toBe('application/pdf');
    expect([...(artifact?.bytes ?? [])]).toEqual([...pdfBytes]);
  });

  it('returns null for a token that names no delivery', async () => {
    await expect(getPublicInvoiceArtifact('unknown-prefix.unknown-secret')).resolves.toBeNull();
  });
});
