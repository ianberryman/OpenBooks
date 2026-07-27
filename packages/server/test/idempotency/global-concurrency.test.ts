import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';

import { TenantDatabase } from '../../src/db';
import type { DB } from '../../src/db/generated';
import { IdempotencyKeyConflictError } from '../../src/errors';
import { runGlobalIdempotent, runIdempotent } from '../../src/modules/idempotency';
import { useTestDatabase } from '../db/harness';
import {
  accountWriter,
  deferred,
  delay,
  globalClaimRows,
  globalOrgWriter,
  orgSlugs,
} from './support';

/**
 * Org-less claims under real contention (OB-028; M1 known gap 1; spec §12).
 *
 * `concurrency.test.ts` proves the org namespace serializes on
 * `uq_idempotency_scope_key`. Nothing about that transfers for free: the org path
 * reaches the row through `TenantDatabase` and the global path does not, the
 * predicate is `claim_scope = <sentinel>` rather than an injected `org_id`, and the
 * `INSERT` writes an explicit NULL that a stored generated column turns into the
 * scope. Any of those could be wrong while every org test still passed — the
 * migration's own commentary names the specific way it goes wrong, which is MySQL
 * treating NULLs as distinct in a unique index and permitting unlimited duplicate
 * global claims.
 *
 * So the same standard applies here, and for the same reason (CLAUDE.md, "prove
 * contention"): two genuinely separate connections, one transaction parked
 * mid-flight, and an assertion that the other **has not settled**. A sequential
 * simulation of this race passes against an implementation with no serialization at
 * all, which is precisely the implementation a nullable `org_id` would have produced.
 */

const ENDPOINT = 'createOrg';
const REQUEST = { name: 'Contended Books', fiscalYearStartMonth: 1 };
const SPEC = { endpoint: ENDPOINT, request: REQUEST, successStatus: 201 };

/** The caller both requests are made by. `null` is register/login's pre-auth case. */
const PRINCIPAL = '00000000-0000-4000-8000-0000000000aa';

/** Long enough for a blocked INSERT to have definitely reached the index. */
const CONTENTION_WAIT_MS = 750;

async function connectionId(db: Kysely<DB>): Promise<string> {
  const { rows } = await sql<{ id: bigint }>`SELECT CONNECTION_ID() AS id`.execute(db);
  return String(rows[0]!.id);
}

/** Tracks settlement without consuming the promise, so it can still be awaited. */
function watch<T>(promise: Promise<T>): { readonly settled: () => boolean } {
  let settled = false;
  const mark = (): void => {
    settled = true;
  };
  void promise.then(mark, mark);
  return { settled: () => settled };
}

