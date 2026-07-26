import { fromMinorUnits } from '@openbooks/shared-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRequestContext, runInContext } from '../../src/context';
import { destroyDatabase, initializeDatabase, TenantDatabase } from '../../src/db';
import { IdempotencyKeyConflictError, ValidationError } from '../../src/errors';
import {
  IDEMPOTENCY_RETENTION_MS,
  purgeExpiredIdempotencyKeys,
  runIdempotent,
  withIdempotency,
} from '../../src/modules/idempotency';
import { useTestDatabase } from '../db/harness';
import { SYSTEM_ROLE_UUIDS } from '../db/factories';
import { accountCodes, accountWriter, claimRows } from './support';

/**
 * Idempotent execution against real MySQL (OB-017; spec §11, §12).
 *
 * Everything here runs as `openbooks_app` against the migrated schema, because every
 * claim being made is a claim about the production path: the unique index does the
 * serialization, the `CHECK` constraint bounds the completion state, and the `JSON`
 * column decides what a money-bearing response looks like on the way back. None of
 * those exist in a mock.
 *
 * The genuinely concurrent cases are in `concurrency.test.ts`, which needs two
 * separate connections; these are the single-caller behaviours.
 */

const ENDPOINT = 'journals.post';

const REQUEST = { date: '2026-07-01', lines: [{ side: 'debit', amount: 100n }] } as const;

