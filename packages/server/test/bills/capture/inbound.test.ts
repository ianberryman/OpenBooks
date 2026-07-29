import { beforeEach, describe, expect, it } from 'vitest';

import { createCaptureFromInbound, getCapture } from '../../../src/modules/bills';
import { getInboundEmailAddress, resolveOrgIdForInboundToken } from '../../../src/modules/orgs';
import { runAsAutomation } from '../../../src/modules/scheduling';
import { createDevInboundMailProvider } from '../../../src/providers/inbound-mail/dev';
import type { CaptureScene } from './support';
import {
  sceneIn,
  useExtractionQueue,
  useLocalStorage,
  useServiceDatabase,
  withContext,
} from './support';

/**
 * The inbound-email side of OCR bill capture (initiative O, OB-186): the token
 * that routes a webhook to an org (`modules/orgs/inbound-email.ts`), and
 * `createCaptureFromInbound`'s "one capture per eligible attachment" rule. Runs
 * the real `dev` `InboundMailProvider` adapter, spec §11's "no mocks" applied to
 * the webhook parse — the route this exercises the service half of is
 * `POST /v1/bills/inbound/:token`, left to the orchestrator's transport suite.
 */
const db = useServiceDatabase();
useLocalStorage();
const queue = useExtractionQueue();

let s: CaptureScene;

beforeEach(async () => {
  s = await sceneIn(db);
});

interface DevAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly content: string;
}

/** Builds the `dev` adapter's expected JSON webhook body and parses it through the real adapter. */
async function parseDevWebhook(to: string, attachments: readonly DevAttachment[]) {
  const payload = {
    to,
    from: 'vendor@example.com',
    subject: 'Invoice',
    attachments: attachments.map((attachment) => ({
      filename: attachment.filename,
      contentType: attachment.contentType,
      contentBase64: Buffer.from(attachment.content, 'utf8').toString('base64'),
    })),
  };
  const body = new TextEncoder().encode(JSON.stringify(payload));
  return createDevInboundMailProvider().parse({
    headers: { 'content-type': 'application/json' },
    body,
  });
}

describe('the inbound mailbox token (modules/orgs/inbound-email.ts)', () => {
  it('mints once, lazily, and the same address is returned on every call', async () => {
    const first = await withContext(s.ctx, () => getInboundEmailAddress(s.ctx));
    const second = await withContext(s.ctx, () => getInboundEmailAddress(s.ctx));
    expect(first.address).toBe(second.address);
    expect(first.address).toMatch(/^bills\+[\w-]+@/u);
  });

  it('resolves the minted token back to the org, and a malformed token resolves to null', async () => {
    const { address } = await withContext(s.ctx, () => getInboundEmailAddress(s.ctx));
    const token = address.split('+')[1]?.split('@')[0];
    expect(token).toBeDefined();

    const orgId = await resolveOrgIdForInboundToken(token ?? '');
    expect(orgId).toBe(s.orgUuid);

    expect(await resolveOrgIdForInboundToken('not-a-real-token')).toBeNull();
    expect(await resolveOrgIdForInboundToken('')).toBeNull();
  });

  it('two orgs mint two different tokens', async () => {
    const other = await sceneIn(db);
    const mine = await withContext(s.ctx, () => getInboundEmailAddress(s.ctx));
    const theirs = await withContext(other.ctx, () => getInboundEmailAddress(other.ctx));
    expect(mine.address).not.toBe(theirs.address);
  });
});

describe('createCaptureFromInbound', () => {
  it('creates one capture per eligible attachment and enqueues extraction for each', async () => {
    const { address } = await withContext(s.ctx, () => getInboundEmailAddress(s.ctx));
    const msg = await parseDevWebhook(address, [
      { filename: 'invoice.pdf', contentType: 'application/pdf', content: 'vendor: Acme' },
      // A signature image alongside the real bill — an ordinary inbound shape.
      { filename: 'signature.png', contentType: 'image/png', content: 'not text but eligible' },
      // Outside the capturable set — skipped rather than failing the message.
      { filename: 'terms.docx', contentType: 'application/msword', content: 'irrelevant' },
    ]);

    const captures = await runAsAutomation(s.orgUuid, 'document-extraction', (ctx) =>
      createCaptureFromInbound(msg, s.orgUuid, ctx),
    );

    expect(captures).toHaveLength(2);
    expect(captures.every((capture) => capture.source === 'email')).toBe(true);
    expect(captures.map((capture) => capture.filename).sort()).toEqual([
      'invoice.pdf',
      'signature.png',
    ]);

    await queue().settled();
    for (const capture of captures) {
      const settled = await withContext(s.ctx, () => getCapture(capture.id, s.ctx));
      expect(['extracted', 'failed']).toContain(settled.status);
    }
  });

  it('an email with no eligible attachment yields no captures', async () => {
    const msg = await parseDevWebhook('bills+x@inbound.openbooks.app', [
      { filename: 'terms.docx', contentType: 'application/msword', content: 'x' },
    ]);

    const captures = await runAsAutomation(s.orgUuid, 'document-extraction', (ctx) =>
      createCaptureFromInbound(msg, s.orgUuid, ctx),
    );

    expect(captures).toHaveLength(0);
  });
});
