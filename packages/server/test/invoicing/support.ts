import { afterAll, beforeAll } from 'vitest';

import { createRequestContext, runInContext, type RequestContext } from '../../src/context';
import {
  bufferToUuid,
  destroyDatabase,
  initializeDatabase,
  isDatabaseInitialized,
} from '../../src/db';
import type { SystemRoleName, TestDatabase } from '../db';
import { newUuidBuffer, SYSTEM_ROLE_UUIDS, systemRoleId, useTestDatabase } from '../db';

/**
 * Support for the OB-129 (dunning) suites.
 *
 * Deliberately its own copy of `useServiceDatabase`/`contextFor`/`actorIn`
 * rather than an import from `test/invoices/support.ts` — that file's own
 * header states the convention this follows: reaching sideways into another
 * suite's fixtures means this suite breaks when that one is edited.
 * `captureEmail`, by contrast, is imported straight from `test/members/support.ts`
 * in `dunning.test.ts`, matching how `test/enforcement/*` and
 * `test/transport/v1-m2.test.ts` already reach it — it is the one deliberately
 * shared seam (spec §11's "no mocks": a real `log` adapter over a capture
 * stream), not a domain fixture.
 */
export function useServiceDatabase(): TestDatabase {
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

export function withContext<T>(ctx: RequestContext, body: () => Promise<T>): Promise<T> {
  return runInContext(ctx, body);
}

export interface ActorFixture {
  readonly orgUuid: string;
  readonly orgId: Buffer;
  readonly userUuid: string;
  readonly userId: Buffer;
  readonly ctx: RequestContext;
}

export async function actorIn(
  db: TestDatabase,
  role: SystemRoleName = 'owner',
): Promise<ActorFixture> {
  const org = await db.factories.org();
  const user = await db.factories.user();
  await db.factories.orgMember({ orgId: org.id, userId: user.id, roleId: systemRoleId(role) });

  return {
    orgUuid: org.uuid,
    orgId: org.id,
    userUuid: user.uuid,
    userId: user.id,
    ctx: contextFor(org.uuid, SYSTEM_ROLE_UUIDS[role], user.uuid),
  };
}

/**
 * Everything an approved, overdue invoice needs, plus a contact with an email
 * on file — the one addition `test/invoices/support.ts`'s `Scene` does not
 * carry, because sending is not that suite's concern and is this one's.
 */
export interface DunningScene {
  readonly actor: ActorFixture;
  readonly receivable: string;
  readonly income: string;
  readonly contact: string;
  readonly contactId: Buffer;
  readonly contactEmail: string;
  /** A fiscal period wide enough to hold both an issue date and a run date. */
  readonly periodStart: string;
  readonly periodEnd: string;
}

export async function dunningScene(
  db: TestDatabase,
  role: SystemRoleName = 'owner',
): Promise<DunningScene> {
  const actor = await actorIn(db, role);
  const [period, receivable, income] = await Promise.all([
    db.factories.fiscalPeriod({
      orgId: actor.orgId,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    }),
    db.factories.account({
      orgId: actor.orgId,
      name: 'Accounts receivable',
      type: 'asset',
      normalBalance: 'debit',
    }),
    db.factories.account({ orgId: actor.orgId, type: 'revenue', normalBalance: 'credit' }),
  ]);

  await db.factories.controlAccounts({ orgId: actor.orgId, receivableId: receivable.id });

  const contactEmail = 'customer@example.test';
  const contactId = await contactWithEmailIn(db, actor.orgId, 'Acme Ltd', contactEmail);

  return {
    actor,
    receivable: receivable.uuid,
    income: income.uuid,
    contact: bufferToUuid(contactId),
    contactId,
    contactEmail,
    periodStart: period.startDate,
    periodEnd: period.endDate,
  };
}

/** A contact with an email on file, inserted as the **app** user. */
export async function contactWithEmailIn(
  db: TestDatabase,
  orgId: Buffer,
  name: string,
  email: string,
): Promise<Buffer> {
  const id = newUuidBuffer();
  await db.app
    .insertInto('contacts')
    .values({ id, org_id: orgId, display_name: name, is_customer: 1, email })
    .execute();
  return id;
}
