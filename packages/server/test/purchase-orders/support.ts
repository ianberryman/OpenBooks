import { sql } from 'kysely';
import { afterAll, beforeAll } from 'vitest';

import { createRequestContext, runInContext, type RequestContext } from '../../src/context';
import { destroyDatabase, initializeDatabase, isDatabaseInitialized } from '../../src/db';
import { newUuidBuffer, SYSTEM_ROLE_UUIDS, bufferToUuid, systemRoleId } from '../db';
import type { SystemRoleName, TestDatabase } from '../db';
import { useTestDatabase } from '../db';

/**
 * Support for the purchase-orders suite (initiative M, OB-170…173).
 *
 * A deliberate duplicate of `test/bills/support.ts` in its harness scaffolding,
 * following the convention that file states: those are another ticket's
 * fixtures, and reaching sideways into another suite's support means this suite
 * breaks when that one is edited.
 *
 * `useServiceDatabase` initializes the *process* pool, because
 * `purchase-orders.repository.ts` reaches data through `tenantDb()`
 * (`orgScope`), which reads the module-private client — the same reason
 * `bills/support.ts` needs it and plain `useTestDatabase()` alone does not
 * suffice.
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

/** Everything a purchase order needs to exist, approve, and convert. */
export interface PoScene {
  readonly orgUuid: string;
  readonly orgId: Buffer;
  readonly userUuid: string;
  readonly userId: Buffer;
  readonly ctx: RequestContext;
  /** A date inside the open period. */
  readonly date: string;
  readonly vendorUuid: string;
  readonly vendorId: Buffer;
  /** The expense account a purchase-order line debits, once converted. */
  readonly expenseUuid: string;
  readonly expenseId: Buffer;
  /** The liability account nominated as the payables control account, needed once the resulting bill is approved. */
  readonly payableUuid: string;
  readonly payableId: Buffer;
}

let codeSequence = 0;

/**
 * An org with an open period, a vendor, an expense account and a nominated
 * payables control account — `bills/support.ts`'s `sceneIn`, trimmed of the tax
 * rate this suite's scenarios do not need.
 */
export async function sceneIn(db: TestDatabase, role: SystemRoleName = 'owner'): Promise<PoScene> {
  const seq = (codeSequence += 1);
  const org = await db.factories.org();
  const user = await db.factories.user();
  await db.factories.orgMember({ orgId: org.id, userId: user.id, roleId: systemRoleId(role) });
  const period = await db.factories.fiscalPeriod({ orgId: org.id });

  const [expense, payable] = await Promise.all([
    db.factories.account({
      orgId: org.id,
      code: `6${String(seq).padStart(3, '0')}`,
      name: 'Office supplies',
      type: 'expense',
      normalBalance: 'debit',
    }),
    db.factories.account({
      orgId: org.id,
      code: `20${String(seq).padStart(2, '0')}`,
      name: 'Accounts payable',
      type: 'liability',
      normalBalance: 'credit',
    }),
  ]);

  await db.factories.controlAccounts({ orgId: org.id, payableId: payable.id });

  const vendorId = await vendorIn(db, org.id, `Acme Supplies ${String(seq)}`);

  return {
    orgUuid: org.uuid,
    orgId: org.id,
    userUuid: user.uuid,
    userId: user.id,
    ctx: contextFor(org.uuid, SYSTEM_ROLE_UUIDS[role], user.uuid),
    date: period.startDate,
    vendorUuid: bufferToUuid(vendorId),
    vendorId,
    expenseUuid: expense.uuid,
    expenseId: expense.id,
    payableUuid: payable.uuid,
    payableId: payable.id,
  };
}

export async function vendorIn(db: TestDatabase, orgId: Buffer, name: string): Promise<Buffer> {
  const id = newUuidBuffer();
  await db.app
    .insertInto('contacts')
    .values({
      id,
      org_id: orgId,
      display_name: name,
      is_vendor: 1,
      is_active: 1,
    })
    .execute();
  return id;
}

/**
 * How many journals this org has posted — the trial-balance witness a draft
 * purchase order must not move. A purchase order posts no journal at all
 * (D-M3), so this is asserted at `0` immediately after creation, unlike an AP
 * document's own draft (which is also `0`, for the same reason, until
 * `approveBill` runs).
 */
export async function journalCount(db: TestDatabase, orgId: Buffer): Promise<number> {
  const row = await sql<{ count: number }>`
    SELECT COUNT(*) AS count FROM journals WHERE org_id = ${orgId}
  `.execute(db.app);

  return Number(row.rows[0]?.count ?? 0);
}
