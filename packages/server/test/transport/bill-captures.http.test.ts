import { DOCUMENT_CAPTURE_MAX_BYTES } from '@openbooks/shared-types';
import { describe, expect, it } from 'vitest';

import type { App } from '../../src/transport/index';
import { captureEmail, tokenFrom } from '../members/support';
import { deterministicDocument, useCaptureProviders } from './bill-captures-support';
import type { DeterministicFields } from './bill-captures-support';
import { errorBody } from './harness';
import { authorizedWrite, createAccount, registerUser, useV1App } from './v1-support';
import type { Session } from './v1-support';

/**
 * OB-190's transport boundary for OCR bill capture (initiative O, OB-186…190),
 * end to end against real MySQL.
 *
 * `test/bills/capture/capture.service.test.ts` and `.../inbound.test.ts` already
 * prove the service — extraction, vendor matching, the draft-once rule, the
 * inbound parse — deeply, and `inbound.test.ts`'s own header says the route half
 * is "left to the orchestrator's transport suite". So the cases here are boundary
 * cases: the mapping reaching the right service, the wire schema and the
 * querystring schema (a *separate* schema from the service, per
 * `listCapturesWireQuerySchema` in `transport/routes/bill-captures.ts`) actually
 * rejecting what they claim to, and — the one route on this whole surface with no
 * session at all — that `POST /v1/bills/inbound/:token` really is reachable
 * without one and really does resolve the org from the token alone.
 *
 * Real MySQL via testcontainers, the real deterministic extraction adapter, the
 * real `InProcessQueue`, the real `dev` inbound-mail adapter and the real local
 * storage adapter (`bill-captures-support.ts`) — spec §11's "no mocks" applied to
 * the whole pipeline, the same as the service suite, just reached over HTTP.
 */

const harness = useV1App();
const queue = useCaptureProviders();

/**
 * The real `log` email adapter over a capture stream, `v1-m2.test.ts`'s pattern:
 * the permission-gate case below needs a second member of the same org, and the
 * only way to seed one over HTTP is the invite lifecycle, which sends mail.
 */
const email = captureEmail();

interface Books {
  readonly session: Session;
  readonly expense: string;
  readonly vendor: string;
}

/** An org that can draft a bill from a capture: one expense account, one vendor. */
async function setUpBooks(app: App, slug: string): Promise<Books> {
  const session = await registerUser(app, {
    email: `${slug}@example.invalid`,
    orgName: `${slug} Books`,
  });

  const expense = await createAccount(app, session, {
    code: '6000',
    name: 'Office supplies',
    type: 'expense',
    normalBalance: 'debit',
  });
  const vendor = await createContact(app, session, `${slug}-vend`);

  return { session, expense, vendor };
}

async function createContact(app: App, session: Session, code: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/contacts',
    headers: authorizedWrite(session, `contact-${code}`),
    payload: { code, displayName: code, isVendor: true },
  });
  if (response.statusCode !== 201) throw new Error(`contact failed: ${response.body}`);
  return response.json<{ id: string }>().id;
}

interface UploadPayload {
  readonly filename: string;
  readonly contentType: string;
  readonly content: string;
}

/** `uploadRequestFor` (`test/bills/capture/support.ts`), rebuilt for the HTTP body. */
function uploadPayload(
  fields: DeterministicFields,
  overrides: Partial<UploadPayload> = {},
): UploadPayload {
  return {
    filename: 'invoice.txt',
    contentType: 'application/pdf',
    content: Buffer.from(deterministicDocument(fields), 'utf8').toString('base64'),
    ...overrides,
  };
}

interface CaptureLineBody {
  readonly description: string | null;
  readonly quantity: string;
  readonly unitAmount: string;
}

interface CaptureBody {
  readonly id: string;
  readonly source: 'upload' | 'email';
  readonly status: 'extracting' | 'extracted' | 'failed' | 'drafted' | 'dismissed';
  readonly filename: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly extractedVendorName: string | null;
  readonly matchedContactId: string | null;
  readonly extractedIssueDate: string | null;
  readonly extractedReference: string | null;
  readonly extractedTotalMinor: string | null;
  readonly lines: readonly CaptureLineBody[];
  readonly extractionError: string | null;
  readonly draftedBillId: string | null;
  readonly createdAt: string;
}

