import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import { runInContext, type RequestContext } from '../../src/context';
import { bufferToUuid, newUuidBuffer, tenantDb } from '../../src/db';
import {
  InternalError,
  PreconditionFailedError,
  toWireError,
  ValidationError,
} from '../../src/errors';
import { assertPostable, closePeriod } from '../../src/modules/periods';
import { type TestDatabase } from '../db';
import { contextFor, OWNER_ROLE_UUID, usePeriodsDatabase } from './support';

/**
 * `assertPostable` — acceptance criterion **A4: posting to a locked period is
 * rejected**.
 *
 * This is the check OB-020 calls from inside its posting transaction, so the shape of
 * what it returns and the shape of how it fails are both part of that contract, not
 * implementation detail. The last case in this file is about the composition rather
 * than the answer: it asserts that the check enrolls in the caller's ambient
 * transaction rather than opening its own connection, which is the property the whole
 * A9 argument rests on.
 */

/** MySQL's `ER_LOCK_WAIT_TIMEOUT`. */
const LOCK_WAIT_TIMEOUT_ERRNO = 1205;

interface Tenant {
  readonly orgId: Buffer;
  readonly orgUuid: string;
  readonly userUuid: string;
  readonly ctx: RequestContext;
}

async function tenant(db: TestDatabase): Promise<Tenant> {
  const org = await db.factories.org();
  const user = await db.factories.user();
  await db.factories.orgMember({ orgId: org.id, userId: user.id, role: 'owner' });

  return {
    orgId: org.id,
    orgUuid: org.uuid,
    userUuid: user.uuid,
    ctx: contextFor(org.uuid, OWNER_ROLE_UUID, user.uuid),
  };
}

