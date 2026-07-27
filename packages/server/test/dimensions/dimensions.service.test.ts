import type { CreateDimensionRequest } from '@openbooks/shared-types';
import { describe, expect, it } from 'vitest';

import { newUuid } from '../../src/db';
import {
  ConflictError,
  NotFoundError,
  PermissionDeniedError,
  PreconditionFailedError,
  toWireError,
  ValidationError,
} from '../../src/errors';
import {
  archiveDimension,
  archiveDimensionValue,
  createDimension,
  createDimensionValue,
  deleteDimension,
  deleteDimensionValue,
  getDimension,
  getDimensionValue,
  listDimensions,
  listDimensionValues,
  unarchiveDimension,
  unarchiveDimensionValue,
  updateDimension,
  updateDimensionValue,
} from '../../src/modules/dimensions';
import { actorIn, useServiceDatabase } from './support';

/**
 * The dimensions service against real MySQL (spec §11 — never SQLite, never
 * mocks).
 *
 * Everything goes through the exported service functions rather than the
 * repository, because the properties asserted are properties of the service
 * boundary: the permission check, the conflict translation, the archive/delete
 * rules, and the A7 miss all live there, and a test reaching the repository would
 * pass while the boundary was missing.
 */
const DEPARTMENT: CreateDimensionRequest = {
  code: 'DEPT',
  name: 'Department',
  description: null,
};

const db = useServiceDatabase();

