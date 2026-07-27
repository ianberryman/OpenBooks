import type { PostedJournal } from '@openbooks/plugin-api';
import { afterAll, beforeAll } from 'vitest';

import { createRequestContext, runInContext, type RequestContext } from '../../src/context';
import { destroyDatabase, initializeDatabase, isDatabaseInitialized } from '../../src/db';
import { createAccount } from '../../src/modules/accounts';
import { createContact } from '../../src/modules/contacts';
import {
  createDimension,
  createDimensionValue,
  setJournalLineDimensions,
} from '../../src/modules/dimensions';
import { postJournal } from '../../src/modules/ledger';
import type { AccountBalanceRow, ReportGroup } from '../../src/modules/reports';
import { SYSTEM_ROLE_UUIDS, useTestDatabase, type TestDatabase } from '../db';

/**
 * Fixtures for the OB-041 suites.
 *
 * Everything a report reads here was written by the real services — accounts
 * through `createAccount` so the hierarchy rules apply, journals through
 * `postJournal`, tags through `setJournalLineDimensions`. The factories can build
 * a journal faster and cannot build a *chart*: `AccountInput` has no
 * `parentAccountId`, which is precisely the column B7's subtotals are computed
 * over. Going through the services also means every row a report aggregates is a
 * row the write path would actually produce.
 *
 * `useReportDatabase`, `contextFor` and `withContext` duplicate
 * `test/dimensions/support.ts` and `test/ledger/support.ts`. Copied rather than
 * imported, following the convention those files state: they belong to other
 * tickets, and neither suite should break when the other's helper changes.
 */
export function useReportDatabase(): TestDatabase {
  const db = useTestDatabase();

  beforeAll(() => {
    if (!isDatabaseInitialized()) initializeDatabase(db.appConnectionConfig);
  });

  afterAll(async () => {
    await destroyDatabase();
  });

  return db;
}

export function contextFor(orgUuid: string, roleUuid: string, userUuid: string): RequestContext {
  return createRequestContext({
    orgId: orgUuid,
    roleId: roleUuid,
    userId: userUuid,
    actorType: 'user',
    actorId: userUuid,
  });
}

/**
 * Runs `body` inside the context scope.
 *
 * `postJournal` reads the context ambiently through `assertPostable` (spec §4
 * forbids threading `orgId` as a parameter), so a test that passed a context
 * without entering its scope would exercise a path production never takes.
 */
export function withContext<T>(ctx: RequestContext, body: () => Promise<T>): Promise<T> {
  return runInContext(ctx, body);
}

/** The one open period every fixture posts into. */
export const PERIOD = { startDate: '2026-01-01', endDate: '2026-12-31' } as const;

export interface SceneAccount {
  readonly id: string;
  readonly code: string;
}

export interface Scene {
  readonly ctx: RequestContext;
  readonly orgUuid: string;
  readonly orgId: Buffer;
  readonly userId: Buffer;
}

/** An org with an owner, a member row, and one open year. */
export async function createScene(db: TestDatabase): Promise<Scene> {
  const org = await db.factories.org();
  const user = await db.factories.user();
  await db.factories.orgMember({ orgId: org.id, userId: user.id });
  await db.factories.fiscalPeriod({
    orgId: org.id,
    startDate: PERIOD.startDate,
    endDate: PERIOD.endDate,
  });

  return {
    ctx: contextFor(org.uuid, SYSTEM_ROLE_UUIDS.owner, user.uuid),
    orgUuid: org.uuid,
    orgId: org.id,
    userId: user.id,
  };
}

export interface AccountPlan {
  readonly code: string;
  readonly type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  readonly normalBalance: 'debit' | 'credit';
  /** The code of the parent, which must already have been created. */
  readonly parentCode?: string;
}

/**
 * Creates a chart, parents before children, and returns it by code.
 *
 * Sequential because a child's `parentAccountId` is resolved from the map this
 * loop is filling, and because `createAccount` takes a row lock on the parent —
 * concurrent creates under one parent would be a deadlock test rather than a
 * fixture.
 */
