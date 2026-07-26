import { beforeEach, describe, expect, it } from 'vitest';

import { initializeDatabase, destroyDatabase, isDatabaseInitialized, tenantDb } from '../../src/db';
import { hasAmbientTransaction } from '../../src/db/transaction-scope';
import { newUuidBuffer } from '../../src/db/uuid';
import { useTestDatabase } from '../db';

/**
 * Ambient transaction propagation.
 *
 * The bug this guards was invisible to both tickets that created it: the
 * idempotency service passed its own tests, the posting service would have passed
 * its own, and composing them produced two transactions on two connections. A
 * rollback of one would leave the other committed, which breaks acceptance A8 at
 * the seam. The tests that matter here are therefore the ones that observe the
 * *connection*, not the API.
 */
const harness = useTestDatabase();

/**
 * These tests drive the real `tenantDb()` entrypoint rather than constructing a
 * `TenantDatabase` directly, because the whole question is what `tenantDb()`
 * resolves to when called deep inside someone else's transaction. That requires
 * the module-private singleton to be initialized.
 */
beforeEach(async () => {
  if (isDatabaseInitialized()) await destroyDatabase();
  initializeDatabase(harness.appConnectionConfig);
});

describe('ambient transaction propagation', () => {
  it('reports no ambient transaction outside one', () => {
    expect(hasAmbientTransaction()).toBe(false);
  });

  it('exposes an ambient transaction inside one, and clears it after', async () => {
    const org = await harness.factories.org();

    await tenantDb(org.id).transaction(async () => {
      expect(hasAmbientTransaction()).toBe(true);
      await Promise.resolve();
    });

    expect(hasAmbientTransaction()).toBe(false);
  });

  it('makes an inner tenantDb() join the outer transaction, not open its own', async () => {
    const org = await harness.factories.org();
    const orgId = org.id;
    const code = `9${String(Date.now()).slice(-4)}`;

    // The decisive assertion. The inner call resolves its own handle through
    // tenantDb(), exactly as a nested service would, and its write must be
    // undone by the OUTER rollback — which is only possible on one transaction.
    await expect(
      tenantDb(orgId).transaction(async () => {
        await tenantDb(orgId)
          .insertInto('accounts')
          .values({
            id: newUuidBuffer(),
            code,
            name: 'Inner write',
            type: 'asset',
            normal_balance: 'debit',
          })
          .execute();

        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    const survivors = await tenantDb(orgId)
      .selectFrom('accounts')
      .select('code')
      .where('accounts.code', '=', code)
      .execute();

    expect(survivors).toHaveLength(0);
  });

  it('commits an inner write when the outer transaction commits', async () => {
    const org = await harness.factories.org();
    const orgId = org.id;
    const code = `8${String(Date.now()).slice(-4)}`;

    await tenantDb(orgId).transaction(async () => {
      await tenantDb(orgId)
        .insertInto('accounts')
        .values({
          id: newUuidBuffer(),
          code,
          name: 'Inner write',
          type: 'asset',
          normal_balance: 'debit',
        })
        .execute();
    });

    const rows = await tenantDb(orgId)
      .selectFrom('accounts')
      .select('code')
      .where('accounts.code', '=', code)
      .execute();

    expect(rows).toHaveLength(1);
  });

  it('does not leak one org transaction into a sibling async task', async () => {
    // AsyncLocalStorage isolation is the property that makes this safe to make
    // ambient at all. Two concurrent operations must not see each other's
    // transaction, or one request could commit inside another's unit of work.
    const org = await harness.factories.org();
    const orgId = org.id;

    const observations: boolean[] = [];

    await Promise.all([
      tenantDb(orgId).transaction(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        observations.push(hasAmbientTransaction());
      }),
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        observations.push(hasAmbientTransaction());
      })(),
    ]);

    // The sibling saw no transaction; the transactional task saw its own.
    expect(observations.sort()).toEqual([false, true]);
  });

  it('nests without attempting a second real transaction', async () => {
    const org = await harness.factories.org();
    const orgId = org.id;
    let depth = 0;

    await tenantDb(orgId).transaction(async () => {
      depth += 1;
      await tenantDb(orgId).transaction(async () => {
        depth += 1;
        // MySQL has no nested transactions; a second BEGIN would silently commit
        // the first. Reaching here at all means the inner call joined.
        expect(hasAmbientTransaction()).toBe(true);
        await Promise.resolve();
      });
    });

    expect(depth).toBe(2);
  });
});
