import { describe, expect, it } from 'vitest';

import { PermissionDeniedError } from '../../src/errors';
import { getBranding, updateBranding, uploadLogo } from '../../src/modules/branding';
import { storageProvider } from '../../src/providers';
import { actorIn, useLocalStorage, useServiceDatabase } from './support';

/**
 * The org's letterhead (OB-124, Phase 1 delivery).
 *
 * What is worth proving here, and why:
 *
 *  1. **`getBranding` never 404s.** An org that has never opened its branding
 *     settings still gets something a client can render — its own name, and every
 *     other field `null` — because `display_name` is the one thing a rendered
 *     invoice cannot do without (`0007_invoice_delivery`).
 *  2. **The row is created lazily by an upsert, and `null` and absent are
 *     different values** — the same `ControlAccountsPatch` distinction, applied to
 *     a settings row with twelve nullable columns instead of two.
 *  3. **A first write with no `displayName` falls back to the org's own name**,
 *     the same name `getBranding`'s synthesized default uses, so a client that
 *     never touches the name field before setting a brand colour does not end up
 *     with a letterhead that prints under nothing.
 *  4. **The logo upload path writes through the real `StorageProvider`** and the
 *     bytes are readable back through that same provider's `get` (spec §11: no
 *     mocks).
 */
const db = useServiceDatabase();
useLocalStorage();

describe('reading branding before anything has been written', () => {
  it('synthesizes a default from the org itself, never a 404', async () => {
    const actor = await actorIn(db);
    const org = await db.app
      .selectFrom('orgs')
      .select('created_at')
      .where('id', '=', actor.orgId)
      .executeTakeFirstOrThrow();

    const branding = await getBranding(actor.ctx);

    expect(branding).toEqual({
      displayName: actor.orgName,
      addressLine1: null,
      addressLine2: null,
      city: null,
      region: null,
      postalCode: null,
      country: null,
      email: null,
      phone: null,
      website: null,
      taxNumber: null,
      logoStorageKey: null,
      brandColor: null,
      invoiceFooter: null,
      createdAt: org.created_at.toISOString(),
      updatedAt: org.created_at.toISOString(),
    });
  });

  it('performs no write', async () => {
    const actor = await actorIn(db);
    await getBranding(actor.ctx);

    const row = await db.app
      .selectFrom('org_branding')
      .selectAll()
      .where('org_id', '=', actor.orgId)
      .executeTakeFirst();

    expect(row).toBeUndefined();
  });

  it('takes branding.read, which every seeded role holds', async () => {
    const actor = await actorIn(db, 'readOnly');

    await expect(getBranding(actor.ctx)).resolves.toBeDefined();
  });
});

describe('writing branding', () => {
  it('creates the row on first write, falling back to the org name', async () => {
    const actor = await actorIn(db);

    const branding = await updateBranding({ brandColor: '#112233' }, actor.ctx);

    expect(branding.displayName).toBe(actor.orgName);
    expect(branding.brandColor).toBe('#112233');
    expect(await getBranding(actor.ctx)).toEqual(branding);
  });

  it('takes the patch-supplied name over the fallback on a first write', async () => {
    const actor = await actorIn(db);

    const branding = await updateBranding({ displayName: 'Acme Supplies Limited' }, actor.ctx);

    expect(branding.displayName).toBe('Acme Supplies Limited');
  });

  /**
   * The distinction the patch type carries down from the wire contract. An
   * omitted field is left alone; an explicit `null` clears. Collapsing the two
   * would make "clear only the phone number" impossible to express without
   * restating a value the caller may not have read.
   */
  it('leaves an omitted field alone and clears an explicitly null one', async () => {
    const actor = await actorIn(db);

    await updateBranding(
      { displayName: 'Acme Ltd', email: 'billing@acme.test', phone: '+1 555 0100' },
      actor.ctx,
    );

    const updated = await updateBranding({ phone: null }, actor.ctx);

    expect(updated).toMatchObject({
      displayName: 'Acme Ltd',
      email: 'billing@acme.test',
      phone: null,
    });
  });

  it('updates the row in place rather than creating a second one', async () => {
    const actor = await actorIn(db);

    await updateBranding({ displayName: 'First' }, actor.ctx);
    await updateBranding({ displayName: 'Second' }, actor.ctx);

    const rows = await db.app
      .selectFrom('org_branding')
      .selectAll()
      .where('org_id', '=', actor.orgId)
      .execute();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.display_name).toBe('Second');
  });

  it('refuses an empty patch', async () => {
    const actor = await actorIn(db);

    await expect(updateBranding({}, actor.ctx)).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });

  it('refuses a read-only role, which holds branding.read and not branding.write', async () => {
    const actor = await actorIn(db, 'readOnly');

    await expect(
      updateBranding({ displayName: 'Should not land' }, actor.ctx),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    // And nothing was written by the attempt.
    const row = await db.app
      .selectFrom('org_branding')
      .selectAll()
      .where('org_id', '=', actor.orgId)
      .executeTakeFirst();
    expect(row).toBeUndefined();
  });
});

describe('uploading a logo', () => {
  it('writes bytes through the storage provider and points logo_storage_key at them', async () => {
    const actor = await actorIn(db);
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

    const branding = await uploadLogo(bytes, 'image/png', actor.ctx);

    expect(branding.logoStorageKey).not.toBeNull();
    const key = branding.logoStorageKey;
    if (key === null) throw new Error('expected a logo_storage_key');
    expect(key).toMatch(new RegExp(`^org/${actor.orgUuid}/branding/[0-9a-f-]{36}$`));

    const stored = await storageProvider().get(key);
    expect(new Uint8Array(stored)).toEqual(bytes);
  });

  it('falls back to the org name on a first write that is only a logo upload', async () => {
    const actor = await actorIn(db);

    const branding = await uploadLogo(new Uint8Array([1, 2, 3]), 'image/png', actor.ctx);

    expect(branding.displayName).toBe(actor.orgName);
  });

  it('leaves the rest of the letterhead alone on a later upload', async () => {
    const actor = await actorIn(db);
    await updateBranding({ displayName: 'Acme Ltd', email: 'billing@acme.test' }, actor.ctx);

    const branding = await uploadLogo(new Uint8Array([1, 2, 3]), 'image/png', actor.ctx);

    expect(branding.displayName).toBe('Acme Ltd');
    expect(branding.email).toBe('billing@acme.test');
    expect(branding.logoStorageKey).not.toBeNull();
  });

  it('refuses a read-only role', async () => {
    const actor = await actorIn(db, 'readOnly');

    await expect(
      uploadLogo(new Uint8Array([1, 2, 3]), 'image/png', actor.ctx),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});
