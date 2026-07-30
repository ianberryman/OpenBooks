import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import { runInContext, type RequestContext } from '../../src/context';
import {
  ConflictError,
  NotFoundError,
  PermissionDeniedError,
  toWireError,
  ValidationError,
} from '../../src/errors';
import {
  closePeriod,
  createPeriod,
  generateFiscalYear,
  getPeriod,
  listPeriods,
  reopenPeriod,
} from '../../src/modules/periods';
import { newUuid, type TestDatabase } from '../db';
import { contextFor, customRole, OWNER_ROLE_UUID, usePeriodsDatabase } from './support';

/**
 * The fiscal periods service (OB-019; ROADMAP D-08, D-17).
 *
 * Against the real container, as the app user, through the real service — so the
 * non-overlap enforcement, the CHECK constraint, and the permission gates are the
 * production ones and not a second implementation written for the test.
 */

/** MySQL's `ER_CHECK_CONSTRAINT_VIOLATED`. */
const CHECK_CONSTRAINT_ERRNO = 3819;

interface Tenant {
  readonly orgId: Buffer;
  readonly orgUuid: string;
  readonly userUuid: string;
  readonly ctx: RequestContext;
}

/**
 * An org, an Owner member, and a fiscal-year start month.
 *
 * The start month is written here rather than through the factory because
 * `test/db/factories.ts` belongs to OB-014 and takes no such override; `orgs` is in
 * `0999_app_grants`'s mutable allowlist, so the app user may set it.
 */
async function tenantWithFiscalYearStart(db: TestDatabase, startMonth: number): Promise<Tenant> {
  const org = await db.factories.org();
  const user = await db.factories.user();
  await db.factories.orgMember({ orgId: org.id, userId: user.id, role: 'owner' });

  await db.app
    .updateTable('orgs')
    .set({ fiscal_year_start_month: startMonth })
    .where('id', '=', org.id)
    .execute();

  return {
    orgId: org.id,
    orgUuid: org.uuid,
    userUuid: user.uuid,
    ctx: contextFor(org.uuid, OWNER_ROLE_UUID, user.uuid),
  };
}

