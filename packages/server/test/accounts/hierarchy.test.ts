import { ACCOUNT_MAX_DEPTH } from '@openbooks/shared-types';
import type { Account, CreateAccountRequest } from '@openbooks/shared-types';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import type { RequestContext } from '../../src/context';
import { runInContext } from '../../src/context';
import { orgScope, tenantDb, uuidToBuffer } from '../../src/db';
import { NotFoundError, PreconditionFailedError, toWireError } from '../../src/errors';
import {
  createAccount,
  deleteAccount,
  getAccount,
  updateAccount,
} from '../../src/modules/accounts';
import { actorIn, useServiceDatabase } from './support';

/**
 * Chart-of-accounts hierarchy (OB-035).
 *
 * The composite foreign key already refuses a cross-org parent, so nothing here
 * is testing integrity. Every case below is one of the three things the schema
 * cannot say — no cycles, a bounded depth, a parent's type matching its
 * children's — plus the error surface, which is the reason the parent is resolved
 * through `tenantDb` before any statement names it.
 *
 * The cycle cases are attempted rather than asserted about. A test that read the
 * code and agreed with it would pass against an implementation that checked
 * nothing, which is why each one builds the tree and then tries to close it.
 */

/** MySQL's `ER_LOCK_WAIT_TIMEOUT`. */
const LOCK_WAIT_TIMEOUT_ERRNO = 1205;

const ASSET: CreateAccountRequest = {
  code: '1000',
  name: 'Assets',
  type: 'asset',
  normalBalance: 'debit',
};

const db = useServiceDatabase();

/** `count` assets in one chain, each the child of the one before. Returns root first. */
async function chain(count: number, ctx: RequestContext): Promise<readonly Account[]> {
  const accounts: Account[] = [];

  for (let level = 0; level < count; level += 1) {
    const parent = accounts.at(-1);
    accounts.push(
      await createAccount(
        {
          ...ASSET,
          code: `10${String(level).padStart(2, '0')}`,
          name: `Level ${String(level)}`,
          ...(parent === undefined ? {} : { parentAccountId: parent.id }),
        },
        ctx,
      ),
    );
  }

  return accounts;
}

function precondition(error: unknown): unknown {
  return (toWireError(error) as { readonly details?: { readonly precondition?: unknown } }).details
    ?.precondition;
}