describe('dimensions service', () => {
  describe('axes: create, read, list, rename', () => {
    it('round-trips a created axis through read and list', async () => {
      const actor = await actorIn(db);

      const created = await createDimension(DEPARTMENT, actor.ctx);

      expect(created).toMatchObject({
        code: 'DEPT',
        name: 'Department',
        description: null,
        isActive: true,
      });

      expect(await getDimension(created.id, actor.ctx)).toEqual(created);
      expect((await listDimensions({}, actor.ctx)).items).toEqual([created]);
    });

    it('trims a code so the uniqueness key sees the value the user sees', async () => {
      const actor = await actorIn(db);

      const created = await createDimension({ ...DEPARTMENT, code: '  DEPT  ' }, actor.ctx);
      expect(created.code).toBe('DEPT');
    });

    it('refuses a duplicate code case-insensitively, naming it', async () => {
      const actor = await actorIn(db);
      await createDimension(DEPARTMENT, actor.ctx);

      const conflict = createDimension({ ...DEPARTMENT, code: 'dept' }, actor.ctx);
      await expect(conflict).rejects.toBeInstanceOf(ConflictError);
    });

    it('renames without touching the code, and refuses a code in the patch', async () => {
      const actor = await actorIn(db);
      const created = await createDimension(DEPARTMENT, actor.ctx);

      const renamed = await updateDimension(created.id, { name: 'Cost centre' }, actor.ctx);
      expect(renamed.name).toBe('Cost centre');
      expect(renamed.code).toBe('DEPT');

      // `code` is absent from the schema, which is a `strictObject`, so this is a
      // validation failure naming the field rather than a silent drop.
      await expect(
        updateDimension(created.id, { code: 'CC' } as never, actor.ctx),
      ).rejects.toBeInstanceOf(ValidationError);

      await expect(updateDimension(created.id, {}, actor.ctx)).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it('clears a description with an explicit null', async () => {
      const actor = await actorIn(db);
      const created = await createDimension({ ...DEPARTMENT, description: 'By team' }, actor.ctx);

      expect(
        (await updateDimension(created.id, { description: null }, actor.ctx)).description,
      ).toBeNull();
    });

    /**
     * By `code`, and the axes are created out of code order so the assertion is
     * about the ordering rather than about insertion order.
     */
    it('orders the list by code and filters by the active flag', async () => {
      const actor = await actorIn(db);

      await createDimension({ code: 'PROJ', name: 'Project' }, actor.ctx);
      await createDimension(DEPARTMENT, actor.ctx);
      const retired = await createDimension({ code: 'FUND', name: 'Fund' }, actor.ctx);
      await archiveDimension(retired.id, actor.ctx);

      const all = await listDimensions({}, actor.ctx);
      expect(all.items.map((item) => item.code)).toEqual(['DEPT', 'FUND', 'PROJ']);
      expect(all.nextCursor).toBeNull();

      const active = await listDimensions({ isActive: true }, actor.ctx);
      expect(active.items.map((item) => item.code)).toEqual(['DEPT', 'PROJ']);
    });

    it('pages the whole list exactly once', async () => {
      const actor = await actorIn(db);
      for (const code of ['A', 'B', 'C', 'D', 'E']) {
        await createDimension({ code, name: `Axis ${code}` }, actor.ctx);
      }

      const seen: string[] = [];
      let cursor: string | null = null;

      do {
        const page: Awaited<ReturnType<typeof listDimensions>> = await listDimensions(
          cursor === null ? { limit: 2 } : { limit: 2, cursor },
          actor.ctx,
        );
        seen.push(...page.items.map((item) => item.code));
        cursor = page.nextCursor;
      } while (cursor !== null);

      expect(seen).toEqual(['A', 'B', 'C', 'D', 'E']);
    });
  });

  describe('values', () => {
    it('creates values under an axis and lists them in code order', async () => {
      const actor = await actorIn(db);
      const axis = await createDimension(DEPARTMENT, actor.ctx);

      const sales = await createDimensionValue(
        axis.id,
        { code: 'SALES', name: 'Sales' },
        actor.ctx,
      );
      const ops = await createDimensionValue(
        axis.id,
        { code: 'OPS', name: 'Operations' },
        actor.ctx,
      );

      expect(sales.dimensionId).toBe(axis.id);
      expect(await getDimensionValue(ops.id, actor.ctx)).toEqual(ops);

      const page = await listDimensionValues(axis.id, {}, actor.ctx);
      expect(page.items.map((item) => item.code)).toEqual(['OPS', 'SALES']);
    });

    it('scopes value codes to their own axis', async () => {
      const actor = await actorIn(db);
      const department = await createDimension(DEPARTMENT, actor.ctx);
      const project = await createDimension({ code: 'PROJ', name: 'Project' }, actor.ctx);

      await createDimensionValue(department.id, { code: 'X', name: 'Dept X' }, actor.ctx);

      // The same code on another axis is a different value, not a conflict.
      const onProject = await createDimensionValue(
        project.id,
        { code: 'X', name: 'Job X' },
        actor.ctx,
      );
      expect(onProject.code).toBe('X');

      await expect(
        createDimensionValue(department.id, { code: 'x', name: 'Duplicate' }, actor.ctx),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it('renames a value and archives it without losing it', async () => {
      const actor = await actorIn(db);
      const axis = await createDimension(DEPARTMENT, actor.ctx);
      const value = await createDimensionValue(
        axis.id,
        { code: 'SALES', name: 'Sales' },
        actor.ctx,
      );

      expect((await updateDimensionValue(value.id, { name: 'Sales team' }, actor.ctx)).name).toBe(
        'Sales team',
      );

      const archived = await archiveDimensionValue(value.id, actor.ctx);
      expect(archived.isActive).toBe(false);

      // Idempotent: a retry of an archive is a retry, not a conflict.
      expect((await archiveDimensionValue(value.id, actor.ctx)).isActive).toBe(false);
      expect((await unarchiveDimensionValue(value.id, actor.ctx)).isActive).toBe(true);
    });

    it('refuses a new value on an archived axis', async () => {
      const actor = await actorIn(db);
      const axis = await createDimension(DEPARTMENT, actor.ctx);
      await archiveDimension(axis.id, actor.ctx);

      const refused = createDimensionValue(axis.id, { code: 'SALES', name: 'Sales' }, actor.ctx);
      await expect(refused).rejects.toBeInstanceOf(PreconditionFailedError);
      await expect(refused).rejects.toMatchObject({
        details: { precondition: 'dimension_archived' },
      });

      await unarchiveDimension(axis.id, actor.ctx);
      expect(
        await createDimensionValue(axis.id, { code: 'SALES', name: 'Sales' }, actor.ctx),
      ).toMatchObject({ code: 'SALES' });
    });

    it('404s a list of values for an axis that does not exist', async () => {
      const actor = await actorIn(db);

      await expect(listDimensionValues(newUuid(), {}, actor.ctx)).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  describe('deleting', () => {
    it('deletes an axis with no values, and refuses one that has them', async () => {
      const actor = await actorIn(db);
      const axis = await createDimension(DEPARTMENT, actor.ctx);
      const value = await createDimensionValue(
        axis.id,
        { code: 'SALES', name: 'Sales' },
        actor.ctx,
      );

      const refused = deleteDimension(axis.id, actor.ctx);
      await expect(refused).rejects.toBeInstanceOf(PreconditionFailedError);
      await expect(refused).rejects.toMatchObject({
        details: { precondition: 'dimension_has_values' },
      });

      await deleteDimensionValue(value.id, actor.ctx);
      await deleteDimension(axis.id, actor.ctx);

      await expect(getDimension(axis.id, actor.ctx)).rejects.toBeInstanceOf(NotFoundError);
    });

    it('frees the code it held, unlike archiving', async () => {
      const actor = await actorIn(db);
      const first = await createDimension(DEPARTMENT, actor.ctx);

      await archiveDimension(first.id, actor.ctx);
      // `uq_dimensions_org_code` covers archived rows, which is the whole reason
      // deletion exists for an axis nothing carries.
      await expect(createDimension(DEPARTMENT, actor.ctx)).rejects.toBeInstanceOf(ConflictError);

      await deleteDimension(first.id, actor.ctx);
      expect((await createDimension(DEPARTMENT, actor.ctx)).code).toBe('DEPT');
    });
  });

  describe('authority and isolation', () => {
    it('refuses a write to a role holding only dimensions.read, before validating', async () => {
      const owner = await actorIn(db);
      const reader = await actorIn(db, 'readOnly');

      // Reading is permitted for that role.
      await createDimension(DEPARTMENT, owner.ctx);
      expect((await listDimensions({}, reader.ctx)).items).toEqual([]);

      // The payload is invalid *and* the caller lacks authority; the authority
      // answer is the one that comes back, because a caller without it must not
      // learn which fields the operation accepts.
      const denied = createDimension({ code: '', name: '' }, reader.ctx);
      await expect(denied).rejects.toBeInstanceOf(PermissionDeniedError);
    });

    it('answers a cross-org read exactly as it answers a nonexistent one (A7)', async () => {
      const mine = await actorIn(db);
      const theirs = await actorIn(db);

      const axis = await createDimension(DEPARTMENT, theirs.ctx);
      const value = await createDimensionValue(axis.id, { code: 'SALES', name: 'S' }, theirs.ctx);

      const answerFor = async (dimensionId: string): Promise<unknown> =>
        toWireError(await getDimension(dimensionId, mine.ctx).catch((error: unknown) => error));

      const crossOrg = await answerFor(axis.id);
      const nonexistent = await answerFor(newUuid());
      const malformed = await answerFor('not-a-uuid');

      // Byte-identical, not merely the same status: `NotFoundError` carries a
      // resource token and nothing else.
      expect(JSON.stringify(crossOrg)).toBe(JSON.stringify(nonexistent));
      expect(JSON.stringify(malformed)).toBe(JSON.stringify(nonexistent));

      await expect(getDimensionValue(value.id, mine.ctx)).rejects.toBeInstanceOf(NotFoundError);
      // And the other org's axis is untouched by any of it.
      expect((await listDimensions({}, theirs.ctx)).items).toHaveLength(1);
    });
  });
});