interface CapturePageBody {
  readonly items: readonly CaptureBody[];
  readonly nextCursor: string | null;
}

interface BillBody {
  readonly id: string;
  readonly status: string;
  readonly journalId: string | null;
}

describe('upload -> extraction -> review, over HTTP', () => {
  it('uploads extracting, settles to extracted, and reads back through the list and the single route', async () => {
    const app = harness.app();
    const books = await setUpBooks(app, 'capture-happy');

    const uploaded = await app.inject({
      method: 'POST',
      url: '/v1/bills/captures',
      headers: authorizedWrite(books.session, 'capture-happy-1'),
      payload: uploadPayload({
        vendor: 'Acme Supplies',
        date: '2026-07-20',
        reference: 'INV-4471',
        tax: '0',
        lines: [{ description: 'Widgets', quantity: '2', unitAmountMinor: '15000' }],
      }),
    });

    expect(uploaded.statusCode).toBe(201);
    const created = uploaded.json<CaptureBody>();
    expect(uploaded.headers.location).toBe(`/v1/bills/captures/${created.id}`);
    expect(created.status).toBe('extracting');
    expect(created.lines).toEqual([]);

    await queue().settled();

    const listed = await app.inject({
      method: 'GET',
      url: '/v1/bills/captures?status=extracted',
      headers: { cookie: books.session.cookie },
    });
    expect(listed.statusCode).toBe(200);
    const page = listed.json<CapturePageBody>();
    const found = page.items.find((item) => item.id === created.id);
    expect(found).toBeDefined();
    expect(found?.status).toBe('extracted');
    expect(found?.extractedReference).toBe('INV-4471');
    expect(found?.extractedIssueDate).toBe('2026-07-20');
    // 2 x 15000 = 30000, computed by the deterministic adapter itself.
    expect(found?.extractedTotalMinor).toBe('30000');
    expect(found?.lines).toEqual([{ description: 'Widgets', quantity: '2', unitAmount: '15000' }]);

    const single = await app.inject({
      method: 'GET',
      url: `/v1/bills/captures/${created.id}`,
      headers: { cookie: books.session.cookie },
    });
    expect(single.statusCode).toBe(200);
    expect(single.json<CaptureBody>()).toMatchObject({ id: created.id, status: 'extracted' });
  });
});

