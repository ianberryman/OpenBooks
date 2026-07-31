import type { CreateCatalogItemRequest } from '@openbooks/shared-types';
import { describe, expect, it } from 'vitest';

import { bufferToUuid, newUuidBuffer } from '../../src/db';
import {
  ConflictError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
  toWireError,
} from '../../src/errors';
import {
  createCatalogItem,
  deactivateCatalogItem,
  getCatalogItem,
  listCatalogItems,
  reactivateCatalogItem,
  updateCatalogItem,
} from '../../src/modules/catalog';
import { actorIn, contextFor, useServiceDatabase } from './support';

/**
 * The catalog service against real MySQL (spec §11 — never SQLite, never mocks).
 *
 * Everything here goes through the exported service functions, because the
 * properties being asserted — the permission check, the conflict translation, the A7
 * miss — live at that boundary. `contacts.service.test.ts` is the shape.
 */
const WIDGET: CreateCatalogItemRequest = {
  direction: 'sales',
  name: 'Consulting hour',
};

const db = useServiceDatabase();

describe('catalog service', () => {
  describe('create, read, list, update', () => {
    it('round-trips a created item through read and list', async () => {
      const actor = await actorIn(db);
      const account = await db.factories.account({
        orgId: actor.orgId,
        type: 'revenue',
        normalBalance: 'credit',
      });

      const created = await createCatalogItem(
        {
          direction: 'sales',
          name: 'Consulting hour',
          code: 'SVC-1',
          defaultAccountId: account.uuid,
          defaultUnitAmount: '15000',
        },
        actor.ctx,
      );

      expect(created).toMatchObject({
        direction: 'sales',
        name: 'Consulting hour',
        code: 'SVC-1',
        defaultAccountId: account.uuid,
        defaultUnitAmount: '15000',
        defaultTaxRateId: null,
        isActive: true,
      });

      const fetched = await getCatalogItem(created.id, actor.ctx);
      expect(fetched).toEqual(created);

      const listed = await listCatalogItems({}, actor.ctx);
      expect(listed.items).toEqual([created]);
    });

    it('creates a bare item with no defaults', async () => {
      const actor = await actorIn(db);

      const bare = await createCatalogItem(WIDGET, actor.ctx);

      expect(bare).toMatchObject({
        direction: 'sales',
        name: 'Consulting hour',
        code: null,
        defaultAccountId: null,
        defaultUnitAmount: null,
        defaultTaxRateId: null,
        isActive: true,
      });
    });

    it('applies a partial update, clears a nullable with null, and rejects an empty patch', async () => {
      const actor = await actorIn(db);
      const created = await createCatalogItem(
        { ...WIDGET, code: 'SVC-1', defaultUnitAmount: '15000' },
        actor.ctx,
      );

      const renamed = await updateCatalogItem(created.id, { name: 'Advisory hour' }, actor.ctx);
      expect(renamed.name).toBe('Advisory hour');
      expect(renamed.code).toBe('SVC-1');
      expect(renamed.defaultUnitAmount).toBe('15000');

      const cleared = await updateCatalogItem(
        created.id,
        { code: null, defaultUnitAmount: null },
        actor.ctx,
      );
      expect(cleared).toMatchObject({ code: null, defaultUnitAmount: null });

      await expect(updateCatalogItem(created.id, {}, actor.ctx)).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it('filters by direction, active flag, and a name/code substring', async () => {
      const actor = await actorIn(db);
      const sales = await createCatalogItem({ direction: 'sales', name: 'Widget' }, actor.ctx);
      const purchase = await createCatalogItem(
        { direction: 'purchase', name: 'Raw material', code: 'RM-1' },
        actor.ctx,
      );
      const retired = await createCatalogItem(
        { direction: 'sales', name: 'Old widget' },
        actor.ctx,
      );
      await deactivateCatalogItem(retired.id, actor.ctx);

      const salesItems = await listCatalogItems({ direction: 'sales' }, actor.ctx);
      expect(salesItems.items.map((item) => item.id).sort()).toEqual([sales.id, retired.id].sort());

      const purchases = await listCatalogItems({ direction: 'purchase' }, actor.ctx);
      expect(purchases.items.map((item) => item.id)).toEqual([purchase.id]);

      const active = await listCatalogItems({ direction: 'sales', isActive: true }, actor.ctx);
      expect(active.items.map((item) => item.id)).toEqual([sales.id]);

      const byName = await listCatalogItems({ q: 'widget' }, actor.ctx);
      expect(byName.items.map((item) => item.id).sort()).toEqual([sales.id, retired.id].sort());

      const byCode = await listCatalogItems({ q: 'RM-' }, actor.ctx);
      expect(byCode.items.map((item) => item.id)).toEqual([purchase.id]);
    });

    it('lists only the caller org’s items', async () => {
      const mine = await actorIn(db);
      const theirs = await actorIn(db);

      const ours = await createCatalogItem(WIDGET, mine.ctx);
      await createCatalogItem({ direction: 'purchase', name: 'Theirs' }, theirs.ctx);

      expect((await listCatalogItems({}, mine.ctx)).items).toEqual([ours]);
    });
  });

  describe('duplicate code', () => {
    it('refuses a duplicate code within an org and permits it across orgs', async () => {
      const mine = await actorIn(db);
      const theirs = await actorIn(db);

      await createCatalogItem({ ...WIDGET, code: 'SVC-1' }, mine.ctx);
      await expect(
        createCatalogItem({ ...WIDGET, code: 'SVC-1' }, theirs.ctx),
      ).resolves.toBeDefined();

      // Compared case-insensitively under `utf8mb4_0900_ai_ci`, so this is the same code.
      const error = await createCatalogItem({ ...WIDGET, code: 'svc-1' }, mine.ctx).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(ConflictError);
      expect(toWireError(error)).toMatchObject({ code: 'conflict', status: 409 });
    });

    it('permits any number of items with no code', async () => {
      const actor = await actorIn(db);

      await createCatalogItem({ direction: 'sales', name: 'One' }, actor.ctx);
      await createCatalogItem({ direction: 'sales', name: 'Two' }, actor.ctx);

      expect((await listCatalogItems({}, actor.ctx)).items).toHaveLength(2);
    });
  });

  describe('deactivate, reactivate', () => {
    it('deactivates and reactivates idempotently', async () => {
      const actor = await actorIn(db);
      const created = await createCatalogItem(WIDGET, actor.ctx);

      expect((await deactivateCatalogItem(created.id, actor.ctx)).isActive).toBe(false);
      expect((await deactivateCatalogItem(created.id, actor.ctx)).isActive).toBe(false);
      expect((await reactivateCatalogItem(created.id, actor.ctx)).isActive).toBe(true);
      expect((await reactivateCatalogItem(created.id, actor.ctx)).isActive).toBe(true);
    });
  });

  /**
   * A7: a cross-org read returns nothing and does not leak existence. The assertion
   * is deep equality of the serialized errors, not "both are 404s" — two 404s that
   * differ in `message` or `details.resource` are still an existence oracle.
   */
  describe('A7 — cross-org reads are indistinguishable from misses', () => {
    it('answers a cross-org id exactly as it answers a nonexistent one', async () => {
      const mine = await actorIn(db);
      const theirs = await actorIn(db);
      const theirItem = await createCatalogItem(WIDGET, theirs.ctx);
      const nonexistent = '2f1b2b3c-4d5e-4f60-8a71-b2c3d4e5f607';

      const crossOrg = await getCatalogItem(theirItem.id, mine.ctx).catch(
        (error: unknown) => error,
      );
      const missing = await getCatalogItem(nonexistent, mine.ctx).catch((error: unknown) => error);

      expect(crossOrg).toBeInstanceOf(NotFoundError);
      expect(toWireError(crossOrg)).toEqual(toWireError(missing));
      expect(toWireError(crossOrg)).toEqual({
        code: 'not_found',
        status: 404,
        message: 'No such catalog_item.',
        details: { resource: 'catalog_item' },
      });
    });

    it('does not let a cross-org item be updated or deactivated', async () => {
      const mine = await actorIn(db);
      const theirs = await actorIn(db);
      const theirItem = await createCatalogItem(WIDGET, theirs.ctx);

      await expect(
        updateCatalogItem(theirItem.id, { name: 'Mine now' }, mine.ctx),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(deactivateCatalogItem(theirItem.id, mine.ctx)).rejects.toBeInstanceOf(
        NotFoundError,
      );

      expect(await getCatalogItem(theirItem.id, theirs.ctx)).toEqual(theirItem);
    });
  });

  /**
   * Enforcement is service-layer only (spec §2.4, §5). Every seeded role carries
   * `catalog.read`, so proving the gate exists needs a role that does not — a custom
   * role with an empty bundle, which the harness clears between tests.
   */
  describe('requirePermission', () => {
    it('refuses read and write to a role carrying no permissions', async () => {
      const owner = await actorIn(db);
      const created = await createCatalogItem(WIDGET, owner.ctx);

      const roleId = newUuidBuffer();
      await db.app
        .insertInto('roles')
        .values({
          id: roleId,
          org_id: owner.orgId,
          code: 'nothing',
          name: 'Nothing',
          description: 'Holds no permissions.',
          is_system: 0,
        })
        .execute();

      const powerless = contextFor(owner.orgUuid, bufferToUuid(roleId), owner.userUuid);

      await expect(getCatalogItem(created.id, powerless)).rejects.toBeInstanceOf(
        PermissionDeniedError,
      );
      await expect(listCatalogItems({}, powerless)).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(createCatalogItem(WIDGET, powerless)).rejects.toBeInstanceOf(
        PermissionDeniedError,
      );
    });
  });
});
