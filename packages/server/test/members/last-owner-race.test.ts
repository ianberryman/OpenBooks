import { beforeEach, describe, expect, it } from 'vitest';

import type { RequestContext } from '../../src/context';
import { changeMemberRole, removeMember } from '../../src/modules/members';
import { OWNER_ROLE_ID } from '../../src/modules/orgs';
import { SYSTEM_ROLE_UUIDS, useTestDatabase, uuidToBuffer, type TestDatabase } from '../db';
import {
  CONTENTION_WAIT_MS,
  connectionId,
  contextFor,
  countOwners,
  delay,
  parkedTransactionOn,
  transactionOn,
} from './race-support';

/**
 * **An org cannot lose its last Owner, under contention.**
 *
 * `members.service.test.ts` covers the sequential rule: one caller, one Owner,
 * refused. That test passes against an implementation with no locking at all,
 * which is exactly why it is not the whole story. The failure this file exists to
 * catch is the interleaving:
 *
 *   two Owners, A and B. One request demotes A, another removes B. Each reads the
 *   Owner set, counts two, concludes that one Owner will remain, and commits. The
 *   org ends with none — unadministrable, with no support path that reaches inside
 *   a tenant to repair it.
 *
 * `lockOwnerIds` takes `SELECT … FOR UPDATE` over `(org_id, role_id = owner)`, so
 * the second transaction queues on `idx_org_members_org_role` and re-reads after
 * the first commits. The evidence that the lock is doing the work — rather than
 * the two calls merely having run in some order — is `hasSettled()` returning
 * false across `CONTENTION_WAIT_MS` while the first side is parked. Without the
 * lock the second call answers immediately and that assertion fails.
 *
 * ## Why there is no `initializeDatabase()` here
 *
 * The same reason `test/enforcement/` gives: with no process pool, a query that
 * escaped the ambient transaction throws "Database not initialized" instead of
 * quietly running on a third connection, where it would see neither racer's
 * uncommitted state and the race would appear to pass having proved nothing.
 */
const db: TestDatabase = useTestDatabase();

interface Scene {
  readonly orgId: Buffer;
  /** The two Owners, and a context for each acting in their own right. */
  readonly first: { readonly uuid: string; readonly ctx: RequestContext };
  readonly second: { readonly uuid: string; readonly ctx: RequestContext };
}

let s: Scene;

beforeEach(async () => {
  const org = await db.factories.org();
  const one = await db.factories.user();
  const two = await db.factories.user();
  await db.factories.orgMember({ orgId: org.id, userId: one.id, role: 'owner' });
  await db.factories.orgMember({ orgId: org.id, userId: two.id, role: 'owner' });

  s = {
    orgId: org.id,
    first: { uuid: one.uuid, ctx: contextFor(org.uuid, OWNER_ROLE_ID, one.uuid) },
    second: { uuid: two.uuid, ctx: contextFor(org.uuid, OWNER_ROLE_ID, two.uuid) },
  };
});