describe('assertPostable', () => {
  const db = usePeriodsDatabase();

  it('resolves a date inside an open period to that period', async () => {
    const scope = await tenant(db);
    const period = await db.factories.fiscalPeriod({
      orgId: scope.orgId,
      name: 'June 2026',
      startDate: '2026-06-01',
      endDate: '2026-06-30',
    });

    const resolved = await runInContext(scope.ctx, () => assertPostable('2026-06-15'));

    expect(resolved).toEqual({
      id: period.uuid,
      name: 'June 2026',
      startDate: '2026-06-01',
      endDate: '2026-06-30',
    });
  });

  it('treats both boundary days as inside the period', async () => {
    const scope = await tenant(db);
    await db.factories.fiscalPeriod({
      orgId: scope.orgId,
      startDate: '2026-06-01',
      endDate: '2026-06-30',
    });

    // `end_date` is inclusive, so the last day of the month is postable and the first
    // day of the next is not.
    expect((await runInContext(scope.ctx, () => assertPostable('2026-06-01'))).startDate).toBe(
      '2026-06-01',
    );
    expect((await runInContext(scope.ctx, () => assertPostable('2026-06-30'))).endDate).toBe(
      '2026-06-30',
    );
    await expect(
      runInContext(scope.ctx, () => assertPostable('2026-07-01')),
    ).rejects.toBeInstanceOf(PreconditionFailedError);
    await expect(
      runInContext(scope.ctx, () => assertPostable('2026-05-31')),
    ).rejects.toBeInstanceOf(PreconditionFailedError);
  });

  it('rejects a date in a closed period', async () => {
    const scope = await tenant(db);
    const period = await db.factories.fiscalPeriod({
      orgId: scope.orgId,
      startDate: '2026-06-01',
      endDate: '2026-06-30',
    });
    await runInContext(scope.ctx, () => closePeriod({ periodId: period.uuid }));

    const error = await runInContext(scope.ctx, () =>
      assertPostable('2026-06-15').then(
        () => undefined,
        (thrown: unknown) => thrown,
      ),
    );

    expect(error).toBeInstanceOf(PreconditionFailedError);
    const wire = toWireError(error);
    // 412 with a stable token, so an integrator can branch on *which* precondition
    // failed without parsing prose (`src/errors/codes.ts`).
    expect(wire.status).toBe(412);
    expect(wire.code).toBe('precondition_failed');
    expect(wire.details).toEqual({ precondition: 'period_closed' });
  });

  it('rejects a date no period covers, and does not create one', async () => {
    const scope = await tenant(db);
    await db.factories.fiscalPeriod({
      orgId: scope.orgId,
      startDate: '2026-06-01',
      endDate: '2026-06-30',
    });

    const error = await runInContext(scope.ctx, () =>
      assertPostable('2027-03-04').then(
        () => undefined,
        (thrown: unknown) => thrown,
      ),
    );

    expect(error).toBeInstanceOf(PreconditionFailedError);
    expect(toWireError(error).details).toEqual({ precondition: 'period_missing' });

    // ROADMAP D-17: generation is explicit, never implicit on first post. Nothing was
    // created by the failed check.
    const rows = await db.app
      .selectFrom('fiscal_periods')
      .select('id')
      .where('org_id', '=', scope.orgId)
      .execute();
    expect(rows).toHaveLength(1);
  });

  it('rejects every date when the org has no periods at all', async () => {
    const scope = await tenant(db);

    await expect(
      runInContext(scope.ctx, () => assertPostable('2026-06-15')),
    ).rejects.toBeInstanceOf(PreconditionFailedError);
  });

  it('does not resolve a date against another org`s period', async () => {
    const scope = await tenant(db);
    const other = await tenant(db);
    await db.factories.fiscalPeriod({
      orgId: other.orgId,
      startDate: '2026-06-01',
      endDate: '2026-06-30',
    });

    // The row never arrives, because `tenantDb` filtered it out — so this is the same
    // answer as an org with no periods, which is what A7 requires.
    const error = await runInContext(scope.ctx, () =>
      assertPostable('2026-06-15').then(
        () => undefined,
        (thrown: unknown) => thrown,
      ),
    );
    expect(toWireError(error).details).toEqual({ precondition: 'period_missing' });
  });

  it('rejects an impossible calendar date rather than passing it to the driver', async () => {
    const scope = await tenant(db);

    // `z.iso.date()` refuses these; a regex would accept all three and leave MySQL to
    // coerce or reject them.
    for (const date of ['2026-02-30', '2026-04-31', '2026-13-01', '2026-6-1', 'yesterday']) {
      await expect(runInContext(scope.ctx, () => assertPostable(date))).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
    // A leap day in a leap year is a real date and must not be refused.
    await expect(
      runInContext(scope.ctx, () => assertPostable('2024-02-29')),
    ).rejects.toBeInstanceOf(PreconditionFailedError);
  });

  /**
   * Non-overlap is a service invariant with no schema backing, so the service has to
   * cope with a table that already violates it — from an import, a manual write, or a
   * bug. Choosing one of the two silently would post into whichever period sorted
   * first, and the choice would be invisible in the resulting books.
   */
  it('fails loudly rather than choosing when two periods cover the same date', async () => {
    const scope = await tenant(db);
    await db.factories.fiscalPeriod({
      orgId: scope.orgId,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    });
    await db.factories.fiscalPeriod({
      orgId: scope.orgId,
      startDate: '2026-06-01',
      endDate: '2026-06-30',
    });

    const error = await runInContext(scope.ctx, () =>
      assertPostable('2026-06-15').then(
        () => undefined,
        (thrown: unknown) => thrown,
      ),
    );

    expect(error).toBeInstanceOf(InternalError);
    // The detail naming both periods goes to the log and never to the client:
    // `toWireError` strips `details` from an `internal_error`.
    expect(toWireError(error).details).toBeUndefined();
  });

  /**
   * The lock is real, asserted from a second connection.
   *
   * Everything the A9 argument in `assertPostable`'s commentary claims rests on the
   * default read being `SELECT … FOR UPDATE`. Without a test, `withLock` could stop
   * applying `.forUpdate()` — a one-line regression — and every other case in this
   * file would still pass, because none of them contend. So this one holds the lock in
   * an open transaction and asserts that a concurrent close *blocks* on it rather than
   * committing underneath the check.
   *
   * `innodb_lock_wait_timeout` is set to one second on the contending session, so the
   * proof of blocking is a lock-wait timeout (errno 1205) rather than a fifty-second
   * pause. The second connection is genuinely separate (`openAppConnection`), because
   * two statements on one pool may land on the same physical connection and serialize
   * instead of contending.
   */
  it('holds a row lock that blocks a concurrent close', async () => {
    const scope = await tenant(db);
    const period = await db.factories.fiscalPeriod({
      orgId: scope.orgId,
      startDate: '2026-06-01',
      endDate: '2026-06-30',
    });

    const contender = await db.openAppConnection();
    try {
      await sql`SET SESSION innodb_lock_wait_timeout = 1`.execute(contender.db);

      await runInContext(scope.ctx, () =>
        tenantDb(scope.orgId).transaction(async () => {
          await assertPostable('2026-06-15');

          await expect(
            sql`
              UPDATE fiscal_periods
              SET status = 'closed', closed_at = NOW(3)
              WHERE id = ${period.id}
            `.execute(contender.db),
          ).rejects.toMatchObject({ errno: LOCK_WAIT_TIMEOUT_ERRNO });
        }),
      );

      // The same statement succeeds once the posting transaction has ended, so the
      // failure above was contention and not a missing privilege.
      await sql`
        UPDATE fiscal_periods SET status = 'closed', closed_at = NOW(3) WHERE id = ${period.id}
      `.execute(contender.db);
    } finally {
      await contender.close();
    }
  });

  it('answers a read-only probe without taking a row lock', async () => {
    const scope = await tenant(db);
    await db.factories.fiscalPeriod({
      orgId: scope.orgId,
      startDate: '2026-06-01',
      endDate: '2026-06-30',
    });

    const resolved = await runInContext(scope.ctx, () =>
      assertPostable('2026-06-15', { lock: false }),
    );
    expect(resolved.startDate).toBe('2026-06-01');
  });

  /**
   * The composition OB-020 depends on, asserted rather than assumed.
   *
   * `assertPostable` takes no database handle. If it opened its own connection, the
   * period inserted inside the transaction below would be invisible to it and this
   * test would fail with `period_missing`. It resolves, so it is reading on the
   * transaction's own connection — which is what makes the period check and the
   * journal insert one atomic unit, and therefore what makes A9 achievable.
   *
   * The rollback at the end is the control: the row really was uncommitted, so the
   * visibility cannot be explained by the row having been committed first.
   */
  it('joins the caller`s ambient transaction rather than opening its own', async () => {
    const scope = await tenant(db);
    const periodId = newUuidBuffer();

    class Rollback extends Error {}

    await expect(
      runInContext(scope.ctx, () =>
        tenantDb(scope.orgId).transaction(async (trx) => {
          await trx
            .insertInto('fiscal_periods')
            .values({
              id: periodId,
              name: 'August 2030',
              start_date: '2030-08-01',
              end_date: '2030-08-31',
            })
            .execute();

          const resolved = await assertPostable('2030-08-15');
          expect(resolved.id).toBe(bufferToUuid(periodId));

          throw new Rollback();
        }),
      ),
    ).rejects.toBeInstanceOf(Rollback);

    const rows = await db.app
      .selectFrom('fiscal_periods')
      .select('id')
      .where('id', '=', periodId)
      .execute();
    expect(rows).toHaveLength(0);
  });
});
