import { sql } from 'kysely';
import { afterAll, beforeAll } from 'vitest';

import { createRequestContext, runInContext, type RequestContext } from '../../src/context';
import { destroyDatabase, initializeDatabase, isDatabaseInitialized } from '../../src/db';
import { bufferToUuid, newUuidBuffer, SYSTEM_ROLE_UUIDS, systemRoleId } from '../db';
import type { SystemRoleName, TestDatabase } from '../db';
import { useTestDatabase } from '../db';

/**
 * Support for the estimates property suite (OB-178; initiative M, OB-175…176).
 *
 * A deliberate duplicate of `test/purchase-orders/support.ts`'s harness
 * scaffolding, restated AR-side — following the convention both files state:
 * reaching sideways into another suite's fixtures means this suite breaks when
 * that one is edited. Unlike `test/estimates/estimates.service.test.ts`'s own
 * scene (which never approves an invoice), this one also nominates a receivables
 * control account and an open fiscal period, because the numbering-independence
 * property here converts an estimate and then approves the resulting invoice —
 * the one operation in this suite that posts a journal and therefore needs both.
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

/** Everything an estimate needs to exist, approve, convert, and — for the one
 * bill/invoice-numbering test — have its resulting invoice approved too. */
export interface EstimateScene {
  readonly orgUuid: string;
  readonly orgId: Buffer;
  readonly userUuid: string;
  readonly userId: Buffer;
  readonly ctx: RequestContext;
  /** A date inside the open period. */
  readonly date: string;
  readonly customerUuid: string;
  readonly customerId: Buffer;
  /** The income account an estimate line credits, once converted and posted. */
  readonly incomeUuid: string;
  readonly incomeId: Buffer;
  /** The asset account nominated as the receivables control account. */
  readonly receivableUuid: string;
  readonly receivableId: Buffer;
}

let codeSequence = 0;

export async function sceneIn(
  db: TestDatabase,
  role: SystemRoleName = 'owner',
): Promise<EstimateScene> {
  const seq = (codeSequence += 1);
  const org = await db.factories.org();
  const user = await db.factories.user();
  await db.factories.orgMember({ orgId: org.id, userId: user.id, roleId: systemRoleId(role) });
  const period = await db.factories.fiscalPeriod({ orgId: org.id });

  const [income, receivable] = await Promise.all([
    db.factories.account({
      orgId: org.id,
      code: `4${String(seq).padStart(3, '0')}`,
      name: 'Consulting income',
      type: 'revenue',
      normalBalance: 'credit',
    }),
    db.factories.account({
      orgId: org.id,
      code: `11${String(seq).padStart(2, '0')}`,
      name: 'Accounts receivable',
      type: 'asset',
      normalBalance: 'debit',
    }),
  ]);

  await db.factories.controlAccounts({ orgId: org.id, receivableId: receivable.id });

  const customerId = await customerIn(db, org.id, `Acme Customer ${String(seq)}`);

  return {
    orgUuid: org.uuid,
    orgId: org.id,
    userUuid: user.uuid,
    userId: user.id,
    ctx: contextFor(org.uuid, SYSTEM_ROLE_UUIDS[role], user.uuid),
    date: period.startDate,
    customerUuid: bufferToUuid(customerId),
    customerId,
    incomeUuid: income.uuid,
    incomeId: income.id,
    receivableUuid: receivable.uuid,
    receivableId: receivable.id,
  };
}

export async function customerIn(db: TestDatabase, orgId: Buffer, name: string): Promise<Buffer> {
  const id = newUuidBuffer();
  await db.app
    .insertInto('contacts')
    .values({
      id,
      org_id: orgId,
      display_name: name,
      is_customer: 1,
      is_active: 1,
    })
    .execute();
  return id;
}

/** How many journals this org has posted — an estimate never moves this (D-M3). */
export async function journalCount(db: TestDatabase, orgId: Buffer): Promise<number> {
  const row = await sql<{ count: number }>`
    SELECT COUNT(*) AS count FROM journals WHERE org_id = ${orgId}
  `.execute(db.app);

  return Number(row.rows[0]?.count ?? 0);
}