describe('wire-schema and querystring guards', () => {
  it('refuses a content type outside the capture allowlist', async () => {
    const app = harness.app();
    const books = await setUpBooks(app, 'capture-svg');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/bills/captures',
      headers: authorizedWrite(books.session, 'capture-svg-1'),
      payload: {
        filename: 'mark.svg',
        contentType: 'image/svg+xml',
        content: Buffer.from('<svg/>', 'utf8').toString('base64'),
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('refuses malformed base64 content', async () => {
    const app = harness.app();
    const books = await setUpBooks(app, 'capture-badb64');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/bills/captures',
      headers: authorizedWrite(books.session, 'capture-badb64-1'),
      payload: {
        filename: 'invoice.pdf',
        contentType: 'application/pdf',
        content: 'not valid base64 !! ///',
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('refuses content over the 10 MiB decoded ceiling', async () => {
    const app = harness.app();
    const books = await setUpBooks(app, 'capture-oversize');

    // Same arithmetic `uploadCaptureRequestSchema` itself uses (`captures.ts`):
    // base64 costs 4 characters per 3 encoded bytes. A handful of extra whole
    // groups past the ceiling guarantees the *string* is over the schema's
    // `.max()`, not merely at its rounding boundary.
    const maxContentLength = Math.ceil(DOCUMENT_CAPTURE_MAX_BYTES / 3) * 4;
    const oversizedContent = 'A'.repeat(maxContentLength + 400);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/bills/captures',
      headers: authorizedWrite(books.session, 'capture-oversize-1'),
      payload: {
        filename: 'invoice.pdf',
        contentType: 'application/pdf',
        content: oversizedContent,
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('refuses an invalid status value in the list querystring', async () => {
    const app = harness.app();
    const books = await setUpBooks(app, 'capture-badstatus');

    const response = await app.inject({
      method: 'GET',
      url: '/v1/bills/captures?status=not-a-real-status',
      headers: { cookie: books.session.cookie },
    });

    expect(response.statusCode).toBe(400);
  });

  it('refuses a write with no Idempotency-Key', async () => {
    const app = harness.app();
    const books = await setUpBooks(app, 'capture-nokey');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/bills/captures',
      headers: { cookie: books.session.cookie },
      payload: uploadPayload({ vendor: 'Acme' }),
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('create-draft over HTTP', () => {
  it('confirms a reviewed, settled capture into a draft bill, and the capture reads back drafted', async () => {
    const app = harness.app();
    const books = await setUpBooks(app, 'capture-draft');

    const uploaded = await app.inject({
      method: 'POST',
      url: '/v1/bills/captures',
      headers: authorizedWrite(books.session, 'capture-draft-1'),
      payload: uploadPayload({
        vendor: 'Acme',
        lines: [{ description: 'Paper', quantity: '1', unitAmountMinor: '150000' }],
      }),
    });
    expect(uploaded.statusCode).toBe(201);
    const capture = uploaded.json<CaptureBody>();

    await queue().settled();

    const drafted = await app.inject({
      method: 'POST',
      url: `/v1/bills/captures/${capture.id}/draft`,
      headers: authorizedWrite(books.session, 'capture-draft-2'),
      payload: {
        contactId: books.vendor,
        issueDate: '2026-07-20',
        taxMode: 'exclusive',
        lines: [
          { description: 'Paper', quantity: '1', unitAmount: '150000', accountId: books.expense },
        ],
      },
    });
    expect(drafted.statusCode).toBe(201);
    const bill = drafted.json<BillBody>();
    expect(bill.status).toBe('draft');
    expect(bill.journalId).toBeNull();
    expect(drafted.headers.location).toBe(`/v1/bills/${bill.id}`);

    const settledCapture = await app.inject({
      method: 'GET',
      url: `/v1/bills/captures/${capture.id}`,
      headers: { cookie: books.session.cookie },
    });
    expect(settledCapture.statusCode).toBe(200);
    expect(settledCapture.json<CaptureBody>()).toMatchObject({
      status: 'drafted',
      draftedBillId: bill.id,
    });
  });

  it('a cross-org capture id is a 404, never a different org’s row (A7)', async () => {
    const app = harness.app();
    const owner = await setUpBooks(app, 'capture-cross-a');
    const stranger = await setUpBooks(app, 'capture-cross-b');

    const uploaded = await app.inject({
      method: 'POST',
      url: '/v1/bills/captures',
      headers: authorizedWrite(owner.session, 'capture-cross-1'),
      payload: uploadPayload({ vendor: 'Acme' }),
    });
    expect(uploaded.statusCode).toBe(201);
    const capture = uploaded.json<CaptureBody>();
    await queue().settled();

    const response = await app.inject({
      method: 'POST',
      url: `/v1/bills/captures/${capture.id}/draft`,
      headers: authorizedWrite(stranger.session, 'capture-cross-2'),
      payload: { contactId: stranger.vendor, issueDate: '2026-07-20', taxMode: 'exclusive' },
    });

    expect(response.statusCode).toBe(404);
    expect(errorBody(response.body).error.code).toBe('not_found');
  });
});

describe('the no-session inbound webhook', () => {
  it('accepts a webhook with no session cookie at all and creates a capture', async () => {
    const app = harness.app();
    const books = await setUpBooks(app, 'inbound-happy');

    const addressResponse = await app.inject({
      method: 'GET',
      url: '/v1/bills/inbound-address',
      headers: { cookie: books.session.cookie },
    });
    expect(addressResponse.statusCode).toBe(200);
    const { address } = addressResponse.json<{ address: string }>();
    const token = address.split('+')[1]?.split('@')[0];
    expect(token).toBeDefined();

    const content = Buffer.from(deterministicDocument({ vendor: 'Acme' }), 'utf8').toString(
      'base64',
    );

    const webhook = await app.inject({
      method: 'POST',
      url: `/v1/bills/inbound/${String(token)}`,
      // Deliberately no `cookie` header — the whole point of this route (D-74's
      // shape: the `:token` path segment is the entire authorization). The
      // `Idempotency-Key` is still required (spec §12, like every write, even the
      // unauthenticated ones): a redelivering relay sends the same key and captures
      // once. No session is involved in supplying it.
      headers: { 'idempotency-key': 'inbound-happy-1' },
      payload: {
        to: address,
        from: 'vendor@example.com',
        subject: 'Invoice',
        attachments: [
          { filename: 'invoice.pdf', contentType: 'application/pdf', contentBase64: content },
        ],
      },
    });

    expect(webhook.statusCode).toBe(201);
    const { captureIds } = webhook.json<{ captureIds: string[] }>();
    expect(captureIds).toHaveLength(1);

    await queue().settled();

    const single = await app.inject({
      method: 'GET',
      url: `/v1/bills/captures/${String(captureIds[0])}`,
      headers: { cookie: books.session.cookie },
    });
    expect(single.statusCode).toBe(200);
    expect(single.json<CaptureBody>()).toMatchObject({
      id: captureIds[0],
      source: 'email',
      status: 'extracted',
    });
  });

  it('refuses an unknown token with a 404, indistinguishable from one never issued', async () => {
    const app = harness.app();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/bills/inbound/not-a-real-token',
      // No session here either — an unknown token must be refused on its own,
      // not because there was no caller to blame it on. The key is present so the
      // request reaches token resolution (a missing key would 400 before it, and
      // this case is about the token, not the key).
      headers: { 'idempotency-key': 'inbound-unknown-1' },
      payload: {
        to: 'bills+x@inbound.openbooks.app',
        from: 'vendor@example.com',
        subject: 'x',
        attachments: [],
      },
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('permission gate over HTTP (bills.write, no new catalog key)', () => {
  it('a read_only member is refused on the upload route', async () => {
    const app = harness.app();
    const owner = await registerUser(app, {
      email: 'capture-perm-owner@example.invalid',
      orgName: 'Capture Perm Books',
    });
    const guest = await registerUser(app, {
      email: 'capture-perm-guest@example.invalid',
      orgName: 'Capture Perm Guest Books',
    });

    const roles = await app.inject({
      method: 'GET',
      url: '/v1/roles',
      headers: { cookie: owner.cookie },
    });
    const readOnly = roles
      .json<{ roles: { id: string; code: string }[] }>()
      .roles.find((role) => role.code === 'read_only');
    expect(readOnly).toBeDefined();

    const invited = await app.inject({
      method: 'POST',
      url: '/v1/invites',
      headers: authorizedWrite(owner, 'capture-perm-invite'),
      payload: { email: 'capture-perm-guest@example.invalid', roleId: readOnly?.id },
    });
    expect(invited.statusCode).toBe(201);

    const token = tokenFrom(email.to('capture-perm-guest@example.invalid'));
    const accepted = await app.inject({
      method: 'POST',
      url: '/v1/invites/accept',
      headers: authorizedWrite(guest, 'capture-perm-accept'),
      payload: { orgId: owner.orgId, token },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ roleCode: 'read_only' });

    // The accept above is a global claim (`v1-m2.test.ts`'s comment) — `guest`'s
    // active org is still their own until they switch.
    const switched = await app.inject({
      method: 'POST',
      url: '/v1/orgs/active',
      headers: authorizedWrite(guest, 'capture-perm-switch'),
      payload: { orgId: owner.orgId },
    });
    expect(switched.statusCode).toBe(200);

    const refused = await app.inject({
      method: 'POST',
      url: '/v1/bills/captures',
      headers: authorizedWrite(guest, 'capture-perm-upload'),
      payload: uploadPayload({ vendor: 'Acme' }),
    });

    expect(refused.statusCode).toBe(403);
    expect(errorBody(refused.body).error.code).toBe('permission_denied');
  });
});