describe('account hierarchy', () => {
  describe('attaching and detaching', () => {
    it('creates an account under a parent and reports the link', async () => {
      const actor = await actorIn(db);
      const parent = await createAccount(ASSET, actor.ctx);

      const child = await createAccount(
        { ...ASSET, code: '1010', name: 'Bank', parentAccountId: parent.id },
        actor.ctx,
      );

      expect(child.parentAccountId).toBe(parent.id);
      expect((await getAccount(child.id, actor.ctx)).parentAccountId).toBe(parent.id);
      expect(parent.parentAccountId).toBeNull();
    });

    it('re-parents an existing account and detaches it again with null', async () => {
      const actor = await actorIn(db);
      const [first, second] = await chain(2, actor.ctx);
      const orphan = await createAccount({ ...ASSET, code: '1500', name: 'Elsewhere' }, actor.ctx);

      const attached = await updateAccount(
        orphan.id,
        { parentAccountId: second?.id ?? '' },
        actor.ctx,
      );
      expect(attached.parentAccountId).toBe(second?.id);

      const moved = await updateAccount(orphan.id, { parentAccountId: first?.id ?? '' }, actor.ctx);
      expect(moved.parentAccountId).toBe(first?.id);

      const detached = await updateAccount(orphan.id, { parentAccountId: null }, actor.ctx);
      expect(detached.parentAccountId).toBeNull();
    });

    /**
     * A7, on the parent rather than on the subject.
     *
     * This is the case the note in `modules/accounts/index.ts` was written for.
     * Naming another org's account as a parent must not reach the foreign key: it
     * would be refused as errno 1452 and surface as an opaque 500, which is both a
     * worse answer and a distinguishable one. The assertion is deep equality of the
     * serialized errors, because two 404s that differ in any field are still an
     * existence oracle.
     */
    it('answers a cross-org parent exactly as it answers a nonexistent one', async () => {
      const mine = await actorIn(db);
      const theirs = await actorIn(db);
      const theirParent = await createAccount(ASSET, theirs.ctx);
      const nonexistent = '2f1b2b3c-4d5e-4f60-8a71-b2c3d4e5f607';

      const crossOrg = await createAccount(
        { ...ASSET, code: '1010', parentAccountId: theirParent.id },
        mine.ctx,
      ).catch((error: unknown) => error);
      const missing = await createAccount(
        { ...ASSET, code: '1020', parentAccountId: nonexistent },
        mine.ctx,
      ).catch((error: unknown) => error);
      const malformed = await createAccount(
        { ...ASSET, code: '1030', parentAccountId: nonexistent.replace('2f1b', 'zzzz') },
        mine.ctx,
      ).catch((error: unknown) => error);

      expect(crossOrg).toBeInstanceOf(NotFoundError);
      expect(toWireError(crossOrg)).toEqual(toWireError(missing));
      expect(toWireError(crossOrg)).toEqual({
        code: 'not_found',
        status: 404,
        message: 'No such account.',
        details: { resource: 'account' },
      });

      // A malformed uuid never reaches the schema at all — it is refused by
      // `z.uuid()` — so it is the one case that differs, and it differs by being a
      // 400 that discloses nothing about which accounts exist.
      expect(toWireError(malformed)).toMatchObject({ code: 'validation_failed' });

      // Nothing was created by any of the three.
      expect(await getAccount(theirParent.id, theirs.ctx)).toEqual(theirParent);
    });
  });

  /**
   * The check the schema cannot make. A self-referencing foreign key is entirely
   * satisfied by `a → b → a`; every report that totals a subtree walks it, and a
   * walk over a cycle does not return.
   */
  describe('cycles', () => {
    it('refuses an account as its own parent', async () => {
      const actor = await actorIn(db);
      const account = await createAccount(ASSET, actor.ctx);

      const error = await updateAccount(
        account.id,
        { parentAccountId: account.id },
        actor.ctx,
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(PreconditionFailedError);
      expect(precondition(error)).toBe('account_parent_cycle');
      expect((await getAccount(account.id, actor.ctx)).parentAccountId).toBeNull();
    });

    it('refuses a two-account cycle', async () => {
      const actor = await actorIn(db);
      const [root, child] = await chain(2, actor.ctx);

      const error = await updateAccount(
        root?.id ?? '',
        { parentAccountId: child?.id ?? '' },
        actor.ctx,
      ).catch((caught: unknown) => caught);

      expect(precondition(error)).toBe('account_parent_cycle');
    });

    /**
     * The case a naive check misses. Comparing the new parent against the subject —
     * or against the subject's immediate children — passes here, because `great` is
     * three generations away.
     */
    it('refuses a cycle through a distant descendant', async () => {
      const actor = await actorIn(db);
      const [root, , , great] = await chain(4, actor.ctx);

      const error = await updateAccount(
        root?.id ?? '',
        { parentAccountId: great?.id ?? '' },
        actor.ctx,
      ).catch((caught: unknown) => caught);

      expect(precondition(error)).toBe('account_parent_cycle');

      // And the tree is untouched — a refusal that had already written would be a
      // cycle recorded and then reported.
      expect((await getAccount(root?.id ?? '', actor.ctx)).parentAccountId).toBeNull();
    });
  });

  describe('the depth bound', () => {
    it(`permits a chain exactly ${String(ACCOUNT_MAX_DEPTH)} deep and refuses one deeper`, async () => {
      const actor = await actorIn(db);
      const deepest = (await chain(ACCOUNT_MAX_DEPTH, actor.ctx)).at(-1);

      const error = await createAccount(
        { ...ASSET, code: '9999', name: 'One too many', parentAccountId: deepest?.id ?? '' },
        actor.ctx,
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(PreconditionFailedError);
      expect(precondition(error)).toBe('account_depth_exceeded');
    });

    /**
     * Depth is a property of the whole tree, not of the account being moved.
     *
     * Attaching a *leaf* at the bound's edge is the easy case; attaching a subtree
     * is where a check that only counted ancestors is wrong. Here the new parent
     * sits at depth `MAX - 1`, which would admit a leaf, and the subject carries two
     * generations below it.
     */
    it('counts the subject’s descendants, not only the parent’s ancestors', async () => {
      const actor = await actorIn(db);
      const shallow = (await chain(ACCOUNT_MAX_DEPTH - 1, actor.ctx)).at(-1);

      const subtreeRoot = await createAccount(
        { ...ASSET, code: '2000', name: 'Subtree' },
        actor.ctx,
      );
      const subtreeChild = await createAccount(
        { ...ASSET, code: '2010', name: 'Subtree child', parentAccountId: subtreeRoot.id },
        actor.ctx,
      );
      await createAccount(
        { ...ASSET, code: '2020', name: 'Subtree grandchild', parentAccountId: subtreeChild.id },
        actor.ctx,
      );

      const error = await updateAccount(
        subtreeRoot.id,
        { parentAccountId: shallow?.id ?? '' },
        actor.ctx,
      ).catch((caught: unknown) => caught);

      expect(precondition(error)).toBe('account_depth_exceeded');

      // A leaf at the same position is fine, so the refusal was about the subtree
      // and not about the parent's depth alone.
      const leaf = await createAccount(
        { ...ASSET, code: '3000', name: 'Leaf', parentAccountId: shallow?.id ?? '' },
        actor.ctx,
      );
      expect(leaf.parentAccountId).toBe(shallow?.id);
    });
  });

  describe('a parent’s type', () => {
    it('refuses a parent of a different type', async () => {
      const actor = await actorIn(db);
      const asset = await createAccount(ASSET, actor.ctx);

      const error = await createAccount(
        {
          code: '4000',
          name: 'Sales',
          type: 'revenue',
          normalBalance: 'credit',
          parentAccountId: asset.id,
        },
        actor.ctx,
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(PreconditionFailedError);
      expect(precondition(error)).toBe('account_parent_type_mismatch');
    });

    /**
     * A contra account is an `asset` with a `credit` normal balance, so the rule is
     * on `type` alone. Tying it to `normalBalance` too would make accumulated
     * depreciation unable to sit under fixed assets, which is where it belongs on
     * every balance sheet.
     */
    it('permits a child whose normal balance differs from its parent’s', async () => {
      const actor = await actorIn(db);
      const fixedAssets = await createAccount(ASSET, actor.ctx);

      const accumulatedDepreciation = await createAccount(
        {
          code: '1500',
          name: 'Accumulated depreciation',
          type: 'asset',
          normalBalance: 'credit',
          parentAccountId: fixedAssets.id,
        },
        actor.ctx,
      );

      expect(accumulatedDepreciation.parentAccountId).toBe(fixedAssets.id);
    });

    it('refuses a reclassification that would disagree with the parent it keeps', async () => {
      const actor = await actorIn(db);
      const [, child] = await chain(2, actor.ctx);

      const error = await updateAccount(
        child?.id ?? '',
        { type: 'expense', normalBalance: 'debit' },
        actor.ctx,
      ).catch((caught: unknown) => caught);

      expect(precondition(error)).toBe('account_parent_type_mismatch');
    });

    /**
     * Downwards, the refusal names the children rather than cascading to them.
     * Reclassifying a subtree moves every balance under it to a different statement,
     * so it is several deliberate operations and not one.
     */
    it('refuses a reclassification while the account has children', async () => {
      const actor = await actorIn(db);
      const [root, child] = await chain(2, actor.ctx);

      const error = await updateAccount(root?.id ?? '', { type: 'expense' }, actor.ctx).catch(
        (caught: unknown) => caught,
      );

      expect(precondition(error)).toBe('account_has_children');

      // Detaching the child makes the same change ordinary configuration.
      await updateAccount(child?.id ?? '', { parentAccountId: null }, actor.ctx);
      const reclassified = await updateAccount(root?.id ?? '', { type: 'expense' }, actor.ctx);
      expect(reclassified.type).toBe('expense');
    });

    it('leaves a reclassification alone when it moves to a parent that agrees', async () => {
      const actor = await actorIn(db);
      const expenses = await createAccount(
        { code: '6000', name: 'Expenses', type: 'expense', normalBalance: 'debit' },
        actor.ctx,
      );
      const orphan = await createAccount({ ...ASSET, code: '1500', name: 'Misfiled' }, actor.ctx);

      const moved = await updateAccount(
        orphan.id,
        { type: 'expense', parentAccountId: expenses.id },
        actor.ctx,
      );

      expect(moved).toMatchObject({ type: 'expense', parentAccountId: expenses.id });
    });
  });

  /**
   * `fk_accounts_parent` is `ON DELETE RESTRICT`, so the database refuses this
   * regardless of what the service concluded — with the same errno a posted-to
   * account produces. The service's own check exists so the caller is told *which*
   * reference it was, and gets a remedy that applies.
   */
  describe('deleting a parent', () => {
    it('refuses while children exist and permits once they are detached', async () => {
      const actor = await actorIn(db);
      const [root, child] = await chain(2, actor.ctx);

      const error = await deleteAccount(root?.id ?? '', actor.ctx).catch(
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(PreconditionFailedError);
      expect(precondition(error)).toBe('account_has_children');

      await updateAccount(child?.id ?? '', { parentAccountId: null }, actor.ctx);
      await deleteAccount(root?.id ?? '', actor.ctx);

      await expect(getAccount(root?.id ?? '', actor.ctx)).rejects.toBeInstanceOf(NotFoundError);
      expect((await getAccount(child?.id ?? '', actor.ctx)).parentAccountId).toBeNull();
    });
  });

  /**
   * The race the cycle check would otherwise lose, proven rather than assumed.
   *
   * "Make A a child of B" and "make B a child of A" arriving together is the whole
   * of the concurrency problem here: under REPEATABLE READ each transaction reads a
   * snapshot in which the other's change has not happened, both walks find no
   * cycle, and both commit — leaving a two-account loop that no later read can
   * detect and every report walker hangs on.
   *
   * What prevents it is that the ancestor walk reads `FOR UPDATE`, so the first
   * request holds a lock on the account the second one must modify. This asserts
   * exactly that: `updateAccount` runs inside an ambient transaction that is still
   * open, and a genuinely separate connection is shown to *block* on the account it
   * locked. A sequential simulation of the same two calls passes against code with
   * no locking at all, which is why the second connection is real and the assertion
   * is a lock-wait timeout.
   */
  describe('concurrent re-parenting', () => {
    it('holds a lock on the prospective parent that blocks the reverse move', async () => {
      const actor = await actorIn(db);
      const first = await createAccount({ ...ASSET, code: '1000', name: 'A' }, actor.ctx);
      const second = await createAccount({ ...ASSET, code: '2000', name: 'B' }, actor.ctx);

      const contender = await db.openAppConnection();
      try {
        await sql`SET SESSION innodb_lock_wait_timeout = 1`.execute(contender.db);

        await runInContext(actor.ctx, () =>
          tenantDb(orgScope(actor.ctx.orgId)).transaction(async () => {
            await updateAccount(first.id, { parentAccountId: second.id }, actor.ctx);

            // The reverse move, as raw SQL so nothing but the lock is in the way.
            await expect(
              sql`
                UPDATE accounts SET parent_account_id = ${uuidToBuffer(first.id)}
                WHERE id = ${uuidToBuffer(second.id)}
              `.execute(contender.db),
            ).rejects.toMatchObject({ errno: LOCK_WAIT_TIMEOUT_ERRNO });
          }),
        );

        // The same statement succeeds once the first transaction has ended, so the
        // failure above was contention and not a missing privilege — and the second
        // writer would now be refused by the service's own walk rather than by a lock.
        const reversed = await updateAccount(
          second.id,
          { parentAccountId: first.id },
          actor.ctx,
        ).catch((caught: unknown) => caught);
        expect(precondition(reversed)).toBe('account_parent_cycle');
      } finally {
        await contender.close();
      }
    });
  });
});
