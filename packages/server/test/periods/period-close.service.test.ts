import { describe, expect, it } from 'vitest';

import { runInContext, type RequestContext } from '../../src/context';
import { PermissionDeniedError } from '../../src/errors';
import { closePeriod, computeCloseChecklist, reopenPeriod } from '../../src/modules/periods';
import { newUuid, uuidToBuffer, type TestDatabase } from '../db';
import { contextFor, customRole, OWNER_ROLE_UUID, usePeriodsDatabase } from './support';

/**
 * The period-close workflow's checklist and sign-off event (initiative P, OB-193;
 * ROADMAP D-97).
 *
 * Against the real container, as the app user, through the real service — same
 * discipline as `periods.service.test.ts`, which this file sits beside rather than
 * extends: it drives `computeCloseChecklist` and the `period_close_events` row
 * `closePeriod`/`reopenPeriod` now write, not the M1 lock itself.
 */

interface Scene {
  readonly orgId: Buffer;
  readonly orgUuid: string;
  readonly userId: Buffer;
  readonly userUuid: string;
  readonly ctx: RequestContext;
  readonly periodId: Buffer;
  readonly periodUuid: string;
  readonly bankAccountId: Buffer;
  readonly importId: Buffer;
}

let lineCounter = 0;

/**
 * An org, an Owner member, one open fiscal period (January 2026), and a bank
 * account with a completed import — the minimum a statement line needs a parent
 * for. Built directly as the app user rather than through another ticket's test
 * support, matching `test/banking/clearing-support.ts`'s own reasoning: importing
 * across a module boundary fails this suite whenever that module is mid-edit.
 */
async function sceneIn(db: TestDatabase): Promise<Scene> {
  const org = await db.factories.org();
  const user = await db.factories.user();
  await db.factories.orgMember({ orgId: org.id, userId: user.id, role: 'owner' });

  const period = await db.factories.fiscalPeriod({
    orgId: org.id,
    startDate: '2026-01-01',
    endDate: '2026-01-31',
  });

  const bankLedger = await db.factories.account({
    orgId: org.id,
    code: '1010',
    type: 'asset',
    normalBalance: 'debit',
  });

  const bankAccountId = uuidToBuffer(newUuid());
  await db.app
    .insertInto('bank_accounts')
    .values({
      id: bankAccountId,
      org_id: org.id,
      account_id: bankLedger.id,
      name: 'Current account',
    })
    .execute();

  const importId = uuidToBuffer(newUuid());
  await db.app
    .insertInto('bank_statement_imports')
    .values({
      id: importId,
      org_id: org.id,
      bank_account_id: bankAccountId,
      format: 'csv',
      filename: 'statement.csv',
      file_hash: 'a'.repeat(64),
      status: 'complete',
      lines_read: 0,
      lines_duplicate: 0,
      imported_by_user_id: user.id,
    })
    .execute();

  return {
    orgId: org.id,
    orgUuid: org.uuid,
    userId: user.id,
    userUuid: user.uuid,
    ctx: contextFor(org.uuid, OWNER_ROLE_UUID, user.uuid),
    periodId: period.id,
    periodUuid: period.uuid,
    bankAccountId,
    importId,
  };
}

/** A draft dated `entryDate`, or left undated when `entryDate` is null. */
async function draftIn(db: TestDatabase, scene: Scene, entryDate: string | null): Promise<void> {
  await db.app
    .insertInto('journal_drafts')
    .values({
      id: uuidToBuffer(newUuid()),
      org_id: scene.orgId,
      created_by_user_id: scene.userId,
      entry_date: entryDate,
    })
    .execute();
}

/** A statement line dated `postedDate`. Returns its id so a test can clear it. */
async function lineIn(db: TestDatabase, scene: Scene, postedDate: string): Promise<Buffer> {
  lineCounter += 1;
  const id = uuidToBuffer(newUuid());
  await db.app
    .insertInto('bank_statement_lines')
    .values({
      id,
      org_id: scene.orgId,
      bank_account_id: scene.bankAccountId,
      import_id: scene.importId,
      posted_date: postedDate,
      description: `Line ${String(lineCounter)}`,
      amount_minor: 1000n,
      fingerprint: `f${String(lineCounter).padStart(63, '0')}`,
      occurrence_index: 0,
    })
    .execute();
  return id;
}

/** Marks `lineId` cleared — a `bank_line_clearings` row with no entries, which is all
 * `countUnreconciledBankLinesInRange`'s left-join-and-test-null predicate reads. */
async function clearLine(db: TestDatabase, scene: Scene, lineId: Buffer): Promise<void> {
  await db.app
    .insertInto('bank_line_clearings')
    .values({
      id: uuidToBuffer(newUuid()),
      org_id: scene.orgId,
      statement_line_id: lineId,
      cleared_amount_minor: 1000n,
      difference_amount_minor: 0n,
      created_by_user_id: scene.userId,
    })
    .execute();
}

interface CloseEventRow {
  readonly action: 'close' | 'reopen';
  readonly checklist: unknown;
  readonly note: string | null;
  readonly actor_user_id: Buffer | null;
}

/** Every `period_close_events` row for `scene`'s period, oldest first. */
async function eventsFor(db: TestDatabase, scene: Scene): Promise<readonly CloseEventRow[]> {
  return db.app
    .selectFrom('period_close_events')
    .select(['action', 'checklist', 'note', 'actor_user_id', 'created_at'])
    .where('org_id', '=', scene.orgId)
    .where('period_id', '=', scene.periodId)
    .orderBy('created_at')
    .execute();
}

