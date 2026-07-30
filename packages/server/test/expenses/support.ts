import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll } from 'vitest';

import { createRequestContext, runInContext, type RequestContext } from '../../src/context';
import { destroyDatabase, initializeDatabase, isDatabaseInitialized } from '../../src/db';
import type { DB } from '../../src/db/generated';
import type { SystemRoleName, TestDatabase } from '../db';
import {
  newUuidBuffer,
  SYSTEM_ROLE_UUIDS,
  bufferToUuid,
  systemRoleId,
  useTestDatabase,
} from '../db';

/**
 * Support for the expenses suite (initiative M, OB-177; ROADMAP D-M2).
 *
 * A deliberate duplicate of `test/bills/support.ts` in its harness scaffolding,
 * following the convention that file states: those are another ticket's
 * fixtures, and reaching sideways into another suite's support means this suite
 * breaks when that one is edited. Only what expenses actually needs is here —
 * no race scaffolding, since expenses reuses `approveDocument`'s concurrency
 * proof (`test/bills/approve-race.test.ts`) rather than re-proving it against
 * an employee contact instead of a vendor one.
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

/**
 * A request context for an `(org, role, user)` triple, through
 * `createRequestContext` rather than an object literal — the permission memo is
 * a `WeakMap` keyed on the frozen context object.
 */
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

/** Everything an expense needs to exist, approve, and post. */
export interface ExpenseScene {
  readonly orgUuid: string;
  readonly orgId: Buffer;
  readonly userUuid: string;
  readonly userId: Buffer;
  readonly ctx: RequestContext;
  /** A date inside the open period. */
  readonly date: string;
  /** A contact carrying `is_employee = 1`. */
  readonly employeeUuid: string;
  readonly employeeId: Buffer;
  /** The expense account a line debits. */
  readonly expenseUuid: string;
  readonly expenseId: Buffer;
  /** The liability account nominated as the payables control account (OB-066a). */
  readonly payableUuid: string;
  readonly payableId: Buffer;
}

let codeSequence = 0;

/**
 * An org with an open period, an employee contact, and a nominated payables
 * control account.
 *
 * Inserted as the **app** user, which is the stronger position: a missing
 * grant surfaces here rather than in production.
 */
export async function sceneIn(
  db: TestDatabase,
  role: SystemRoleName = 'owner',
): Promise<ExpenseScene> {
  const seq = (codeSequence += 1);
  const org = await db.factories.org();
  const user = await db.factories.user();
  await db.factories.orgMember({ orgId: org.id, userId: user.id, roleId: systemRoleId(role) });
  const period = await db.factories.fiscalPeriod({ orgId: org.id });

  const [expense, payable] = await Promise.all([
    db.factories.account({
      orgId: org.id,
      code: `6${String(seq).padStart(3, '0')}`,
      name: 'Travel and expenses',
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

  // What makes this the control account is the nomination, not its code (OB-066a).
  await db.factories.controlAccounts({ orgId: org.id, payableId: payable.id });

  const employeeId = await employeeIn(db, org.id, `Employee ${String(seq)}`);

  return {
    orgUuid: org.uuid,
    orgId: org.id,
    userUuid: user.uuid,
    userId: user.id,
    ctx: contextFor(org.uuid, SYSTEM_ROLE_UUIDS[role], user.uuid),
    date: period.startDate,
    employeeUuid: bufferToUuid(employeeId),
    employeeId,
    expenseUuid: expense.uuid,
    expenseId: expense.id,
    payableUuid: payable.uuid,
    payableId: payable.id,
  };
}

/**
 * A second member of the *same* org, holding a different seeded role. Needed
 * for the `expenses.approve` SoD test: two scenes are two orgs, and a
 * cross-org call is a 404 by construction (A7), which would hide the
 * permission answer the test is actually about.
 */
export async function memberOf(
  db: TestDatabase,
  scene: ExpenseScene,
  role: SystemRoleName,
): Promise<RequestContext> {
  const user = await db.factories.user();
  await db.factories.orgMember({
    orgId: scene.orgId,
    userId: user.id,
    roleId: systemRoleId(role),
  });

  return contextFor(scene.orgUuid, SYSTEM_ROLE_UUIDS[role], user.uuid);
}

export async function employeeIn(
  db: TestDatabase,
  orgId: Buffer,
  name: string,
  flags: { readonly isEmployee?: boolean; readonly isActive?: boolean } = {},
): Promise<Buffer> {
  const id = newUuidBuffer();
  await db.app
    .insertInto('contacts')
    .values({
      id,
      org_id: orgId,
      display_name: name,
      is_employee: flags.isEmployee === false ? 0 : 1,
      is_active: flags.isActive === false ? 0 : 1,
    })
    .execute();
  return id;
}

/** A contact that is *not* an employee — a vendor, say, or nothing at all. */
export async function nonEmployeeContactIn(
  db: TestDatabase,
  orgId: Buffer,
  name: string,
): Promise<Buffer> {
  const id = newUuidBuffer();
  await db.app
    .insertInto('contacts')
    .values({ id, org_id: orgId, display_name: name, is_vendor: 1, is_employee: 0 })
    .execute();
  return id;
}

/**
 * The **signed** balance of one account: debits minus credits. See
 * `test/bills/support.ts`'s own copy for why this is signed rather than a
 * count of lines — a journal posted with its sides swapped still balances.
 */
export async function accountBalance(
  db: Kysely<DB>,
  orgId: Buffer,
  accountId: Buffer,
): Promise<bigint> {
  const { rows } = await sql<{ debits: string | null; credits: string | null }>`
    SELECT SUM(debit_minor) AS debits, SUM(credit_minor) AS credits
      FROM journal_lines
     WHERE org_id = ${orgId} AND account_id = ${accountId}
  `.execute(db);

  const row = rows[0];
  return BigInt(row?.debits ?? '0') - BigInt(row?.credits ?? '0');
}