export async function createChart(
  scene: Scene,
  plans: readonly AccountPlan[],
): Promise<ReadonlyMap<string, SceneAccount>> {
  const accounts = new Map<string, SceneAccount>();

  for (const plan of plans) {
    const parentId = plan.parentCode === undefined ? null : accounts.get(plan.parentCode)?.id;
    if (plan.parentCode !== undefined && (parentId === undefined || parentId === null)) {
      throw new Error(`Chart plan names parent ${plan.parentCode} before creating it.`);
    }

    const account = await createAccount(
      {
        code: plan.code,
        name: `Account ${plan.code}`,
        type: plan.type,
        normalBalance: plan.normalBalance,
        ...(parentId === null ? {} : { parentAccountId: parentId }),
      },
      scene.ctx,
    );

    accounts.set(plan.code, { id: account.id, code: account.code });
  }

  return accounts;
}

export interface LinePlan {
  readonly accountId: string;
  readonly side: 'debit' | 'credit';
  readonly amount: bigint;
  readonly contactId?: string;
  /** Applied after the post, through the dimensions service (D-32). */
  readonly valueIds?: readonly string[];
}

/**
 * Posts one journal and applies any per-line tags.
 *
 * Tagging runs through `setJournalLineDimensions` rather than through the posting
 * input, deliberately: retagging a posted line is the surface D-18 and D-32 put
 * the tag table behind, and a report that aggregates tags written that way is
 * aggregating the rows a user's own retag produces.
 */
export async function post(
  scene: Scene,
  date: string,
  lines: readonly LinePlan[],
): Promise<PostedJournal> {
  const posted = await withContext(scene.ctx, () =>
    postJournal(
      {
        date,
        actorType: 'user',
        actorId: scene.ctx.actorId,
        lines: lines.map((line) => ({
          accountId: line.accountId,
          side: line.side,
          amount: line.amount,
          ...(line.contactId === undefined ? {} : { contactId: line.contactId }),
        })),
      },
      scene.ctx,
    ),
  );

  for (const [index, line] of lines.entries()) {
    const valueIds = line.valueIds ?? [];
    if (valueIds.length === 0) continue;

    const postedLine = posted.lines[index];
    if (postedLine === undefined) throw new Error('Posted journal returned fewer lines than sent.');

    await setJournalLineDimensions(postedLine.lineId, { valueIds: [...valueIds] }, scene.ctx);
  }

  return posted;
}

/** One contact, for the contact filter. */
export async function createParty(scene: Scene, displayName: string): Promise<string> {
  const contact = await createContact({ displayName }, scene.ctx);
  return contact.id;
}

export interface Axis {
  readonly id: string;
  readonly values: ReadonlyMap<string, string>;
}

/** One dimension with the given value codes, returned by code. */
export async function createAxis(
  scene: Scene,
  code: string,
  valueCodes: readonly string[],
): Promise<Axis> {
  const dimension = await createDimension({ code, name: `Axis ${code}` }, scene.ctx);

  const values = new Map<string, string>();
  for (const valueCode of valueCodes) {
    const value = await createDimensionValue(
      dimension.id,
      { code: valueCode, name: `Value ${valueCode}` },
      scene.ctx,
    );
    values.set(valueCode, value.id);
  }

  return { id: dimension.id, values };
}

/** One group's row for one account, by code. Reports are dense, so it is always there. */
export function rowFor(group: ReportGroup, code: string): AccountBalanceRow {
  const row = group.rows.find((candidate) => candidate.code === code);
  if (row === undefined) {
    throw new Error(
      `No row for account ${code}. Every group carries every account, so an absent row is the ` +
        'failure rather than the setup.',
    );
  }
  return row;
}

/** The group for a dimension value id, or the unassigned bucket when `null`. */
export function groupFor(
  groups: readonly ReportGroup[],
  dimensionValueId: string | null,
): ReportGroup {
  const group = groups.find((candidate) =>
    dimensionValueId === null
      ? candidate.key === null
      : candidate.key?.dimensionValueId === dimensionValueId,
  );

  if (group === undefined) throw new Error(`No group for ${dimensionValueId ?? 'unassigned'}.`);
  return group;
}
