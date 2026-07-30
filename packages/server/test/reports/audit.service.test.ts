import type { PermissionKey, PostedJournal } from '@openbooks/plugin-api';
import { beforeEach, describe, expect, it } from 'vitest';

import { runInContext, type RequestContext } from '../../src/context';
import { bufferToUuid, newUuidBuffer, systemDb, uuidToBuffer } from '../../src/db';
import { PermissionDeniedError, ValidationError } from '../../src/errors';
import { postJournal, reverseJournal } from '../../src/modules/ledger';
import type { AuditEntry, AuditReport } from '../../src/modules/reports';
import { getAuditReport } from '../../src/modules/reports';
import { newUuid } from '../db';
import { backdateJournal } from '../db/factories';

import type { Scene, SceneAccount } from './support';
import { contextFor, createChart, createScene, useReportDatabase, withContext } from './support';

/**
 * The audit trail's behaviour, stated as examples (OB-196; D-98).
 *
 * Two sources feed one timeline, and this file is what proves they read back as
 * one: a mix of journals (a manual post, an adjusting entry, a reversal) and
 * period-close events, unified newest first, correctly mapped, and paged the same
 * way the general ledger's own examples are proven (`general-ledger.test.ts`).
 *
 * `created_at` is stamped explicitly for every fixture row — `journals` has no
 * `UPDATE` grant for the application, so this runs through `db.migrator`
 * (`0999_app_grants`'s own reason: immutability is a database-grant fact, not an
 * application discipline, and a test proving order has to control the column the
 * order is over). `period_close_events` is append-only for `openbooks_app` too,
 * but this can stamp it at insert time and never needs `db.migrator` for it.
 */
const db = useReportDatabase();

interface Fixture {
  readonly scene: Scene;
  readonly accounts: ReadonlyMap<string, SceneAccount>;
  readonly periodId: Buffer;
  readonly periodName: string;
}

async function fixture(): Promise<Fixture> {
  const scene = await createScene(db);
  const accounts = await createChart(scene, [
    { code: '1000', type: 'asset', normalBalance: 'debit' },
    { code: '4000', type: 'revenue', normalBalance: 'credit' },
  ]);
  const period = await db.app
    .selectFrom('fiscal_periods')
    .select(['id', 'name'])
    .where('org_id', '=', scene.orgId)
    .executeTakeFirstOrThrow();

  return { scene, accounts, periodId: period.id, periodName: period.name };
}

function accountId(f: Fixture, code: string): string {
  const account = f.accounts.get(code);
  if (account === undefined) throw new Error(`Fixture has no account ${code}.`);
  return account.id;
}

/** Posts a two-line journal with the given provenance, at a caller-chosen instant. */
async function journalAt(
  f: Fixture,
  at: Date,
  opts: {
    readonly actorType: 'user' | 'automation' | 'agent';
    readonly actorId: string;
    readonly source?: string;
  },
): Promise<PostedJournal> {
  const posted = await withContext(f.scene.ctx, () =>
    postJournal(
      {
        date: '2026-03-15',
        actorType: opts.actorType,
        actorId: opts.actorId,
        ...(opts.source === undefined ? {} : { source: opts.source }),
        lines: [
          { accountId: accountId(f, '1000'), side: 'debit', amount: 1_000n },
          { accountId: accountId(f, '4000'), side: 'credit', amount: 1_000n },
        ],
      },
      f.scene.ctx,
    ),
  );

  await backdateJournal(db.migrator, posted.journalId, at);
  return posted;
}

async function reverseAt(f: Fixture, journalId: string, at: Date): Promise<PostedJournal> {
  const reversal = await withContext(f.scene.ctx, () =>
    reverseJournal(
      {
        journalId,
        date: '2026-03-16',
        actorType: 'user',
        actorId: f.scene.ctx.actorId,
      },
      f.scene.ctx,
    ),
  );

  await backdateJournal(db.migrator, reversal.journalId, at);
  return reversal;
}

async function closeEventAt(
  f: Fixture,
  action: 'close' | 'reopen',
  actorUserId: Buffer,
  at: Date,
): Promise<string> {
  const id = newUuidBuffer();
  await db.app
    .insertInto('period_close_events')
    .values({
      id,
      org_id: f.scene.orgId,
      period_id: f.periodId,
      action,
      checklist: null,
      note: null,
      actor_user_id: actorUserId,
      created_at: at,
    })
    .execute();

  return bufferToUuid(id);
}

