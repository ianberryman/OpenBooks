import { describe, expect, it } from 'vitest';

import { errorBody } from './harness';
import { authorizedWrite, createAccount, registerUser, useV1App } from './v1-support';
import type { Session } from './v1-support';
import type { App } from '../../src/transport/index';
import { generateOpenApiDocument } from '../../src/transport/index';

/**
 * OB-130's routes, end to end against real MySQL: `/v1/branding` and
 * `POST /v1/invoices/{id}/send` (ROADMAP "Phase 1 execution", stream S5).
 *
 * Like `v1-m3.test.ts`, these are boundary cases — the mapping reaching the right
 * service with the right arguments, the wire distinction a service depends on being
 * observable over HTTP — not a restatement of what `modules/branding` (S1) and
 * `modules/delivery` (C1) already prove about themselves. Two are here because here
 * is where they are true:
 *
 *  - **`PATCH /v1/branding` distinguishes absent from `null`**, exactly as
 *    `updateControlAccounts` does — only observable over the wire.
 *  - **A retried send does not double-email.** `POST …/send` is a write like any
 *    other on this surface: guarded by `withIdempotency`, so the *route* is what
 *    proves a duplicate key replays rather than sending twice.
 */

const harness = useV1App();

interface BrandingBody {
  readonly displayName: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly logoStorageKey: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

describe('branding', () => {
  it('is lazily created, round-trips a partial PATCH, and keeps absent distinct from null', async () => {
    const app = harness.app();
    const session = await registerUser(app, {
      email: 'branding-owner@example.invalid',
      orgName: 'Branding Co',
    });

    const initial = await app.inject({
      method: 'GET',
      url: '/v1/branding',
      headers: { cookie: session.cookie },
    });
    expect(initial.statusCode).toBe(200);
    const seeded = initial.json<BrandingBody>();
    expect(seeded.displayName).toBeTypeOf('string');

    const firstPatch = await app.inject({
      method: 'PATCH',
      url: '/v1/branding',
      headers: authorizedWrite(session, 'brand-1'),
      payload: { displayName: 'Branding Co Ltd', email: 'billing@branding-co.example' },
    });
    expect(firstPatch.statusCode).toBe(200);
    expect(firstPatch.json<BrandingBody>()).toMatchObject({
      displayName: 'Branding Co Ltd',
      email: 'billing@branding-co.example',
    });

    // Omitting `email` here must leave it as `firstPatch` set it — the absent/null
    // distinction `updateOrgBrandingRequestSchema`'s own comment argues for.
    const secondPatch = await app.inject({
      method: 'PATCH',
      url: '/v1/branding',
      headers: authorizedWrite(session, 'brand-2'),
      payload: { phone: '+1 555 0100' },
    });
    expect(secondPatch.statusCode).toBe(200);
    expect(secondPatch.json<BrandingBody>()).toMatchObject({
      displayName: 'Branding Co Ltd',
      email: 'billing@branding-co.example',
      phone: '+1 555 0100',
    });

    // An explicit `null` clears — the other half of the same distinction.
    const cleared = await app.inject({
      method: 'PATCH',
      url: '/v1/branding',
      headers: authorizedWrite(session, 'brand-3'),
      payload: { email: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json<BrandingBody>()).toMatchObject({
      displayName: 'Branding Co Ltd',
      email: null,
      phone: '+1 555 0100',
    });
  });

  it('refuses a PATCH with no fields to change', async () => {
    const app = harness.app();
    const session = await registerUser(app, {
      email: 'branding-empty@example.invalid',
      orgName: 'Empty Patch Co',
    });

    const response = await app.inject({
      method: 'PATCH',
      url: '/v1/branding',
      headers: authorizedWrite(session, 'brand-empty'),
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });

  it('refuses a read with no org scope', async () => {
    const app = harness.app();
    const response = await app.inject({ method: 'GET', url: '/v1/branding' });

    expect(response.statusCode).toBe(401);
  });

  /** The smallest valid PNG: a single transparent pixel. */
  const ONE_PIXEL_PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

  it('uploads a logo and returns it as the branding record’s logoStorageKey', async () => {
    const app = harness.app();
    const session = await registerUser(app, {
      email: 'branding-logo@example.invalid',
      orgName: 'Logo Co',
    });

    const uploaded = await app.inject({
      method: 'POST',
      url: '/v1/branding/logo',
      headers: authorizedWrite(session, 'brand-logo-1'),
      payload: {
        filename: 'mark.png',
        contentType: 'image/png',
        content: ONE_PIXEL_PNG_BASE64,
      },
    });

    expect(uploaded.statusCode).toBe(200);
    const branding = uploaded.json<BrandingBody>();
    expect(branding.logoStorageKey).toBeTypeOf('string');
  });

  it('refuses a content type outside the raster allowlist', async () => {
    const app = harness.app();
    const session = await registerUser(app, {
      email: 'branding-logo-svg@example.invalid',
      orgName: 'SVG Co',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/branding/logo',
      headers: authorizedWrite(session, 'brand-logo-svg'),
      payload: {
        filename: 'mark.svg',
        contentType: 'image/svg+xml',
        content: 'PHN2Zz48L3N2Zz4=',
      },
    });

    expect(response.statusCode).toBe(400);
  });
});

interface Books {
  readonly session: Session;
  readonly receivable: string;
  readonly revenue: string;
  readonly customer: string;
}

/**
 * The minimum a books needs to approve and then send an invoice: a receivable
 * control account nominated, a revenue account for the one line, an open fiscal
 * year, and one customer contact.
 */
async function setUpBooks(app: App, slug: string): Promise<Books> {
  const session = await registerUser(app, {
    email: `${slug}@example.invalid`,
    orgName: `${slug} Books`,
  });

  const [receivable, revenue] = await Promise.all([
    createAccount(app, session, {
      code: '1100',
      name: 'Accounts receivable',
      type: 'asset',
      normalBalance: 'debit',
    }),
    createAccount(app, session, {
      code: '4000',
      name: 'Sales',
      type: 'revenue',
      normalBalance: 'credit',
    }),
  ]);

  const year = await app.inject({
    method: 'POST',
    url: '/v1/fiscal-years',
    headers: authorizedWrite(session, `year-${slug}`),
    payload: { fiscalYear: 2026 },
  });
  if (year.statusCode !== 201) throw new Error(`fiscal year failed: ${year.body}`);

  const nominated = await app.inject({
    method: 'PATCH',
    url: '/v1/accounting-settings',
    headers: authorizedWrite(session, `settings-${slug}`),
    payload: { receivableControlAccountId: receivable },
  });
  if (nominated.statusCode !== 200) throw new Error(`nomination failed: ${nominated.body}`);

  const contact = await app.inject({
    method: 'POST',
    url: '/v1/contacts',
    headers: authorizedWrite(session, `contact-${slug}`),
    payload: {
      code: `${slug}-cust`,
      displayName: `${slug} Customer`,
      isCustomer: true,
      email: `${slug}-customer@example.invalid`,
    },
  });
  if (contact.statusCode !== 201) throw new Error(`contact failed: ${contact.body}`);

  return { session, receivable, revenue, customer: contact.json<{ id: string }>().id };
}

async function createAndApproveInvoice(app: App, books: Books, key: string): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/v1/invoices',
    headers: authorizedWrite(books.session, `${key}-create`),
    payload: {
      contactId: books.customer,
      issueDate: '2026-03-01',
      dueDate: '2026-03-31',
      taxMode: 'exclusive',
      lines: [
        {
          description: 'Consulting',
          quantity: '1',
          unitAmount: '100000',
          accountId: books.revenue,
        },
      ],
    },
  });
  if (created.statusCode !== 201) throw new Error(`create invoice failed: ${created.body}`);
  const { id } = created.json<{ id: string }>();

  const approved = await app.inject({
    method: 'POST',
    url: `/v1/invoices/${id}/approve`,
    headers: authorizedWrite(books.session, `${key}-approve`),
  });
  if (approved.statusCode !== 200) throw new Error(`approve invoice failed: ${approved.body}`);

  return id;
}

interface DeliveryBody {
  readonly id: string;
  readonly invoiceId: string;
  readonly recipientEmail: string;
  readonly status: string;
  readonly publicUrl: string;
  readonly artifactStorageKey: string;
}

describe('sendInvoice', () => {
  it('sends an approved invoice and returns the delivery record, not the invoice', async () => {
    const app = harness.app();
    const books = await setUpBooks(app, 'send-ok');
    const invoiceId = await createAndApproveInvoice(app, books, 'send-ok-inv');

    const sent = await app.inject({
      method: 'POST',
      url: `/v1/invoices/${invoiceId}/send`,
      headers: authorizedWrite(books.session, 'send-ok-1'),
      payload: {},
    });

    expect(sent.statusCode).toBe(200);
    const delivery = sent.json<DeliveryBody>();
    expect(delivery.invoiceId).toBe(invoiceId);
    expect(['sent', 'failed']).toContain(delivery.status);
    expect(delivery.publicUrl).toBeTypeOf('string');
    expect(delivery.artifactStorageKey).toBeTypeOf('string');
  });

  it('overrides the recipient when recipientEmail is given', async () => {
    const app = harness.app();
    const books = await setUpBooks(app, 'send-override');
    const invoiceId = await createAndApproveInvoice(app, books, 'send-override-inv');

    const sent = await app.inject({
      method: 'POST',
      url: `/v1/invoices/${invoiceId}/send`,
      headers: authorizedWrite(books.session, 'send-override-1'),
      payload: { recipientEmail: 'ap@customer.example' },
    });

    expect(sent.statusCode).toBe(200);
    expect(sent.json<DeliveryBody>().recipientEmail).toBe('ap@customer.example');
  });

  it('replays the first delivery on a retried key instead of sending twice', async () => {
    const app = harness.app();
    const books = await setUpBooks(app, 'send-retry');
    const invoiceId = await createAndApproveInvoice(app, books, 'send-retry-inv');

    const first = await app.inject({
      method: 'POST',
      url: `/v1/invoices/${invoiceId}/send`,
      headers: authorizedWrite(books.session, 'send-retry-1'),
      payload: {},
    });
    expect(first.statusCode).toBe(200);

    const retry = await app.inject({
      method: 'POST',
      url: `/v1/invoices/${invoiceId}/send`,
      headers: authorizedWrite(books.session, 'send-retry-1'),
      payload: {},
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json<DeliveryBody>().id).toBe(first.json<DeliveryBody>().id);
  });

  it('refuses to send a draft invoice', async () => {
    const app = harness.app();
    const books = await setUpBooks(app, 'send-draft');

    const created = await app.inject({
      method: 'POST',
      url: '/v1/invoices',
      headers: authorizedWrite(books.session, 'send-draft-create'),
      payload: {
        contactId: books.customer,
        issueDate: '2026-03-01',
        dueDate: '2026-03-31',
        taxMode: 'exclusive',
        lines: [
          {
            description: 'Consulting',
            quantity: '1',
            unitAmount: '100000',
            accountId: books.revenue,
          },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json<{ id: string }>();

    const sent = await app.inject({
      method: 'POST',
      url: `/v1/invoices/${id}/send`,
      headers: authorizedWrite(books.session, 'send-draft-1'),
      payload: {},
    });

    expect(sent.statusCode).toBe(412);
    expect(errorBody(sent.body).error.code).toBe('precondition_failed');
  });

  it('requires an Idempotency-Key like every other write on this surface', async () => {
    const app = harness.app();
    const books = await setUpBooks(app, 'send-no-key');
    const invoiceId = await createAndApproveInvoice(app, books, 'send-no-key-inv');

    const sent = await app.inject({
      method: 'POST',
      url: `/v1/invoices/${invoiceId}/send`,
      headers: { cookie: books.session.cookie },
      payload: {},
    });

    expect(sent.statusCode).toBe(400);
  });
});

describe('the OB-130 operations document their permissions', () => {
  it('names branding.read, branding.write and invoices.send in the published descriptions', async () => {
    const app = harness.app();
    const doc = JSON.parse(await generateOpenApiDocument(app)) as {
      paths: Record<string, Record<string, { description?: string }>>;
    };

    const getBranding = doc.paths['/v1/branding']?.['get'];
    const updateBranding = doc.paths['/v1/branding']?.['patch'];
    const uploadLogo = doc.paths['/v1/branding/logo']?.['post'];
    const sendInvoice = doc.paths['/v1/invoices/{invoiceId}/send']?.['post'];

    expect(getBranding?.description).toContain('branding.read');
    expect(updateBranding?.description).toContain('branding.write');
    expect(uploadLogo?.description).toContain('branding.write');
    expect(sendInvoice?.description).toContain('invoices.send');
  });
});
