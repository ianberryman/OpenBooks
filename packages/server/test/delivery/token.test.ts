import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { mintDeliveryToken, verifyDeliveryToken } from '../../src/modules/delivery';
import { approvedInvoiceIn, deliveryIn, useServiceDatabase } from './support';

/**
 * The capability-token credential itself, in isolation from the invoice it names
 * (OB-121; ROADMAP D-74). `public-invoice.test.ts` covers the invoice-shaped half —
 * what a verified token unlocks and what it must never leak.
 *
 * Real MySQL throughout (spec §11): `verifyDeliveryToken` reads
 * `invoice_deliveries` through `selectDeliveryCredentialByKeyPrefix`, which is the
 * one place in the app that queries it with no `tenantDb` scope, so a mocked
 * database would prove nothing about the query this suite exists to check.
 *
 * Every stored `invoice_deliveries` row here sits on a real, approved invoice from
 * `approvedInvoiceIn` — the composite `fk_invoice_deliveries_invoice` makes a
 * fabricated `(orgId, invoiceId)` pair a constraint violation, not a state this
 * suite could otherwise construct, so the fixture is the schema's own enforcement
 * working rather than incidental setup.
 */
const db = useServiceDatabase();

/** Stores a minted token's row against a real invoice, returning it and the new delivery id. */
async function storedDelivery(orgId: Buffer, invoiceId: Buffer) {
  const minted = mintDeliveryToken();
  const deliveryId = await deliveryIn(db, {
    orgId,
    invoiceId,
    keyPrefix: minted.keyPrefix,
    tokenHash: minted.tokenHash,
    artifactStorageKey: 'irrelevant-for-this-suite.pdf',
  });
  return { ...minted, deliveryId };
}

describe('mintDeliveryToken', () => {
  it('mints {prefix}.{secret}: 8 url-safe characters, a dot, 43 url-safe characters', () => {
    const minted = mintDeliveryToken();

    expect(minted.token).toMatch(/^[A-Za-z0-9_-]{8}\.[A-Za-z0-9_-]{43}$/);
    expect(minted.token.startsWith(`${minted.keyPrefix}.`)).toBe(true);
  });

  it('hashes the whole token to 32 raw bytes — what BINARY(32) holds', () => {
    const minted = mintDeliveryToken();

    const expected = createHash('sha256').update(minted.token, 'utf8').digest();

    expect(Buffer.isBuffer(minted.tokenHash)).toBe(true);
    expect(minted.tokenHash).toHaveLength(32);
    expect(minted.tokenHash.equals(expected)).toBe(true);
  });

  it('issues a distinct token, prefix and hash every time', () => {
    const a = mintDeliveryToken();
    const b = mintDeliveryToken();

    expect(a.token).not.toBe(b.token);
    expect(a.keyPrefix).not.toBe(b.keyPrefix);
    expect(a.tokenHash.equals(b.tokenHash)).toBe(false);
  });
});

describe('verifyDeliveryToken', () => {
  it('round-trips: a stored token verifies to the org and delivery it was minted for', async () => {
    const fixture = await approvedInvoiceIn(db);
    const { token, deliveryId } = await storedDelivery(fixture.orgId, fixture.invoiceId);

    await expect(verifyDeliveryToken(token)).resolves.toEqual({
      orgId: fixture.orgId,
      deliveryId,
    });
  });

  it('rejects a token whose prefix names no row', async () => {
    // Minted, never stored — nothing in invoice_deliveries carries this key_prefix.
    const minted = mintDeliveryToken();

    await expect(verifyDeliveryToken(minted.token)).resolves.toBeNull();
  });

  it('rejects the right prefix with the wrong secret', async () => {
    const fixture = await approvedInvoiceIn(db);
    const { keyPrefix } = await storedDelivery(fixture.orgId, fixture.invoiceId);
    const forged = `${keyPrefix}.${randomBytes(32).toString('base64url')}`;

    await expect(verifyDeliveryToken(forged)).resolves.toBeNull();
  });

  it('rejects a tampered hash — the stored digest decides, not the presented token', async () => {
    const fixture = await approvedInvoiceIn(db);
    const minted = mintDeliveryToken();

    // A row whose token_hash does not correspond to the token presented below, as if
    // the stored digest had been corrupted or forged independently of a mint.
    await deliveryIn(db, {
      orgId: fixture.orgId,
      invoiceId: fixture.invoiceId,
      keyPrefix: minted.keyPrefix,
      tokenHash: Buffer.alloc(32, 0x42),
      artifactStorageKey: 'irrelevant.pdf',
    });

    await expect(verifyDeliveryToken(minted.token)).resolves.toBeNull();
  });

  it.each([
    ['no dot at all', 'notadottedtoken'],
    ['too many dots', 'a.b.c'],
    ['empty string', ''],
    ['dot with nothing on either side', '.'],
    ['empty prefix', '.asecret'],
    ['empty secret', 'aprefix.'],
  ])('rejects a malformed token — %s', async (_label, malformed) => {
    await expect(verifyDeliveryToken(malformed)).resolves.toBeNull();
  });

  it('a prefix collision cannot authenticate the wrong row', async () => {
    // key_prefix has no uniqueness constraint (0007_invoice_delivery.ts's own
    // commentary: the index exists to select a candidate cheaply, and the hash
    // comparison is what actually decides). Force the collision two genuinely
    // random mints would not produce in practice, and prove the property that
    // matters regardless of which row `executeTakeFirst` happens to read back:
    // presenting org A's real token never verifies to org B, whichever row MySQL
    // returns for the shared prefix.
    const sharedPrefix = mintDeliveryToken().keyPrefix;
    const [fixtureA, fixtureB] = await Promise.all([approvedInvoiceIn(db), approvedInvoiceIn(db)]);
    const secretA = randomBytes(32).toString('base64url');
    const secretB = randomBytes(32).toString('base64url');
    const tokenA = `${sharedPrefix}.${secretA}`;
    const tokenB = `${sharedPrefix}.${secretB}`;
    const hashOf = (value: string) => createHash('sha256').update(value, 'utf8').digest();

    const deliveryA = await deliveryIn(db, {
      orgId: fixtureA.orgId,
      invoiceId: fixtureA.invoiceId,
      keyPrefix: sharedPrefix,
      tokenHash: hashOf(tokenA),
      artifactStorageKey: 'a.pdf',
    });
    await deliveryIn(db, {
      orgId: fixtureB.orgId,
      invoiceId: fixtureB.invoiceId,
      keyPrefix: sharedPrefix,
      tokenHash: hashOf(tokenB),
      artifactStorageKey: 'b.pdf',
    });

    const matchA = await verifyDeliveryToken(tokenA);
    // Never org B's id, whether or not MySQL happened to return org A's row first.
    expect(matchA === null || matchA.orgId.equals(fixtureA.orgId)).toBe(true);
    if (matchA !== null) expect(matchA.deliveryId.equals(deliveryA)).toBe(true);
  });
});