describe('idempotency service', () => {
  const db = useTestDatabase();

  async function scope() {
    const org = await db.factories.org();
    return { org, tenant: new TenantDatabase(db.app, org.id) };
  }

  describe('replay', () => {
    it('returns the original response without running the operation again', async () => {
      const { org, tenant } = await scope();
      const write = accountWriter();
      const key = 'replay-1';

      const first = await runIdempotent(
        tenant,
        key,
        { endpoint: ENDPOINT, request: REQUEST },
        write.operation,
      );
      const second = await runIdempotent(
        tenant,
        key,
        { endpoint: ENDPOINT, request: REQUEST },
        write.operation,
      );

      expect(first.outcome).toBe('executed');
      expect(second.outcome).toBe('replayed');
      // The load-bearing assertion: a counter, not an inference from the effects.
      expect(write.executions()).toBe(1);
      expect(second.body).toEqual(first.body);
      expect(second.status).toBe(first.status);
      // And the effect happened once, which is the same statement A8 makes about
      // journals one layer up.
      expect(await accountCodes(db.app, org.id)).toEqual(['IDEM-1']);
      expect(await claimRows(db.app, org.id)).toHaveLength(1);
    });

    it('replays through the fast path any number of times', async () => {
      const { tenant } = await scope();
      const write = accountWriter();
      const spec = { endpoint: ENDPOINT, request: REQUEST };

      const results = [
        await runIdempotent(tenant, 'replay-many', spec, write.operation),
        await runIdempotent(tenant, 'replay-many', spec, write.operation),
        await runIdempotent(tenant, 'replay-many', spec, write.operation),
      ];

      expect(results.map((result) => result.outcome)).toEqual(['executed', 'replayed', 'replayed']);
      expect(write.executions()).toBe(1);
    });

    it('carries the declared success status through the replay', async () => {
      const { tenant } = await scope();
      const write = accountWriter();
      const spec = { endpoint: ENDPOINT, request: REQUEST, successStatus: 201 };

      const first = await runIdempotent(tenant, 'status-201', spec, write.operation);
      const second = await runIdempotent(tenant, 'status-201', spec, write.operation);

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
    });

    it('replays a body-less response as a null body', async () => {
      const { tenant } = await scope();
      let executions = 0;
      const spec = { endpoint: 'periods.close', request: REQUEST, successStatus: 204 };
      const operation = async () => {
        executions += 1;
        await Promise.resolve();
      };

      const first = await runIdempotent(tenant, 'no-body', spec, operation);
      const second = await runIdempotent(tenant, 'no-body', spec, operation);

      expect(first.body).toBeNull();
      expect(second.body).toBeNull();
      expect(second.status).toBe(204);
      expect(executions).toBe(1);
    });

    it('treats keys differing only in case as the same key, because the index does', async () => {
      // Pinned rather than worked around: the unique index collates
      // `utf8mb4_0900_ai_ci`, so a case-sensitive comparison in application code
      // could not be enforced by the index that actually prevents the double write.
      // The behaviour fails closed — a replay, or a 409 if the body differs too.
      const { tenant } = await scope();
      const write = accountWriter();
      const spec = { endpoint: ENDPOINT, request: REQUEST };

      await runIdempotent(tenant, 'MixedCase-Key', spec, write.operation);
      const second = await runIdempotent(tenant, 'mixedcase-key', spec, write.operation);

      expect(second.outcome).toBe('replayed');
      expect(write.executions()).toBe(1);
    });
  });

  describe('a failed operation leaves nothing behind', () => {
    it('rolls the claim back with the write, so a retry can re-claim', async () => {
      const { org, tenant } = await scope();
      const failure = new Error('period is closed');
      const write = accountWriter((execution) => {
        if (execution === 1) throw failure;
      });
      const spec = { endpoint: ENDPOINT, request: REQUEST };

      await expect(
        runIdempotent(tenant, 'retry-after-failure', spec, write.operation),
      ).rejects.toBe(failure);

      // No poison: the key is free because the claim was never committed.
      expect(await claimRows(db.app, org.id)).toHaveLength(0);

      const retry = await runIdempotent(tenant, 'retry-after-failure', spec, write.operation);

      expect(retry.outcome).toBe('executed');
      expect(write.executions()).toBe(2);
      expect(await claimRows(db.app, org.id)).toHaveLength(1);
    });

    it('rolls back the write the failed attempt had already performed', async () => {
      // The claim and the write share one transaction in both directions: the write
      // cannot survive a rolled-back claim any more than the claim can survive a
      // failed write.
      const { org, tenant } = await scope();
      const write = accountWriter((execution) => {
        if (execution === 1) throw new Error('failed after inserting');
      });

      await expect(
        runIdempotent(tenant, 'partial', { endpoint: ENDPOINT, request: REQUEST }, async (trx) => {
          await trx
            .insertInto('accounts')
            .values({
              id: Buffer.alloc(16, 7),
              code: 'ROLLED-BACK',
              name: 'Should not survive',
              type: 'asset',
              normal_balance: 'debit',
            })
            .execute();
          return write.operation(trx);
        }),
      ).rejects.toThrow('failed after inserting');

      expect(await accountCodes(db.app, org.id)).toEqual([]);
      expect(await claimRows(db.app, org.id)).toHaveLength(0);
    });
  });

  describe('fingerprint mismatch', () => {
    it('is a 409 with the idempotency-specific code, not a generic conflict', async () => {
      const { tenant } = await scope();
      const write = accountWriter();

      await runIdempotent(
        tenant,
        'reused-key',
        { endpoint: ENDPOINT, request: { amount: 100n } },
        write.operation,
      );

      const conflict = runIdempotent(
        tenant,
        'reused-key',
        { endpoint: ENDPOINT, request: { amount: 250n } },
        write.operation,
      );

      await expect(conflict).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
      await expect(conflict).rejects.toMatchObject({
        status: 409,
        code: 'idempotency_key_conflict',
      });
      // The second request must not have executed, and must not have been answered
      // from the first one's cache either — that is the data loss this prevents.
      expect(write.executions()).toBe(1);
    });

    it('rejects the same body replayed against a different endpoint', async () => {
      const { tenant } = await scope();
      const write = accountWriter();

      await runIdempotent(
        tenant,
        'cross-endpoint',
        { endpoint: 'journals.post', request: REQUEST },
        write.operation,
      );

      await expect(
        runIdempotent(
          tenant,
          'cross-endpoint',
          { endpoint: 'journals.reverse', request: REQUEST },
          write.operation,
        ),
      ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
    });

    it('accepts a retry whose body differs only in key order', async () => {
      const { tenant } = await scope();
      const write = accountWriter();

      const first = await runIdempotent(
        tenant,
        'key-order',
        { endpoint: ENDPOINT, request: { date: '2026-07-01', memo: 'rent' } },
        write.operation,
      );
      const second = await runIdempotent(
        tenant,
        'key-order',
        { endpoint: ENDPOINT, request: { memo: 'rent', date: '2026-07-01' } },
        write.operation,
      );

      expect(first.outcome).toBe('executed');
      expect(second.outcome).toBe('replayed');
    });
  });

  describe('org scoping', () => {
    it('makes the same key in two orgs two independent claims', async () => {
      // The unique index is (org_id, idempotency_key) and every statement goes
      // through the tenant wrapper, so one org's key cannot suppress another's
      // write — which would be a cross-org denial of service through a guessed key.
      const first = await scope();
      const second = await scope();
      const write = accountWriter();
      const spec = { endpoint: ENDPOINT, request: REQUEST };

      const a = await runIdempotent(first.tenant, 'shared-key', spec, write.operation);
      const b = await runIdempotent(second.tenant, 'shared-key', spec, write.operation);

      expect(a.outcome).toBe('executed');
      expect(b.outcome).toBe('executed');
      expect(write.executions()).toBe(2);
      expect(await claimRows(db.app, first.org.id)).toHaveLength(1);
      expect(await claimRows(db.app, second.org.id)).toHaveLength(1);
      expect(await accountCodes(db.app, first.org.id)).toEqual(['IDEM-1']);
      expect(await accountCodes(db.app, second.org.id)).toEqual(['IDEM-2']);
    });

    it('never replays one org response to another org', async () => {
      const first = await scope();
      const second = await scope();
      const spec = { endpoint: ENDPOINT, request: REQUEST };

      const a = await runIdempotent(first.tenant, 'no-leak', spec, () =>
        Promise.resolve({ org: 'first' }),
      );
      const b = await runIdempotent(second.tenant, 'no-leak', spec, () =>
        Promise.resolve({ org: 'second' }),
      );

      expect(a.body).toEqual({ org: 'first' });
      expect(b.body).toEqual({ org: 'second' });
    });
  });

  describe('a money-bearing response through the JSON column', () => {
    it('round-trips minor units above 2^53 without precision loss', async () => {
      const { org, tenant } = await scope();
      // One minor unit above Number.MAX_SAFE_INTEGER: the smallest value that proves
      // the column is not holding a double.
      const beyondDouble = 9007199254740993n;
      const spec = { endpoint: 'journals.post', request: REQUEST, successStatus: 201 };
      const operation = () =>
        Promise.resolve({
          journalId: 'a3f1',
          totals: { debit: fromMinorUnits(beyondDouble), credit: fromMinorUnits(beyondDouble) },
          lines: [{ amount: fromMinorUnits(-250n) }, { amount: fromMinorUnits(250n) }],
        });

      const first = await runIdempotent(tenant, 'money-1', spec, operation);
      const replay = await runIdempotent(tenant, 'money-1', spec, operation);

      const expected = {
        journalId: 'a3f1',
        totals: { debit: '9007199254740993', credit: '9007199254740993' },
        lines: [{ amount: '-250' }, { amount: '250' }],
      };
      // Deep equality, not byte equality: MySQL's JSON type normalizes key order on
      // storage, and no JSON consumer is entitled to key order anyway.
      expect(first.body).toEqual(expected);
      expect(replay.body).toEqual(expected);

      const [row] = await claimRows(db.app, org.id);
      const stored = row!.response_body as unknown as { totals: { debit: string } };
      expect(typeof stored.totals.debit).toBe('string');
      expect(BigInt(stored.totals.debit)).toBe(beyondDouble);
    });

    it('does not throw on a bigint the way JSON.stringify would', async () => {
      // Regression guard for the failure this module has to avoid: the stringify
      // happens inside the guarded transaction, so an unconverted amount would roll
      // back a write that had already succeeded.
      const { tenant } = await scope();

      await expect(
        runIdempotent(tenant, 'money-2', { endpoint: ENDPOINT, request: REQUEST }, () =>
          Promise.resolve({ total: fromMinorUnits(1n) }),
        ),
      ).resolves.toMatchObject({ body: { total: '1' } });
    });
  });

  describe('retention and expiry', () => {
    it('claims for the documented retention window', async () => {
      const { org, tenant } = await scope();

      await runIdempotent(
        tenant,
        'retention',
        { endpoint: ENDPOINT, request: REQUEST },
        accountWriter().operation,
      );

      const [row] = await claimRows(db.app, org.id);
      const window = row!.expires_at.getTime() - row!.created_at.getTime();
      // Within a second: `created_at` is a MySQL default and `expires_at` is
      // computed in Node, so the two clocks are not the same clock.
      expect(Math.abs(window - IDEMPOTENCY_RETENTION_MS)).toBeLessThan(1_000);
    });

    it('re-executes an expired key, and says so plainly', async () => {
      // The edge case worth naming: past the window the system has forgotten the
      // request, so the same key with the same body runs a second time and can
      // double-post. That is what a finite window means; the window is chosen to sit
      // beyond every client's retry horizon rather than to make this unreachable.
      const { org, tenant } = await scope();
      const write = accountWriter();
      const spec = { endpoint: ENDPOINT, request: REQUEST };
      const claimedAt = new Date('2026-07-01T00:00:00.000Z');
      const afterExpiry = new Date(claimedAt.getTime() + 60_000);

      const first = await runIdempotent(tenant, 'expired', spec, write.operation, {
        clock: () => claimedAt,
        retentionMs: 1_000,
      });
      const second = await runIdempotent(tenant, 'expired', spec, write.operation, {
        clock: () => afterExpiry,
        retentionMs: 1_000,
      });

      expect(first.outcome).toBe('executed');
      expect(second.outcome).toBe('executed');
      expect(write.executions()).toBe(2);
      // The expired row was replaced, not accumulated: one key, one claim.
      expect(await claimRows(db.app, org.id)).toHaveLength(1);
      expect(await accountCodes(db.app, org.id)).toEqual(['IDEM-1', 'IDEM-2']);
    });

    it('does not 409 an expired key reused with a different body', async () => {
      // Expiry is checked before the fingerprint. A conflict here would be telling
      // the client about a request nobody is entitled to remember.
      const { tenant } = await scope();
      const write = accountWriter();
      const claimedAt = new Date('2026-07-01T00:00:00.000Z');

      await runIdempotent(
        tenant,
        'expired-different-body',
        { endpoint: ENDPOINT, request: { amount: 100n } },
        write.operation,
        { clock: () => claimedAt, retentionMs: 1_000 },
      );

      const reused = await runIdempotent(
        tenant,
        'expired-different-body',
        { endpoint: ENDPOINT, request: { amount: 250n } },
        write.operation,
        { clock: () => new Date(claimedAt.getTime() + 60_000), retentionMs: 1_000 },
      );

      expect(reused.outcome).toBe('executed');
    });

    it('purges expired claims and leaves live ones alone', async () => {
      const { org, tenant } = await scope();
      const spec = { endpoint: ENDPOINT, request: REQUEST };
      const claimedAt = new Date('2026-07-01T00:00:00.000Z');
      const purgeAt = new Date(claimedAt.getTime() + 60_000);
      // One writer for all four, so the account codes it derives from its execution
      // count stay distinct under `uq_accounts_org_code`.
      const write = accountWriter();

      for (const key of ['stale-1', 'stale-2', 'stale-3']) {
        await runIdempotent(tenant, key, spec, write.operation, {
          clock: () => claimedAt,
          retentionMs: 1_000,
        });
      }
      await runIdempotent(tenant, 'live', spec, write.operation, {
        clock: () => claimedAt,
        retentionMs: 600_000,
      });

      // batchSize 1 forces the loop, so the batching is exercised rather than
      // assumed — a purge that stopped after one batch would silently under-collect.
      const purged = await purgeExpiredIdempotencyKeys(tenant, {
        clock: () => purgeAt,
        batchSize: 1,
      });

      expect(purged).toBe(3);
      const remaining = await claimRows(db.app, org.id);
      expect(remaining.map((row) => row.idempotency_key)).toEqual(['live']);
    });

    it('purges only the caller’s org', async () => {
      const first = await scope();
      const second = await scope();
      const spec = { endpoint: ENDPOINT, request: REQUEST };
      const claimedAt = new Date('2026-07-01T00:00:00.000Z');

      for (const target of [first, second]) {
        await runIdempotent(target.tenant, 'stale', spec, accountWriter().operation, {
          clock: () => claimedAt,
          retentionMs: 1_000,
        });
      }

      const purged = await purgeExpiredIdempotencyKeys(first.tenant, {
        clock: () => new Date(claimedAt.getTime() + 60_000),
      });

      expect(purged).toBe(1);
      expect(await claimRows(db.app, second.org.id)).toHaveLength(1);
    });
  });

  describe('unusable keys', () => {
    it.each([
      ['a blank key', '   '],
      ['an empty key', ''],
      ['a key longer than the column', 'k'.repeat(256)],
    ])('rejects %s as a validation failure', async (_label, key) => {
      const { tenant } = await scope();

      // A 400, not MySQL's truncation error surfacing as a 500.
      await expect(
        runIdempotent(
          tenant,
          key,
          { endpoint: ENDPOINT, request: REQUEST },
          accountWriter().operation,
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('accepts a key of exactly the column width', async () => {
      const { tenant } = await scope();

      await expect(
        runIdempotent(
          tenant,
          'k'.repeat(255),
          { endpoint: ENDPOINT, request: REQUEST },
          accountWriter().operation,
        ),
      ).resolves.toMatchObject({ outcome: 'executed' });
    });
  });
});

/**
 * The transport-facing entry point, which resolves the org and the key from request
 * context rather than from parameters (spec §4).
 *
 * Its own `describe` because it needs the process-wide database handle
 * `tenantDb(orgId)` reads — `initializeDatabase` is a once-per-process call, and
 * Vitest gives each file its own process, so this is the only place it happens.
 */
describe('withIdempotency', () => {
  const db = useTestDatabase();

  beforeAll(() => {
    initializeDatabase(db.appConnectionConfig);
  });

  afterAll(async () => {
    await destroyDatabase();
  });

  function inContext<T>(orgUuid: string, key: string | null, fn: () => T): T {
    return runInContext(
      createRequestContext({
        orgId: orgUuid,
        roleId: SYSTEM_ROLE_UUIDS.owner,
        actorType: 'user',
        actorId: '00000000-0000-4000-8000-0000000000aa',
        userId: '00000000-0000-4000-8000-0000000000aa',
        invocationMode: 'interactive',
        idempotencyKey: key,
      }),
      fn,
    );
  }

  it('takes the org and the key from context and replays on the second call', async () => {
    const org = await db.factories.org();
    const write = accountWriter();
    const spec = { endpoint: ENDPOINT, request: REQUEST, successStatus: 201 };

    const first = await inContext(org.uuid, 'ctx-1', () => withIdempotency(spec, write.operation));
    const second = await inContext(org.uuid, 'ctx-1', () => withIdempotency(spec, write.operation));

    expect(first.outcome).toBe('executed');
    expect(second.outcome).toBe('replayed');
    expect(write.executions()).toBe(1);
    // Scoped to the context's org, not to a parameter anyone passed.
    expect(await claimRows(db.app, org.id)).toHaveLength(1);
  });

  it('rejects a write with no Idempotency-Key', async () => {
    // Spec §12 requires the key on every write endpoint;
    // `RouteDefinition.requiresIdempotencyKey` declares it and this enforces it.
    const org = await db.factories.org();
    const write = accountWriter();

    await expect(
      inContext(org.uuid, null, () =>
        withIdempotency({ endpoint: ENDPOINT, request: REQUEST }, write.operation),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(write.executions()).toBe(0);
    expect(await claimRows(db.app, org.id)).toHaveLength(0);
  });

  it('refuses to run outside a request context at all', async () => {
    // A5/§4: the org comes from context or the operation does not happen. There is
    // no parameter to fall back to.
    const write = accountWriter();

    await expect(
      withIdempotency({ endpoint: ENDPOINT, request: REQUEST }, write.operation),
    ).rejects.toThrow(/request context/);
    expect(write.executions()).toBe(0);
  });
});
