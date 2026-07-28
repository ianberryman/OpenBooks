import type { CreateAccountRequest, UpdateAccountRequest } from '@openbooks/shared-types';
import { describe, expect, it } from 'vitest';

import { bufferToUuid, newUuidBuffer, uuidToBuffer } from '../../src/db';
import {
  ConflictError,
  NotFoundError,
  PermissionDeniedError,
  PreconditionFailedError,
  toWireError,
  ValidationError,
} from '../../src/errors';
import {
  createAccount,
  deactivateAccount,
  deleteAccount,
  getAccount,
  listAccounts,
  reactivateAccount,
  updateAccount,
} from '../../src/modules/accounts';
import { SYSTEM_ROLE_UUIDS, systemRoleId } from '../db';
import { actorIn, contextFor, useServiceDatabase } from './support';

/**
 * The accounts service against real MySQL (spec §11 — never SQLite, never mocks).
 *
 * Everything here goes through the exported service functions rather than through
 * the repository, because the properties being asserted are properties of the
 * service boundary: the permission check, the conflict translation, and the A7
 * miss all live there, and a test that reached the repository would pass while the
 * boundary was missing.
 */
const CASH: CreateAccountRequest = {
  code: '1000',
  name: 'Operating bank account',
  type: 'asset',
  normalBalance: 'debit',
  description: null,
};