describe('two Owners, demoted at the same moment', () => {
  it('lets exactly one through and refuses the other', async () => {
    const left = await db.openAppConnection();
    const right = await db.openAppConnection();

    try {
      // The harness's guarantee restated as an assertion: two handles sharing a
      // physical connection would serialize instead of racing, and every "did not
      // settle" assertion below would then be measuring the driver, not InnoDB.
      expect(await connectionId(left.db)).not.toBe(await connectionId(right.db));

      // The first demotion has taken the Owner-set lock and written its update.
      // Committed to nobody: from anywhere else the org still has two Owners.
      const demoteSecond = parkedTransactionOn(left, s.first.ctx, () =>
        changeMemberRole(
          { userId: s.second.uuid, roleId: SYSTEM_ROLE_UUIDS.readOnly },
          s.first.ctx,
        ),
      );
      await demoteSecond.parked;
      expect(await countOwners(db.app, s.orgId)).toBe(2);

      const demoteFirst = transactionOn(right, s.second.ctx, () =>
        changeMemberRole(
          { userId: s.first.uuid, roleId: SYSTEM_ROLE_UUIDS.readOnly },
          s.second.ctx,
        ),
      );
      await delay(CONTENTION_WAIT_MS);

      // The proof. `lockOwnerIds` is queued behind the parked transaction and
      // cannot answer either way. Without the lock this read would return the
      // pre-demotion snapshot — two Owners — and the second demotion would already
      // have succeeded.
      expect(demoteFirst.hasSettled()).toBe(false);

      demoteSecond.commit();
      await expect(demoteSecond.promise).resolves.toMatchObject({ roleCode: 'read_only' });

      // A locking read reads the latest committed row rather than the transaction's
      // snapshot, so the loser now learns the truth: it is about to remove the last
      // Owner, and is refused.
      await expect(demoteFirst.promise).rejects.toMatchObject({
        code: 'precondition_failed',
        details: { precondition: 'last_owner_in_org' },
      });

      expect(await countOwners(db.app, s.orgId)).toBe(1);
    } finally {
      await left.close();
      await right.close();
    }
  });

  /**
   * The same race with the two operations that can each reduce the Owner set
   * crossed over. A rule enforced in one path and not the other is not a rule, and
   * a demotion racing a *removal* is the interleaving a shared helper is most
   * likely to get wrong — the two write different statements against the same set.
   */
  it('holds when a removal races a demotion', async () => {
    const remover = await db.openAppConnection();
    const demoter = await db.openAppConnection();

    try {
      expect(await connectionId(remover.db)).not.toBe(await connectionId(demoter.db));

      const removeSecond = parkedTransactionOn(remover, s.first.ctx, () =>
        removeMember({ userId: s.second.uuid }, s.first.ctx),
      );
      await removeSecond.parked;

      const demoteFirst = transactionOn(demoter, s.second.ctx, () =>
        changeMemberRole(
          { userId: s.first.uuid, roleId: SYSTEM_ROLE_UUIDS.bookkeeper },
          s.second.ctx,
        ),
      );
      await delay(CONTENTION_WAIT_MS);
      expect(demoteFirst.hasSettled()).toBe(false);

      removeSecond.commit();
      await removeSecond.promise;

      await expect(demoteFirst.promise).rejects.toMatchObject({
        code: 'precondition_failed',
        details: { precondition: 'last_owner_in_org' },
      });
      expect(await countOwners(db.app, s.orgId)).toBe(1);
    } finally {
      await remover.close();
      await demoter.close();
    }
  });

  /**
   * The loser of the race must be refused *having written nothing*. A demotion
   * that rolled back after updating the row would be invisible here; a demotion
   * that committed its update and then threw would leave the org with no Owner and
   * an error message saying it had refused to allow exactly that.
   */
  it('leaves the refused side’s row untouched', async () => {
    const left = await db.openAppConnection();
    const right = await db.openAppConnection();

    try {
      const demoteSecond = parkedTransactionOn(left, s.first.ctx, () =>
        changeMemberRole(
          { userId: s.second.uuid, roleId: SYSTEM_ROLE_UUIDS.readOnly },
          s.first.ctx,
        ),
      );
      await demoteSecond.parked;

      const demoteFirst = transactionOn(right, s.second.ctx, () =>
        changeMemberRole(
          { userId: s.first.uuid, roleId: SYSTEM_ROLE_UUIDS.readOnly },
          s.second.ctx,
        ),
      );
      await delay(CONTENTION_WAIT_MS);
      expect(demoteFirst.hasSettled()).toBe(false);

      demoteSecond.commit();
      await demoteSecond.promise;
      await expect(demoteFirst.promise).rejects.toMatchObject({ code: 'precondition_failed' });

      const rows = await db.app
        .selectFrom('org_members')
        .select(['user_id', 'role_id'])
        .where('org_id', '=', s.orgId)
        .execute();

      expect(rows).toHaveLength(2);
      const survivor = rows.filter((row) => row.role_id.equals(ownerKey()));
      expect(survivor).toHaveLength(1);
      expect(survivor[0]?.user_id.equals(uuidToBuffer(s.first.uuid))).toBe(true);
    } finally {
      await left.close();
      await right.close();
    }
  });
});

function ownerKey(): Buffer {
  return uuidToBuffer(OWNER_ROLE_ID);
}