function audit(
  f: Fixture,
  query: {
    readonly from?: string;
    readonly to?: string;
    readonly actorId?: string;
    readonly limit?: number;
    readonly cursor?: string;
  } = {},
): Promise<AuditReport> {
  return withContext(f.scene.ctx, () => getAuditReport({ limit: 50, ...query }, f.scene.ctx));
}

const BASE = Date.UTC(2026, 2, 20, 12, 0, 0);

describe('the audit trail unifies journals and period closes into one timeline (OB-196)', () => {
  let f: Fixture;

  beforeEach(async () => {
    f = await fixture();
  });

  it('is newest first, and maps each source the way D-98 describes', async () => {
    const owner = await db.app
      .selectFrom('users')
      .select('display_name')
      .where('id', '=', f.scene.userId)
      .executeTakeFirstOrThrow();

    const manual = await journalAt(f, new Date(BASE), {
      actorType: 'user',
      actorId: f.scene.ctx.actorId,
    });
    const adjusting = await journalAt(f, new Date(BASE + 1_000), {
      actorType: 'user',
      actorId: f.scene.ctx.actorId,
      source: 'adjusting',
    });
    const toReverse = await journalAt(f, new Date(BASE + 2_000), {
      actorType: 'automation',
      actorId: newUuid(),
    });
    const reversal = await reverseAt(f, toReverse.journalId, new Date(BASE + 3_000));
    const closeId = await closeEventAt(f, 'close', f.scene.userId, new Date(BASE + 4_000));
    const reopenId = await closeEventAt(f, 'reopen', f.scene.userId, new Date(BASE + 5_000));

    const report = await audit(f);

    // Newest first: the reopen (base+5s) leads, the manual post (base+0) trails.
    expect(report.entries.map((entry) => entry.id)).toEqual([
      reopenId,
      closeId,
      reversal.journalId,
      toReverse.journalId,
      adjusting.journalId,
      manual.journalId,
    ]);

    const byId = new Map(report.entries.map((entry): [string, AuditEntry] => [entry.id, entry]));

    expect(byId.get(manual.journalId)).toMatchObject({
      kind: 'journal',
      action: 'posted',
      reference: '1',
      source: 'manual',
      summary: 'Journal #1',
      actor: { type: 'user', name: owner.display_name },
    });

    expect(byId.get(adjusting.journalId)).toMatchObject({
      kind: 'journal',
      action: 'posted',
      source: 'adjusting',
      summary: 'Adjusting entry #2',
    });

    // The original journal's own `reverses_journal_id` is null — it is the fourth
    // posting (the reversal) whose action is 'reversed', not this one. The
    // automation actor is not a user: id and name are both null on the wire, even
    // though `journals.actor_id` holds a real value (auditActorSchema, D-98).
    expect(byId.get(toReverse.journalId)).toMatchObject({
      kind: 'journal',
      action: 'posted',
      reference: '3',
      source: 'manual',
      summary: 'Journal #3',
      actor: { type: 'automation', id: null, name: null },
    });

    expect(byId.get(reversal.journalId)).toMatchObject({
      kind: 'journal',
      action: 'reversed',
      reference: '4',
      source: 'reversal',
      summary: 'Reversal of journal #4',
    });

    expect(byId.get(closeId)).toMatchObject({
      kind: 'period-close',
      action: 'closed',
      reference: f.periodName,
      source: null,
      summary: `Closed ${f.periodName}`,
      actor: { type: 'user', name: owner.display_name },
    });

    expect(byId.get(reopenId)).toMatchObject({
      kind: 'period-close',
      action: 'reopened',
      reference: f.periodName,
      summary: `Reopened ${f.periodName}`,
    });

    expect(report.nextCursor).toBeNull();
  });

  it('pages the merged timeline exactly once', async () => {
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const posted = await journalAt(f, new Date(BASE + index * 1_000), {
        actorType: 'user',
        actorId: f.scene.ctx.actorId,
      });
      ids.push(posted.journalId);
    }
    for (let index = 0; index < 3; index += 1) {
      const eventId = await closeEventAt(
        f,
        index % 2 === 0 ? 'close' : 'reopen',
        f.scene.userId,
        new Date(BASE + (3 + index) * 1_000),
      );
      ids.push(eventId);
    }

    const unpaged = await audit(f);
    expect(unpaged.entries).toHaveLength(6);

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;

    do {
      const page = await audit(f, { limit: 2, ...(cursor === undefined ? {} : { cursor }) });
      seen.push(...page.entries.map((entry) => entry.id));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
      expect(pages).toBeLessThan(10); // guards against an infinite loop on a bug
    } while (cursor !== undefined);

    expect(seen).toEqual(unpaged.entries.map((entry) => entry.id));
  });

  it('bounds the timeline by the event date, and restricts it to one actor', async () => {
    const second = await db.factories.user({ displayName: 'Second Accountant' });
    await db.factories.orgMember({ orgId: f.scene.orgId, userId: second.id });

    const day1 = await journalAt(f, new Date(Date.UTC(2026, 2, 1, 12, 0, 0)), {
      actorType: 'user',
      actorId: f.scene.ctx.actorId,
    });
    const day2ByOwner = await journalAt(f, new Date(Date.UTC(2026, 2, 2, 12, 0, 0)), {
      actorType: 'user',
      actorId: f.scene.ctx.actorId,
    });
    const day2BySecond = await journalAt(f, new Date(Date.UTC(2026, 2, 2, 13, 0, 0)), {
      actorType: 'user',
      actorId: second.uuid,
    });
    const day3 = await journalAt(f, new Date(Date.UTC(2026, 2, 3, 12, 0, 0)), {
      actorType: 'user',
      actorId: f.scene.ctx.actorId,
    });

    const middleDay = await audit(f, { from: '2026-03-02', to: '2026-03-02' });
    expect(new Set(middleDay.entries.map((entry) => entry.id))).toEqual(
      new Set([day2ByOwner.journalId, day2BySecond.journalId]),
    );
    expect(middleDay.entries.some((entry) => entry.id === day1.journalId)).toBe(false);
    expect(middleDay.entries.some((entry) => entry.id === day3.journalId)).toBe(false);

    const bySecond = await audit(f, { actorId: second.uuid });
    expect(bySecond.entries.map((entry) => entry.id)).toEqual([day2BySecond.journalId]);
    expect(bySecond.entries[0]?.actor.name).toBe('Second Accountant');
  });

  it('requires audit.read', async () => {
    const roleUuid = await customRole(f.scene.orgUuid, ['reports.read', 'journals.read']);
    const ctx: RequestContext = contextFor(
      f.scene.orgUuid,
      roleUuid,
      f.scene.ctx.userId ?? f.scene.ctx.actorId,
    );

    const error = await runInContext(ctx, () =>
      getAuditReport({ limit: 50 }, ctx).then(
        () => undefined,
        (thrown: unknown) => thrown,
      ),
    );

    expect(error).toBeInstanceOf(PermissionDeniedError);
    expect((error as PermissionDeniedError).details).toEqual({ permission: 'audit.read' });
  });

  it('refuses a cursor that did not come from this report', async () => {
    await expect(audit(f, { cursor: 'not-a-cursor' })).rejects.toBeInstanceOf(ValidationError);
  });

  it('returns an empty page rather than an error when there is no activity yet', async () => {
    const report = await audit(f);
    expect(report.entries).toEqual([]);
    expect(report.nextCursor).toBeNull();
  });
});

async function customRole(orgUuid: string, permissions: readonly PermissionKey[]): Promise<string> {
  const roleUuid = newUuid();
  const roleId = uuidToBuffer(roleUuid);

  await systemDb()
    .insertInto('roles')
    .values({
      id: roleId,
      org_id: uuidToBuffer(orgUuid),
      code: `audit-role-${roleUuid.slice(0, 8)}`,
      name: 'Test role',
      description: 'Created by the OB-196 suite.',
      is_system: 0,
    })
    .execute();

  if (permissions.length > 0) {
    await systemDb()
      .insertInto('role_permissions')
      .values(permissions.map((code) => ({ role_id: roleId, permission_code: code })))
      .execute();
  }

  return roleUuid;
}