describe('two concurrent org-less requests with the same idempotency key', () => {
  const db = useTestDatabase();

  it('execute exactly once, and the loser observes the committed outcome', async () => {
    const first = await db.openAppConnection();
    const second = await db.openAppConnection();

    try {
      expect(await connectionId(first.db)).not.toBe(await connectionId(second.db));

      const entered = deferred();
      const release = deferred();
      const write = globalOrgWriter(async (execution) => {
        if (execution === 1) {
          entered.resolve();
          await release.promise;
        }
      });

      const winner = runGlobalIdempotent(
        first.db,
        PRINCIPAL,
        'raced-global-key',
        SPEC,
        write.operation,
      );
      // The winner now holds an uncommitted claim row and is parked inside its
      // transaction.
      await entered.promise;

      const loser = runGlobalIdempotent(
        second.db,
        PRINCIPAL,
        'raced-global-key',
        SPEC,
        write.operation,
      );
      const loserState = watch(loser);
      await delay(CONTENTION_WAIT_MS);

      // The proof of a real race: the loser's INSERT is blocked on the winner's
      // index lock and cannot resolve either way until the winner commits. With
      // `org_id` NULL and no `claim_scope`, MySQL would let both inserts through and
      // this assertion is the one that fails.
      expect(loserState.settled()).toBe(false);
      expect(write.executions()).toBe(1);

      release.resolve();
      const [winnerResult, loserResult] = await Promise.all([winner, loser]);

      expect(winnerResult.outcome).toBe('executed');
      expect(loserResult.outcome).toBe('replayed');
      expect(write.executions()).toBe(1);
      // One claim, one org. B8, stated as rows: "a retried create-org yields exactly
      // one of the thing".
      expect(await globalClaimRows(db.app)).toHaveLength(1);
      expect(await orgSlugs(db.app)).toEqual(['idem-global-1']);
      expect(loserResult.body).toEqual(winnerResult.body);
      expect(loserResult.status).toBe(winnerResult.status);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('lets the loser execute when the winner rolls back, rather than poisoning the key', async () => {
    const first = await db.openAppConnection();
    const second = await db.openAppConnection();

    try {
      const entered = deferred();
      const release = deferred();
      const failure = new Error('registration failed');
      const write = globalOrgWriter(async (execution) => {
        if (execution === 1) {
          entered.resolve();
          await release.promise;
          throw failure;
        }
      });

      const doomed = runGlobalIdempotent(
        first.db,
        PRINCIPAL,
        'released-global-key',
        SPEC,
        write.operation,
      );
      await entered.promise;

      const waiting = runGlobalIdempotent(
        second.db,
        PRINCIPAL,
        'released-global-key',
        SPEC,
        write.operation,
      );
      const waitingState = watch(waiting);
      await delay(CONTENTION_WAIT_MS);

      expect(waitingState.settled()).toBe(false);

      release.resolve();
      await expect(doomed).rejects.toBe(failure);

      const result = await waiting;

      expect(result.outcome).toBe('executed');
      expect(write.executions()).toBe(2);
      // The failed attempt left nothing — which for register is the difference
      // between a retry that works and an email address claimed by an account
      // nobody can use.
      expect(await globalClaimRows(db.app)).toHaveLength(1);
      expect(await orgSlugs(db.app)).toEqual(['idem-global-2']);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('does not serialize org-less writes that carry different keys', async () => {
    // The complement, and a guard against "fixing" the race by locking more: the
    // global namespace is shared by every caller, so a lock any coarser than
    // (claim_scope, idempotency_key) would make every login in the system queue
    // behind every other one.
    const first = await db.openAppConnection();
    const second = await db.openAppConnection();

    try {
      const bothInside = deferred();
      const release = deferred();
      let inside = 0;
      const write = globalOrgWriter(async () => {
        inside += 1;
        if (inside === 2) bothInside.resolve();
        await release.promise;
      });

      const a = runGlobalIdempotent(first.db, PRINCIPAL, 'global-a', SPEC, write.operation);
      const b = runGlobalIdempotent(second.db, PRINCIPAL, 'global-b', SPEC, write.operation);

      // Both operation bodies are inside their transactions at the same time. With a
      // coarser lock this never resolves and the test times out.
      await bothInside.promise;
      release.resolve();

      const results = await Promise.all([a, b]);

      expect(results.map((result) => result.outcome)).toEqual(['executed', 'executed']);
      expect(write.executions()).toBe(2);
      expect(await globalClaimRows(db.app)).toHaveLength(2);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('keeps an org claim and a global claim on the same key from contending', async () => {
    // The two namespaces are separate by construction — `claim_scope` is the org id
    // for one and the all-zero sentinel for the other — and this is what says so
    // under contention. If they shared, a tenant could stall every registration in
    // the system with a guessed key, and vice versa.
    const org = await db.factories.org();
    const first = await db.openAppConnection();
    const second = await db.openAppConnection();

    try {
      const bothInside = deferred();
      const release = deferred();
      let inside = 0;
      const globalWrite = globalOrgWriter(async () => {
        inside += 1;
        if (inside === 2) bothInside.resolve();
        await release.promise;
      });
      const orgWrite = accountWriterFor(async () => {
        inside += 1;
        if (inside === 2) bothInside.resolve();
        await release.promise;
      });

      const globalCall = runGlobalIdempotent(
        first.db,
        PRINCIPAL,
        'shared-key',
        SPEC,
        globalWrite.operation,
      );
      const orgCall = orgWrite.run(second.db, org.id, 'shared-key');

      await bothInside.promise;
      release.resolve();

      const results = await Promise.all([globalCall, orgCall]);

      expect(results.map((result) => result.outcome)).toEqual(['executed', 'executed']);
      expect(await globalClaimRows(db.app)).toHaveLength(1);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('409s a global key reused with a different request, rather than replaying', async () => {
    // The fingerprint rule, in the namespace where getting it wrong is worst: a
    // shared namespace means the "different request" can belong to somebody else.
    const connection = await db.openAppConnection();

    try {
      const write = globalOrgWriter();

      const first = await runGlobalIdempotent(
        connection.db,
        PRINCIPAL,
        'fingerprint-key',
        SPEC,
        write.operation,
      );

      await expect(
        runGlobalIdempotent(
          connection.db,
          PRINCIPAL,
          'fingerprint-key',
          { ...SPEC, request: { name: 'A Different Org', fiscalYearStartMonth: 1 } },
          write.operation,
        ),
      ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);

      expect(first.outcome).toBe('executed');
      expect(write.executions()).toBe(1);
      expect(await orgSlugs(db.app)).toEqual(['idem-global-1']);
    } finally {
      await connection.close();
    }
  });

  it('refuses one caller’s key to another caller, instead of replaying their response', async () => {
    // The reason `globalRequestFingerprint` folds the principal in. Two callers that
    // picked the same key are not one another's retries, and without this the second
    // `createOrg` would be answered with the first's org — an org id and slug they
    // are not a member of, and their own org never created.
    const connection = await db.openAppConnection();
    const otherPrincipal = '00000000-0000-4000-8000-0000000000bb';

    try {
      const write = globalOrgWriter();

      await runGlobalIdempotent(connection.db, PRINCIPAL, 'collided', SPEC, write.operation);

      await expect(
        runGlobalIdempotent(connection.db, otherPrincipal, 'collided', SPEC, write.operation),
      ).rejects.toBeInstanceOf(IdempotencyKeyConflictError);

      expect(write.executions()).toBe(1);
      expect(await orgSlugs(db.app)).toEqual(['idem-global-1']);
    } finally {
      await connection.close();
    }
  });
});

/**
 * An org-scoped guarded write, packaged so the cross-namespace test can start one
 * beside a global one. Local rather than in `support.ts` because it is the only place
 * that needs both halves at once.
 */
function accountWriterFor(hook: () => Promise<void>) {
  const write = accountWriter(hook);
  return {
    run: (executor: Kysely<DB>, orgId: Buffer, key: string) =>
      runIdempotent(
        new TenantDatabase(executor, orgId),
        key,
        { endpoint: 'createAccount', request: { code: 'X' } },
        write.operation,
      ),
  };
}