describe('computeCloseChecklist', () => {
  const db = usePeriodsDatabase();

  it('warns on unposted drafts, unreconciled bank lines, and an open prior period', async () => {
    const scene = await sceneIn(db);
    await db.factories.fiscalPeriod({
      orgId: scene.orgId,
      name: 'December 2025',
      startDate: '2025-12-01',
      endDate: '2025-12-31',
      status: 'open',
    });

    // Counts inside the period: one posted-nowhere draft, one dateless draft that
    // must not count, one uncleared line, one cleared line that must not count.
    await draftIn(db, scene, '2026-01-15');
    await draftIn(db, scene, null);
    await lineIn(db, scene, '2026-01-20');
    const clearedLine = await lineIn(db, scene, '2026-01-05');
    await clearLine(db, scene, clearedLine);

    const checklist = await runInContext(scene.ctx, () =>
      computeCloseChecklist({ periodId: scene.periodUuid }),
    );

    expect(checklist.periodId).toBe(scene.periodUuid);
    expect(checklist.checks).toHaveLength(3);

    const byKey = new Map(checklist.checks.map((check) => [check.key, check]));
    expect(byKey.get('unposted_drafts')).toMatchObject({ status: 'warn', count: 1 });
    expect(byKey.get('unreconciled_bank_lines')).toMatchObject({ status: 'warn', count: 1 });
    expect(byKey.get('prior_period_open')).toMatchObject({ status: 'warn' });
    // A yes/no check: no `count`, unlike the two above.
    expect(byKey.get('prior_period_open')?.count).toBeUndefined();
  });

  it('passes all three checks when nothing is outstanding', async () => {
    const scene = await sceneIn(db);
    await db.factories.fiscalPeriod({
      orgId: scene.orgId,
      name: 'December 2025',
      startDate: '2025-12-01',
      endDate: '2025-12-31',
      status: 'closed',
    });
    const cleared = await lineIn(db, scene, '2026-01-05');
    await clearLine(db, scene, cleared);

    const checklist = await runInContext(scene.ctx, () =>
      computeCloseChecklist({ periodId: scene.periodUuid }),
    );

    for (const check of checklist.checks) {
      expect(check.status).toBe('pass');
    }
  });

  it('passes prior_period_open when there is no prior period at all', async () => {
    const scene = await sceneIn(db);

    const checklist = await runInContext(scene.ctx, () =>
      computeCloseChecklist({ periodId: scene.periodUuid }),
    );

    const prior = checklist.checks.find((check) => check.key === 'prior_period_open');
    expect(prior?.status).toBe('pass');
    expect(prior?.detail).toContain('no prior fiscal period');
  });

  it('requires periods.read', async () => {
    const scene = await sceneIn(db);
    const ctx = contextFor(scene.orgUuid, await customRole(scene.orgUuid, []), scene.userUuid);

    await expect(
      runInContext(ctx, () => computeCloseChecklist({ periodId: scene.periodUuid })),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

describe('closePeriod / reopenPeriod record a sign-off event', () => {
  const db = usePeriodsDatabase();

  it('closes despite warnings — the checklist is advisory — and records the snapshot and note', async () => {
    const scene = await sceneIn(db);
    await draftIn(db, scene, '2026-01-15');

    const closed = await runInContext(scene.ctx, () =>
      closePeriod({ periodId: scene.periodUuid, note: 'Signing off with one stray draft.' }),
    );
    // Advisory: a real outstanding warning did not stop the close.
    expect(closed.status).toBe('closed');

    const events = await eventsFor(db, scene);
    expect(events).toHaveLength(1);
    const event = events[0];
    if (event === undefined) throw new Error('expected a period_close_events row');

    expect(event.action).toBe('close');
    expect(event.note).toBe('Signing off with one stray draft.');
    expect(event.actor_user_id).toEqual(scene.userId);

    // mysql2 parses a JSON column back into a value, not a string this test must
    // re-parse (`processor-events.repository.ts`'s own callers rely on the same).
    const checks = event.checklist as { key: string; status: string }[];
    expect(checks.find((check) => check.key === 'unposted_drafts')?.status).toBe('warn');
  });

  it('records no note when the caller gives none', async () => {
    const scene = await sceneIn(db);

    await runInContext(scene.ctx, () => closePeriod({ periodId: scene.periodUuid }));

    const events = await eventsFor(db, scene);
    expect(events[0]?.note).toBeNull();
  });

  it('reopen writes a second event with a null checklist', async () => {
    const scene = await sceneIn(db);
    await runInContext(scene.ctx, () => closePeriod({ periodId: scene.periodUuid }));

    const reopened = await runInContext(scene.ctx, () =>
      reopenPeriod({ periodId: scene.periodUuid, note: 'Restating January.' }),
    );
    expect(reopened.status).toBe('open');

    const events = await eventsFor(db, scene);
    expect(events).toHaveLength(2);
    const reopenEvent = events[1];
    if (reopenEvent === undefined) throw new Error('expected a reopen event');

    expect(reopenEvent.action).toBe('reopen');
    expect(reopenEvent.checklist).toBeNull();
    expect(reopenEvent.note).toBe('Restating January.');
    expect(reopenEvent.actor_user_id).toEqual(scene.userId);
  });

  it('gates close and reopen as separate permissions, matching periods.close/periods.reopen', async () => {
    const scene = await sceneIn(db);
    const closerOnly = contextFor(
      scene.orgUuid,
      await customRole(scene.orgUuid, ['periods.read', 'periods.close']),
      scene.userUuid,
    );

    await expect(
      runInContext(closerOnly, () => reopenPeriod({ periodId: scene.periodUuid })),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    const closed = await runInContext(closerOnly, () =>
      closePeriod({ periodId: scene.periodUuid }),
    );
    expect(closed.status).toBe('closed');
    expect(await eventsFor(db, scene)).toHaveLength(1);
  });
});