describe('accounts service', () => {
  const db = useServiceDatabase();

  describe('create, read, list, update', () => {
    it('round-trips a created account through read and list', async () => {
      const actor = await actorIn(db);

      const created = await createAccount(CASH, actor.ctx);

      expect(created).toMatchObject({
        code: '1000',
        name: 'Operating bank account',
        type: 'asset',
        normalBalance: 'debit',
        description: null,
        cashBasisRole: null,
        isActive: true,
      });

      const fetched = await getAccount(created.id, actor.ctx);
      expect(fetched).toEqual(created);

      const listed = await listAccounts({}, actor.ctx);
      expect(listed.items).toEqual([created]);
    });

    it('applies a partial update and leaves absent fields alone', async () => {
      const actor = await actorIn(db);
      const created = await createAccount(
        { ...CASH, description: 'Main current account' },
        actor.ctx,
      );

      const updated = await updateAccount(created.id, { name: 'Chequing' }, actor.ctx);

      expect(updated.name).toBe('Chequing');
      expect(updated.code).toBe(created.code);
      expect(updated.description).toBe('Main current account');
      expect(updated.id).toBe(created.id);
    });

    it('clears a description with an explicit null and rejects an empty patch', async () => {
      const actor = await actorIn(db);
      const created = await createAccount({ ...CASH, description: 'Temporary' }, actor.ctx);

      const cleared = await updateAccount(created.id, { description: null }, actor.ctx);
      expect(cleared.description).toBeNull();

      await expect(updateAccount(created.id, {}, actor.ctx)).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    /**
     * `cashBasisRole` takes the same three-valued patch `description` does: absent
     * leaves it alone, `null` clears it, a value sets it. Accounts are created
     * unclassified (`createAccountRequestSchema` accepts no such field), so the
     * round trip starts from `null` rather than from a value created with.
     */
    it('sets, leaves alone, and clears cashBasisRole through the same three-valued patch', async () => {
      const actor = await actorIn(db);
      const created = await createAccount(CASH, actor.ctx);
      expect(created.cashBasisRole).toBeNull();

      const classified = await updateAccount(created.id, { cashBasisRole: 'cash' }, actor.ctx);
      expect(classified.cashBasisRole).toBe('cash');

      const untouched = await updateAccount(classified.id, { name: 'Operating' }, actor.ctx);
      expect(untouched.cashBasisRole).toBe('cash');

      const cleared = await updateAccount(untouched.id, { cashBasisRole: null }, actor.ctx);
      expect(cleared.cashBasisRole).toBeNull();

      const reread = await getAccount(cleared.id, actor.ctx);
      expect(reread.cashBasisRole).toBeNull();
    });

    it('trims a code so the uniqueness key sees the value the user sees', async () => {
      const actor = await actorIn(db);

      const created = await createAccount({ ...CASH, code: '  2000  ' }, actor.ctx);
      expect(created.code).toBe('2000');
    });

    /**
     * By `code` since D-27, and the accounts are deliberately created out of code
     * order so the assertion is about the ordering rather than about insertion.
     * Nothing is stamped: the ordering columns are `code` and `id`, neither of
     * which has anything to do with the clock, which is the ergonomic half of
     * making the code immutable.
     */
    it('orders a list by code and filters by type and active flag', async () => {
      const actor = await actorIn(db);

      const revenue = await createAccount(
        { code: '4000', name: 'Sales', type: 'revenue', normalBalance: 'credit' },
        actor.ctx,
      );
      const cash = await createAccount(CASH, actor.ctx);
      const retired = await createAccount(
        { code: '1100', name: 'Old petty cash', type: 'asset', normalBalance: 'debit' },
        actor.ctx,
      );
      await deactivateAccount(retired.id, actor.ctx);

      const all = await listAccounts({}, actor.ctx);
      expect(all.items.map((account) => account.code)).toEqual(['1000', '1100', '4000']);
      expect(all.nextCursor).toBeNull();

      const assets = await listAccounts({ type: 'asset' }, actor.ctx);
      expect(assets.items.map((account) => account.id)).toEqual([cash.id, retired.id]);

      const active = await listAccounts({ isActive: true }, actor.ctx);
      expect(active.items.map((account) => account.id)).toEqual([cash.id, revenue.id]);

      const inactive = await listAccounts({ isActive: false }, actor.ctx);
      expect(inactive.items.map((account) => account.id)).toEqual([retired.id]);
    });

    it('lists only the caller org’s accounts', async () => {
      const mine = await actorIn(db);
      const theirs = await actorIn(db);

      await createAccount(CASH, mine.ctx);
      await createAccount(CASH, theirs.ctx);

      const listed = await listAccounts({}, mine.ctx);
      expect(listed.items).toHaveLength(1);
    });
  });

  /**
   * Contra accounts are the reason `0002_ledger` stores `normal_balance` instead of
   * deriving it from `type`, and the reason no constraint ties the two together.
   * If a future migration adds one, this is the test that fails.
   */
  describe('contra accounts', () => {
    it('represents an asset with a credit normal balance', async () => {
      const actor = await actorIn(db);

      const accumulatedDepreciation = await createAccount(
        {
          code: '1500',
          name: 'Accumulated depreciation',
          type: 'asset',
          normalBalance: 'credit',
        },
        actor.ctx,
      );

      expect(accumulatedDepreciation.type).toBe('asset');
      expect(accumulatedDepreciation.normalBalance).toBe('credit');

      // And through a read, so the value is asserted as persisted rather than as
      // echoed back from the request.
      const fetched = await getAccount(accumulatedDepreciation.id, actor.ctx);
      expect(fetched.normalBalance).toBe('credit');
    });

    it('represents a revenue account with a debit normal balance', async () => {
      const actor = await actorIn(db);

      const salesReturns = await createAccount(
        { code: '4900', name: 'Sales returns', type: 'revenue', normalBalance: 'debit' },
        actor.ctx,
      );

      expect(salesReturns).toMatchObject({ type: 'revenue', normalBalance: 'debit' });
    });
  });

  describe('unique code per org', () => {
    it('is a ConflictError within one org, not a driver error', async () => {
      const actor = await actorIn(db);
      await createAccount(CASH, actor.ctx);

      const error = await createAccount({ ...CASH, name: 'Second' }, actor.ctx).catch(
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(ConflictError);
      expect(toWireError(error)).toMatchObject({ code: 'conflict', status: 409 });
    });

    it('treats the same code in two orgs as two different accounts', async () => {
      const mine = await actorIn(db);
      const theirs = await actorIn(db);

      const first = await createAccount(CASH, mine.ctx);
      const second = await createAccount(CASH, theirs.ctx);

      expect(first.code).toBe(second.code);
      expect(first.id).not.toBe(second.id);
    });

    it('is a conflict for a code differing only in case, matching the column collation', async () => {
      const actor = await actorIn(db);
      await createAccount({ ...CASH, code: '1000a' }, actor.ctx);

      await expect(
        createAccount({ ...CASH, code: '1000A', name: 'Other' }, actor.ctx),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    /**
     * D-27, at the service rather than at the schema.
     *
     * `test/accounts/schemas.test.ts` asserts that the field is rejected by name;
     * this asserts the consequence a caller cares about — the stored code does not
     * change — and it is here because the M1 test it replaces asserted the
     * opposite. A code collision on update was a `ConflictError` then, and the way
     * that failure is now unreachable is that the operation does not exist.
     */
    it('refuses a code change outright rather than resolving a collision', async () => {
      const actor = await actorIn(db);
      await createAccount(CASH, actor.ctx);
      const other = await createAccount(
        { code: '2000', name: 'Payables', type: 'liability', normalBalance: 'credit' },
        actor.ctx,
      );

      const patch = { code: '1000' } as unknown as UpdateAccountRequest;
      const error = await updateAccount(other.id, patch, actor.ctx).catch(
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(ValidationError);
      expect(toWireError(error)).toMatchObject({
        code: 'validation_failed',
        details: { issues: [{ path: 'code' }] },
      });

      // A free code, not just a taken one: the refusal is about the field, not
      // about the collision.
      await expect(
        updateAccount(other.id, { code: '3000' } as unknown as UpdateAccountRequest, actor.ctx),
      ).rejects.toBeInstanceOf(ValidationError);

      expect((await getAccount(other.id, actor.ctx)).code).toBe('2000');
    });
  });

  describe('removal', () => {
    it('hard-deletes an account that has never been posted to', async () => {
      const actor = await actorIn(db);
      const created = await createAccount(CASH, actor.ctx);

      await deleteAccount(created.id, actor.ctx);

      await expect(getAccount(created.id, actor.ctx)).rejects.toBeInstanceOf(NotFoundError);
      expect((await listAccounts({}, actor.ctx)).items).toEqual([]);
    });

    it('refuses to delete an account with postings, and deactivates it instead', async () => {
      const actor = await actorIn(db);
      const debit = await createAccount(CASH, actor.ctx);
      const credit = await createAccount(
        { code: '2000', name: 'Payables', type: 'liability', normalBalance: 'credit' },
        actor.ctx,
      );

      await db.factories.journal({
        orgId: actor.orgId,
        lines: [
          { accountId: uuidToBuffer(debit.id), debitMinor: 250_00n },
          { accountId: uuidToBuffer(credit.id), creditMinor: 250_00n },
        ],
      });

      const error = await deleteAccount(debit.id, actor.ctx).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(PreconditionFailedError);
      // The precondition token is what a client branches on; the prose is not.
      expect(toWireError(error)).toMatchObject({
        code: 'precondition_failed',
        status: 412,
        details: { precondition: 'account_has_postings' },
      });

      // Still there, and still deactivatable — which is the point of refusing.
      const deactivated = await deactivateAccount(debit.id, actor.ctx);
      expect(deactivated.isActive).toBe(false);
      expect((await getAccount(debit.id, actor.ctx)).isActive).toBe(false);
    });

    it('deactivates and reactivates idempotently', async () => {
      const actor = await actorIn(db);
      const created = await createAccount(CASH, actor.ctx);

      expect((await deactivateAccount(created.id, actor.ctx)).isActive).toBe(false);
      expect((await deactivateAccount(created.id, actor.ctx)).isActive).toBe(false);
      expect((await reactivateAccount(created.id, actor.ctx)).isActive).toBe(true);
      expect((await reactivateAccount(created.id, actor.ctx)).isActive).toBe(true);
    });

    it('refuses a type or normal-balance change once the account has postings', async () => {
      const actor = await actorIn(db);
      const debit = await createAccount(
        { code: '6000', name: 'Rent', type: 'expense', normalBalance: 'debit' },
        actor.ctx,
      );
      const credit = await createAccount(
        { code: '2000', name: 'Payables', type: 'liability', normalBalance: 'credit' },
        actor.ctx,
      );

      // Editable before the first posting.
      const reclassified = await updateAccount(debit.id, { type: 'asset' }, actor.ctx);
      expect(reclassified.type).toBe('asset');
      await updateAccount(debit.id, { type: 'expense' }, actor.ctx);

      await db.factories.journal({
        orgId: actor.orgId,
        lines: [
          { accountId: uuidToBuffer(debit.id), debitMinor: 100_00n },
          { accountId: uuidToBuffer(credit.id), creditMinor: 100_00n },
        ],
      });

      await expect(updateAccount(debit.id, { type: 'asset' }, actor.ctx)).rejects.toBeInstanceOf(
        PreconditionFailedError,
      );
      await expect(
        updateAccount(debit.id, { normalBalance: 'credit' }, actor.ctx),
      ).rejects.toBeInstanceOf(PreconditionFailedError);

      // Re-sending the values it already holds is a no-op, not a refusal, and the
      // labels stay editable.
      const renamed = await updateAccount(
        debit.id,
        { type: 'expense', normalBalance: 'debit', name: 'Office rent' },
        actor.ctx,
      );
      expect(renamed.name).toBe('Office rent');
    });
  });

  /**
   * A7: a cross-org read returns nothing and does not leak existence.
   *
   * The assertion is deep equality of the serialized errors rather than "both are
   * 404s". Two 404s that differ in `message` or in `details.resource` are still an
   * existence oracle, and the only reason they cannot differ here is that both
   * reach the same `assertFound` call — see the A7 commentary on `NotFoundError`.
   */
  describe('A7 — cross-org reads are indistinguishable from misses', () => {
    it('answers a cross-org id exactly as it answers a nonexistent one', async () => {
      const mine = await actorIn(db);
      const theirs = await actorIn(db);
      const theirAccount = await createAccount(CASH, theirs.ctx);
      const nonexistent = '2f1b2b3c-4d5e-4f60-8a71-b2c3d4e5f607';

      const crossOrg = await getAccount(theirAccount.id, mine.ctx).catch((error: unknown) => error);
      const missing = await getAccount(nonexistent, mine.ctx).catch((error: unknown) => error);

      expect(crossOrg).toBeInstanceOf(NotFoundError);
      expect(toWireError(crossOrg)).toEqual(toWireError(missing));
      expect(toWireError(crossOrg)).toEqual({
        code: 'not_found',
        status: 404,
        message: 'No such account.',
        details: { resource: 'account' },
      });
    });

    it('answers a malformed id the same way, rather than as a validation failure', async () => {
      const mine = await actorIn(db);
      const nonexistent = '2f1b2b3c-4d5e-4f60-8a71-b2c3d4e5f607';

      const malformed = await getAccount('not-a-uuid', mine.ctx).catch((error: unknown) => error);
      const missing = await getAccount(nonexistent, mine.ctx).catch((error: unknown) => error);

      expect(toWireError(malformed)).toEqual(toWireError(missing));
    });

    it('does not let a cross-org account be updated, deactivated, or deleted', async () => {
      const mine = await actorIn(db);
      const theirs = await actorIn(db);
      const theirAccount = await createAccount(CASH, theirs.ctx);

      await expect(
        updateAccount(theirAccount.id, { name: 'Mine now' }, mine.ctx),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(deactivateAccount(theirAccount.id, mine.ctx)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(deleteAccount(theirAccount.id, mine.ctx)).rejects.toBeInstanceOf(NotFoundError);

      // Untouched, as seen by its own org.
      expect(await getAccount(theirAccount.id, theirs.ctx)).toEqual(theirAccount);
    });
  });

  /**
   * Enforcement is service-layer only (spec §2.4, §5), so these assertions are made
   * against the service with no transport in the picture. `read_only` is a seeded
   * system role holding every `*.read` code and no writes — migration `0001_tenancy`
   * — so it is the real pair the catalog ships rather than a bundle invented here.
   */
  describe('requirePermission', () => {
    it('refuses every mutating operation to a role without accounts.write', async () => {
      const owner = await actorIn(db, 'owner');
      const existing = await createAccount(CASH, owner.ctx);

      const reader = await actorIn(db, 'readOnly');

      await expect(createAccount(CASH, reader.ctx)).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(
        updateAccount(existing.id, { name: 'Renamed' }, reader.ctx),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(deactivateAccount(existing.id, reader.ctx)).rejects.toBeInstanceOf(
        PermissionDeniedError,
      );
      await expect(reactivateAccount(existing.id, reader.ctx)).rejects.toBeInstanceOf(
        PermissionDeniedError,
      );
      await expect(deleteAccount(existing.id, reader.ctx)).rejects.toBeInstanceOf(
        PermissionDeniedError,
      );
    });

    it('allows a role holding accounts.read to read what a writer created', async () => {
      const owner = await actorIn(db);
      const created = await createAccount(CASH, owner.ctx);

      const readerUser = await db.factories.user();
      await db.factories.orgMember({
        orgId: owner.orgId,
        userId: readerUser.id,
        roleId: systemRoleId('readOnly'),
      });
      const readerCtx = contextFor(owner.orgUuid, SYSTEM_ROLE_UUIDS.readOnly, readerUser.uuid);

      expect(await getAccount(created.id, readerCtx)).toEqual(created);
      expect((await listAccounts({}, readerCtx)).items).toEqual([created]);
    });

    /**
     * Every one of the six seeded roles carries `accounts.read`, so proving the read
     * gate exists needs a role that does not — which in M1 means a custom role with
     * an empty bundle. Custom roles are v2 (`roles.org_id` is non-null for them) and
     * the harness clears them between tests, so this creates one directly.
     */
    it('refuses a read to a role carrying no permissions', async () => {
      const owner = await actorIn(db);
      const created = await createAccount(CASH, owner.ctx);

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

      await expect(getAccount(created.id, powerless)).rejects.toBeInstanceOf(PermissionDeniedError);
      await expect(listAccounts({}, powerless)).rejects.toBeInstanceOf(PermissionDeniedError);
    });

    it('checks authority before validating the payload', async () => {
      const reader = await actorIn(db, 'readOnly');

      // The payload is invalid in three ways. An unauthorized caller must learn only
      // that they are unauthorized: a validation failure here would describe the
      // shape of an operation they may not perform.
      const error = await createAccount(
        { code: '', name: '', type: 'asset', normalBalance: 'debit' },
        reader.ctx,
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(PermissionDeniedError);
    });
  });
});