describe('generateFiscalYear', () => {
  const db = usePeriodsDatabase();

  it('creates twelve contiguous monthly periods for a non-January fiscal year', async () => {
    const tenant = await tenantWithFiscalYearStart(db, 4);

    const generated = await runInContext(tenant.ctx, () =>
      generateFiscalYear({ fiscalYear: 2026 }),
    );

    expect(generated.startMonth).toBe(4);
    expect(generated.startDate).toBe('2026-04-01');
    expect(generated.endDate).toBe('2027-03-31');
    expect(generated.periods).toHaveLength(12);
    expect(generated.periods.map((period) => period.name)).toEqual([
      'April 2026',
      'May 2026',
      'June 2026',
      'July 2026',
      'August 2026',
      'September 2026',
      'October 2026',
      'November 2026',
      'December 2026',
      'January 2027',
      'February 2027',
      'March 2027',
    ]);
    expect(generated.periods.every((period) => period.status === 'open')).toBe(true);
    expect(generated.periods.every((period) => period.closedAt === null)).toBe(true);

    // Read back through the app connection, so the assertion is about rows and not
    // about the value the service happened to return.
    const rows = await db.app
      .selectFrom('fiscal_periods')
      .select(['name', 'start_date', 'end_date', 'status', 'closed_at'])
      .where('org_id', '=', tenant.orgId)
      .orderBy('start_date')
      .execute();

    expect(rows).toHaveLength(12);
    expect(rows[0]?.start_date).toBe('2026-04-01');
    expect(rows[11]?.end_date).toBe('2027-03-31');
    // Calendar dates come back as strings, never as `Date`s — the property
    // `src/db/migrations/README.md` overrides the generated mapping to get.
    expect(typeof rows[0]?.start_date).toBe('string');

    for (const [index, row] of rows.entries()) {
      const next = rows[index + 1];
      if (next === undefined) continue;
      expect(row.end_date < next.start_date).toBe(true);
    }
  });

  it('honours a January start month and a leap February', async () => {
    const tenant = await tenantWithFiscalYearStart(db, 1);

    const generated = await runInContext(tenant.ctx, () =>
      generateFiscalYear({ fiscalYear: 2024 }),
    );

    expect(generated.startDate).toBe('2024-01-01');
    expect(generated.endDate).toBe('2024-12-31');
    expect(generated.periods[1]?.endDate).toBe('2024-02-29');
  });

  it('generates the following fiscal year without conflict', async () => {
    const tenant = await tenantWithFiscalYearStart(db, 7);

    await runInContext(tenant.ctx, () => generateFiscalYear({ fiscalYear: 2026 }));
    const second = await runInContext(tenant.ctx, () => generateFiscalYear({ fiscalYear: 2027 }));

    expect(second.startDate).toBe('2027-07-01');
    expect(await runInContext(tenant.ctx, () => listPeriods())).toHaveLength(24);
  });

  it('rejects generating the same fiscal year twice', async () => {
    const tenant = await tenantWithFiscalYearStart(db, 4);

    await runInContext(tenant.ctx, () => generateFiscalYear({ fiscalYear: 2026 }));

    await expect(
      runInContext(tenant.ctx, () => generateFiscalYear({ fiscalYear: 2026 })),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(await runInContext(tenant.ctx, () => listPeriods())).toHaveLength(12);
  });

  it('rejects a fiscal year outside the range MySQL can store', async () => {
    const tenant = await tenantWithFiscalYearStart(db, 1);

    await expect(
      runInContext(tenant.ctx, () => generateFiscalYear({ fiscalYear: 9999 })),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      runInContext(tenant.ctx, () => generateFiscalYear({ fiscalYear: 2026.5 })),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('requires periods.write', async () => {
    const tenant = await tenantWithFiscalYearStart(db, 1);
    const roleUuid = await customRole(tenant.orgUuid, ['periods.read']);
    const ctx = contextFor(tenant.orgUuid, roleUuid, tenant.userUuid);

    const error = await runInContext(ctx, () =>
      generateFiscalYear({ fiscalYear: 2026 }).then(
        () => undefined,
        (thrown: unknown) => thrown,
      ),
    );

    expect(error).toBeInstanceOf(PermissionDeniedError);
    expect((error as PermissionDeniedError).details).toEqual({ permission: 'periods.write' });
  });
});

/**
 * Non-overlap is enforced here and nowhere in the schema: `0002_ledger` says the
 * unique key on `(org_id, start_date)` "catches the most common duplicate but does
 * not catch a genuine overlap". Both of the cases a naive start-date check misses are
 * exercised against the database.
 */
describe('non-overlap', () => {
  const db = usePeriodsDatabase();

  it('rejects a month wholly contained by an existing period', async () => {
    const tenant = await tenantWithFiscalYearStart(db, 1);
    // The factory's default range is the whole of 2026, which contains June 2026 and
    // whose own start date lies outside it — invisible to a start-date-only check.
    await db.factories.fiscalPeriod({
      orgId: tenant.orgId,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    });

    const error = await runInContext(tenant.ctx, () =>
      createPeriod({ year: 2026, month: 6 }).then(
        () => undefined,
        (thrown: unknown) => thrown,
      ),
    );

    expect(error).toBeInstanceOf(ConflictError);
    expect(toWireError(error).status).toBe(409);
    expect(await countPeriods(db, tenant)).toBe(1);
  });

  it('rejects an existing period that straddles the start of the requested range', async () => {
    const tenant = await tenantWithFiscalYearStart(db, 1);
    // Starts before 2027 and ends inside it, so its start date is outside the
    // requested range: the second case a start-date check misses.
    await db.factories.fiscalPeriod({
      orgId: tenant.orgId,
      startDate: '2026-12-15',
      endDate: '2027-01-15',
    });

    await expect(
      runInContext(tenant.ctx, () => generateFiscalYear({ fiscalYear: 2027 })),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(await countPeriods(db, tenant)).toBe(1);
  });

  it('rejects an existing period that straddles the end of the requested range', async () => {
    const tenant = await tenantWithFiscalYearStart(db, 1);
    await db.factories.fiscalPeriod({
      orgId: tenant.orgId,
      startDate: '2027-12-20',
      endDate: '2028-01-10',
    });

    await expect(
      runInContext(tenant.ctx, () => generateFiscalYear({ fiscalYear: 2027 })),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(await countPeriods(db, tenant)).toBe(1);
  });

  it('names the offending period, which is safe because it is in the caller`s own org', async () => {
    const tenant = await tenantWithFiscalYearStart(db, 1);
    const existing = await db.factories.fiscalPeriod({
      orgId: tenant.orgId,
      name: 'Legacy 2026',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    });

    const error = await runInContext(tenant.ctx, () =>
      createPeriod({ year: 2026, month: 6 }).then(
        () => undefined,
        (thrown: unknown) => thrown,
      ),
    );

    expect(toWireError(error).details).toMatchObject({
      periods: [{ id: existing.uuid, name: 'Legacy 2026' }],
    });
  });

  it('allows a period that merely abuts an existing one', async () => {
    const tenant = await tenantWithFiscalYearStart(db, 4);
    await db.factories.fiscalPeriod({
      orgId: tenant.orgId,
      startDate: '2026-01-01',
      endDate: '2026-03-31',
    });

    const generated = await runInContext(tenant.ctx, () =>
      generateFiscalYear({ fiscalYear: 2026 }),
    );

    expect(generated.startDate).toBe('2026-04-01');
    expect(await countPeriods(db, tenant)).toBe(13);
  });

  it('leaves no periods behind when a twelve-month generation is rejected', async () => {
    const tenant = await tenantWithFiscalYearStart(db, 1);
    await db.factories.fiscalPeriod({
      orgId: tenant.orgId,
      startDate: '2026-06-01',
      endDate: '2026-06-30',
    });

    await expect(
      runInContext(tenant.ctx, () => generateFiscalYear({ fiscalYear: 2026 })),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(await countPeriods(db, tenant)).toBe(1);
  });

  it('does not see another org`s periods as an overlap', async () => {
    const tenant = await tenantWithFiscalYearStart(db, 1);
    const other = await tenantWithFiscalYearStart(db, 1);
    await runInContext(other.ctx, () => generateFiscalYear({ fiscalYear: 2026 }));

    const generated = await runInContext(tenant.ctx, () =>
      generateFiscalYear({ fiscalYear: 2026 }),
    );

    expect(generated.periods).toHaveLength(12);
  });
});

describe('close and reopen', () => {
  const db = usePeriodsDatabase();

  it('records the actor and the timestamp on close, and clears both on reopen', async () => {
    const tenant = await tenantWithFiscalYearStart(db, 1);
    const period = await db.factories.fiscalPeriod({ orgId: tenant.orgId });

    const before = Date.now();
    const closed = await runInContext(tenant.ctx, () => closePeriod({ periodId: period.uuid }));
    const after = Date.now();

    expect(closed.status).toBe('closed');
    expect(closed.closedByUserId).toBe(tenant.userUuid);
    expect(closed.closedAt).not.toBeNull();
    // The window is exact rather than generous on purpose. `closed_at` is generated in
    // Node and round-trips through a `DATETIME(3)` with the connection pinned to
    // `timezone: 'Z'` (`src/db/connection.ts`), so a stored timestamp that lands hours
    // out is a timezone misconfiguration and not clock skew. A loose window would hide
    // exactly that.
    const closedAtMs = Date.parse(closed.closedAt ?? '');
    expect(closedAtMs).toBeGreaterThanOrEqual(before);
    expect(closedAtMs).toBeLessThanOrEqual(after);

    const storedClosed = await readPeriodRow(db, period.id);
    expect(storedClosed.status).toBe('closed');
    expect(storedClosed.closed_at).toBeInstanceOf(Date);
    expect(storedClosed.closed_by_user_id).not.toBeNull();

    const reopened = await runInContext(tenant.ctx, () => reopenPeriod({ periodId: period.uuid }));

    expect(reopened.status).toBe('open');
    expect(reopened.closedAt).toBeNull();
    // Cleared, not left dangling: a row saying "closed by X" while open reads as a
    // record of a close rather than of one that was undone.
    expect(reopened.closedByUserId).toBeNull();

    const storedOpen = await readPeriodRow(db, period.id);
    expect(storedOpen.status).toBe('open');
    expect(storedOpen.closed_at).toBeNull();
    expect(storedOpen.closed_by_user_id).toBeNull();
  });

  it('refuses to close an already-closed period, and to reopen an open one', async () => {
    const tenant = await tenantWithFiscalYearStart(db, 1);
    const open = await db.factories.fiscalPeriod({ orgId: tenant.orgId });
    const closed = await db.factories.fiscalPeriod({
      orgId: tenant.orgId,
      startDate: '2027-01-01',
      endDate: '2027-12-31',
      status: 'closed',
    });

    await expect(
      runInContext(tenant.ctx, () => reopenPeriod({ periodId: open.uuid })),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      runInContext(tenant.ctx, () => closePeriod({ periodId: closed.uuid })),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  /**
   * The service is the only writer of `status`, and it writes `status` and
   * `closed_at` as one value (`PeriodClosure`), so no sequence of service calls can
   * reach a state `chk_fiscal_periods_closed_consistency` forbids. The second half of
   * the test is what makes that a defence in depth rather than the only defence: the
   * constraint still refuses the inconsistent row when it is written by hand, as the
   * app user.
   */
  it('cannot reach a status / closed_at combination the CHECK forbids', async () => {
    const tenant = await tenantWithFiscalYearStart(db, 1);
    const period = await db.factories.fiscalPeriod({ orgId: tenant.orgId });

    await runInContext(tenant.ctx, () => closePeriod({ periodId: period.uuid }));
    await runInContext(tenant.ctx, () => reopenPeriod({ periodId: period.uuid }));
    await runInContext(tenant.ctx, () => closePeriod({ periodId: period.uuid }));

    const row = await readPeriodRow(db, period.id);
    expect(row.status).toBe('closed');
    expect(row.closed_at).not.toBeNull();

    // 'closed' with no timestamp.
    await expect(
      sql`UPDATE fiscal_periods SET status = 'closed', closed_at = NULL WHERE id = ${period.id}`.execute(
        db.app,
      ),
    ).rejects.toMatchObject({ errno: CHECK_CONSTRAINT_ERRNO });

    // 'open' with one.
    await expect(
      sql`UPDATE fiscal_periods SET status = 'open' WHERE id = ${period.id}`.execute(db.app),
    ).rejects.toMatchObject({ errno: CHECK_CONSTRAINT_ERRNO });

    expect((await readPeriodRow(db, period.id)).status).toBe('closed');
  });

  /**
   * The distinction `periods.close` and `periods.reopen` exist to express. It needs a
   * custom role: the six seeded roles grant both codes or neither, so with system
   * roles alone the two permissions are indistinguishable in practice.
   */
  it('gates close and reopen as separate permissions', async () => {
    const tenant = await tenantWithFiscalYearStart(db, 1);

    const closerOnly = contextFor(
      tenant.orgUuid,
      await customRole(tenant.orgUuid, ['periods.read', 'periods.close']),
      tenant.userUuid,
    );
    const reopenerOnly = contextFor(
      tenant.orgUuid,
      await customRole(tenant.orgUuid, ['periods.read', 'periods.reopen']),
      tenant.userUuid,
    );

    const period = await db.factories.fiscalPeriod({ orgId: tenant.orgId });

    // May close, may not reopen.
    const closed = await runInContext(closerOnly, () => closePeriod({ periodId: period.uuid }));
    expect(closed.status).toBe('closed');

    const reopenDenied = await runInContext(closerOnly, () =>
      reopenPeriod({ periodId: period.uuid }).then(
        () => undefined,
        (thrown: unknown) => thrown,
      ),
    );
    expect(reopenDenied).toBeInstanceOf(PermissionDeniedError);
    expect((reopenDenied as PermissionDeniedError).details).toEqual({
      permission: 'periods.reopen',
    });

    // The mirror image: may reopen, may not close.
    const reopened = await runInContext(reopenerOnly, () =>
      reopenPeriod({ periodId: period.uuid }),
    );
    expect(reopened.status).toBe('open');

    const closeDenied = await runInContext(reopenerOnly, () =>
      closePeriod({ periodId: period.uuid }).then(
        () => undefined,
        (thrown: unknown) => thrown,
      ),
    );
    expect(closeDenied).toBeInstanceOf(PermissionDeniedError);
    expect((closeDenied as PermissionDeniedError).details).toEqual({ permission: 'periods.close' });

    // Neither denial changed the row.
    expect((await readPeriodRow(db, period.id)).status).toBe('open');
  });

  /**
   * OB-193 (ROADMAP D-97) frames a close as a human sign-off, but it does not
   * withdraw M1's capability: an automation or API-key session that legitimately
   * holds `periods.close` (it authenticates as an org and a role but never a user —
   * `api-key-identity.ts`) may still transition a period. That records a *null*
   * closer, exactly as `fiscal_periods.closed_by_user_id` and `period_close_events.
   * actor_user_id` are both nullable for — turning a granted action into a fault
   * would be the regression, not the guardrail.
   */
  it('records a null closer and a null-actor event for an actor that is not a user', async () => {
    const tenant = await tenantWithFiscalYearStart(db, 1);
    const openPeriod = await db.factories.fiscalPeriod({ orgId: tenant.orgId });
    const closedPeriod = await db.factories.fiscalPeriod({
      orgId: tenant.orgId,
      startDate: '2027-01-01',
      endDate: '2027-12-31',
      status: 'closed',
    });

    const automation = contextFor(tenant.orgUuid, OWNER_ROLE_UUID, tenant.userUuid);
    const asAutomation = {
      ...automation,
      userId: null,
      actorType: 'automation' as const,
      actorId: newUuid(),
    };

    await runInContext(asAutomation, () => closePeriod({ periodId: openPeriod.uuid }));
    await runInContext(asAutomation, () => reopenPeriod({ periodId: closedPeriod.uuid }));

    // Both transitions took effect, and both left a sign-off event whose actor is
    // null — the row records that a period changed, with no user behind it.
    expect((await readPeriodRow(db, openPeriod.id)).status).toBe('closed');
    expect((await readPeriodRow(db, closedPeriod.id)).status).toBe('open');
    for (const period of [openPeriod, closedPeriod]) {
      const events = await selectCloseEvents(db, period.id);
      expect(events).toHaveLength(1);
      expect(events[0]?.actor_user_id).toBeNull();
    }
  });
});

describe('reads', () => {
  const db = usePeriodsDatabase();

  it('lists periods in date order and filters by status', async () => {
    const tenant = await tenantWithFiscalYearStart(db, 10);
    await runInContext(tenant.ctx, () => generateFiscalYear({ fiscalYear: 2026 }));

    const all = await runInContext(tenant.ctx, () => listPeriods());
    expect(all).toHaveLength(12);
    expect(all[0]?.startDate).toBe('2026-10-01');
    expect(all.map((period) => period.startDate)).toEqual(
      [...all].map((period) => period.startDate).sort(),
    );

    const first = all[0];
    if (first === undefined) throw new Error('expected a generated period');
    await runInContext(tenant.ctx, () => closePeriod({ periodId: first.id }));

    expect(await runInContext(tenant.ctx, () => listPeriods({ status: 'closed' }))).toHaveLength(1);
    expect(await runInContext(tenant.ctx, () => listPeriods({ status: 'open' }))).toHaveLength(11);
  });

  it('rejects an unrecognised key rather than ignoring it', async () => {
    const tenant = await tenantWithFiscalYearStart(db, 1);

    await expect(
      // A caller who mistypes a filter must not receive an unfiltered list they read
      // as filtered.
      runInContext(tenant.ctx, () => listPeriods({ stat: 'closed' } as never)),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('requires periods.read to list', async () => {
    const tenant = await tenantWithFiscalYearStart(db, 1);
    const ctx = contextFor(tenant.orgUuid, await customRole(tenant.orgUuid, []), tenant.userUuid);

    await expect(runInContext(ctx, () => listPeriods())).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });

  /**
   * A7: "cross-org read returns nothing and does not leak existence". The two answers
   * are compared as serialized wire errors, because that is the only thing a client
   * observes — and `NotFoundError` has no field through which they could differ.
   */
  it('answers a cross-org period read exactly as it answers a nonexistent id', async () => {
    const tenant = await tenantWithFiscalYearStart(db, 1);
    const other = await tenantWithFiscalYearStart(db, 1);
    const foreign = await db.factories.fiscalPeriod({ orgId: other.orgId });

    const crossOrg = await runInContext(tenant.ctx, () =>
      getPeriod({ periodId: foreign.uuid }).then(
        () => undefined,
        (thrown: unknown) => thrown,
      ),
    );
    const nonexistent = await runInContext(tenant.ctx, () =>
      getPeriod({ periodId: newUuid() }).then(
        () => undefined,
        (thrown: unknown) => thrown,
      ),
    );

    expect(crossOrg).toBeInstanceOf(NotFoundError);
    expect(nonexistent).toBeInstanceOf(NotFoundError);
    expect(toWireError(crossOrg)).toEqual(toWireError(nonexistent));
    expect(toWireError(crossOrg).status).toBe(404);
    // The period is still readable by the org that owns it, so the 404 above is
    // about visibility rather than about the row being absent.
    expect((await runInContext(other.ctx, () => getPeriod({ periodId: foreign.uuid }))).id).toBe(
      foreign.uuid,
    );
  });

  it('will not close or reopen another org`s period, with the same 404', async () => {
    const tenant = await tenantWithFiscalYearStart(db, 1);
    const other = await tenantWithFiscalYearStart(db, 1);
    const foreign = await db.factories.fiscalPeriod({ orgId: other.orgId });

    await expect(
      runInContext(tenant.ctx, () => closePeriod({ periodId: foreign.uuid })),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      runInContext(tenant.ctx, () => reopenPeriod({ periodId: foreign.uuid })),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect((await readPeriodRow(db, foreign.id)).status).toBe('open');
  });

  it('rejects a period id that is not a UUID as a validation failure', async () => {
    const tenant = await tenantWithFiscalYearStart(db, 1);

    // Distinct from the 404 above, and not an A7 leak: a malformed id cannot be
    // another org's id, so the two cases it separates are both "no such period".
    await expect(
      runInContext(tenant.ctx, () => getPeriod({ periodId: 'not-a-uuid' })),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

async function countPeriods(db: TestDatabase, tenant: Tenant): Promise<number> {
  const rows = await db.app
    .selectFrom('fiscal_periods')
    .select('id')
    .where('org_id', '=', tenant.orgId)
    .execute();
  return rows.length;
}

async function readPeriodRow(
  db: TestDatabase,
  id: Buffer,
): Promise<{
  status: string;
  closed_at: Date | null;
  closed_by_user_id: Buffer | null;
}> {
  return db.app
    .selectFrom('fiscal_periods')
    .select(['status', 'closed_at', 'closed_by_user_id'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

async function selectCloseEvents(
  db: TestDatabase,
  periodId: Buffer,
): Promise<{ action: string; actor_user_id: Buffer | null }[]> {
  return db.app
    .selectFrom('period_close_events')
    .select(['action', 'actor_user_id'])
    .where('period_id', '=', periodId)
    .orderBy('created_at')
    .execute();
}
